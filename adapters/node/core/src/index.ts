import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { BenchIdentity, BenchOptions, BenchRequest, DispatchResponse, LookupResponse, Observation, PreviewOperation, Trace, TransportResponse } from './types.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Capture } from './capture.js';
import { hasPreference, localPath, requireLocalPath, requestsRollback, sameOrigin } from './paths.js';

export type * from './types.js';
export { Capture, currentCapture, deliverEffect } from './capture.js';
export { looksSecret, redacted, redactRow } from './secrets.js';
export { controlsTransaction, endsTransaction, isRollback, mayWrite, splitStatements, type AdapterProvider } from './statements.js';

const prefix = '/bench/_preview';
const tracePrefix = '/bench/_api/traces/';
const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const noStore = { 'Cache-Control': 'no-store' };
const privateHeaders = new Set([
  'set-cookie', 'location', 'transfer-encoding', 'connection', 'upgrade', 'trailer',
  'content-length', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
]);

const json = (status: number, value: unknown, headers: TransportResponse['headers'] = {}): TransportResponse => ({
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...noStore, ...headers },
  body: Buffer.from(JSON.stringify(value)),
});
const problem = (status: number, title: string) => json(status, { status, title }, { 'Content-Type': 'application/problem+json' });

function under(value: string, prefix: string) {
  return value === prefix || value.startsWith(prefix + '/');
}

function responseBody(body: Buffer, contentType?: string): unknown {
  if (!body.length) return null;
  const text = body.toString();
  if (/\b(?:application\/json|[\w.-]+\+json)\b/i.test(contentType ?? '')) {
    try { return JSON.parse(text); } catch { return text; }
  }
  if (/^(?:text\/|application\/(?:xml|javascript))/i.test(contentType ?? '')) return text;
  return { encoding: 'base64', data: body.toString('base64') };
}

interface AssetManifest {
  files: Record<string, { contentType: string; sha256: string }>;
}

class TraceStore {
  #entries = new Map<string, { owner: string; expiry: number; value: Trace }>();

  constructor(private readonly ttl: number, private readonly clock: () => number) {}

  #prune(now: number) {
    for (const [id, entry] of this.#entries) {
      if (entry.expiry <= now) this.#entries.delete(id);
    }
  }

  save(id: string, owner: string, value: Trace) {
    const now = this.clock();
    this.#prune(now);
    const owned = [...this.#entries].filter(([, entry]) => entry.owner === owner);
    if (owned.length >= 8) this.#entries.delete(owned[0][0]);
    const oldest = this.#entries.keys().next().value;
    if (this.#entries.size >= 32 && oldest !== undefined) this.#entries.delete(oldest);
    this.#entries.set(id, { owner, expiry: now + this.ttl, value });
  }

  get(id: string, owner: string) {
    this.#prune(this.clock());
    const entry = this.#entries.get(id);
    return entry?.owner === owner ? entry?.value : undefined;
  }
}

/** Trace owner: path base, authentication scheme, token issuer and subject. */
function owner(identity: BenchIdentity | null, basePath = '') {
  if (typeof identity?.subject !== 'string' || !identity.subject) return undefined;
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  return JSON.stringify([basePath, text(identity.scheme), text(identity.issuer), identity.subject]);
}

/**
 * The database label is shown to anyone who can open discovery, so it must be a bare display
 * name: never a connection string, URL, host:port, credentials or file path.
 */
function requireDatabaseLabel(value: unknown): void {
  if (value === null) return;
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\p{Cc}/\\@=;:?#%]/u.test(value)) {
    throw new TypeError('database must be a display name such as "PostgreSQL", not a connection string, URL or path.');
  }
}

function publicIdentity(identity: BenchIdentity | null) {
  if (!identity) return null;
  return { name: typeof identity.name === 'string' ? identity.name : null,
    ...(typeof identity.role === 'string' ? { role: identity.role } : {}) };
}

/** Internal protocol interface used by the framework packages. */
export function createBench<Raw = unknown>(options: BenchOptions<Raw> = {}, operations: () => PreviewOperation[] = () => []) {
  const {
    apiName = 'API', environment = process.env.NODE_ENV ?? 'production', environments = ['development'],
    openApiUrl = '/openapi.json', documents = [], fieldModules = [], database = null, authProviders = [],
    resolveIdentity = () => null, authorize = () => true, discoverAuth, previewProvider,
    maxResponseBytes = 1024 * 1024, captureLimits = {}, traceTtlMs = 300000, traceClock = () => performance.now(),
    includeSqlParameterValues = environment.toLowerCase() === 'development',
    onError = () => {},
  } = options;
  for (const value of [apiName, environment, ...environments]) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('API and environment names must be nonempty strings.');
  }
  requireLocalPath(openApiUrl);
  requireDatabaseLabel(database);
  for (const { url } of [...documents, ...authProviders]) if (url !== null) requireLocalPath(url);
  fieldModules.forEach(requireLocalPath);
  for (const limit of [maxResponseBytes, traceTtlMs, ...Object.values(captureLimits)]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Limits must be positive integers.');
  }
  const enabled = environments.some(value => value.toLowerCase() === environment.toLowerCase());
  const store = new TraceStore(traceTtlMs, traceClock);
  let manifest: AssetManifest | undefined;

  async function lookup(context: BenchRequest<Raw>): Promise<LookupResponse> {
    const { pathname, query = '', basePath = '', method, headers } = context;
    const prefer = headers.prefer;
    const isPreview = under(pathname, prefix);
    if (!isPreview && requestsRollback(prefer)) return problem(400, 'Use the Test Bench preview URL.');
    if (!under(pathname, '/bench')) return null;
    if (!enabled) return problem(404, 'Test Bench is unavailable.');

    const identity = await resolveIdentity(context);
    if (!await authorize(context, identity)) return problem(identity ? 403 : 401, 'Workbench access denied.');
    if (isPreview) {
      if (!hasPreference(prefer, 'tx=rollback')) return problem(400, 'A Test Bench preview requires Prefer: tx=rollback.');
      if (method === 'HEAD') return problem(405, 'A preview requires a response body.');
      if (!sameOrigin(context)) return problem(403, 'Preview is restricted to the application origin.');
      const target = pathname.slice(prefix.length);
      if (!localPath(target) || under(decodeURIComponent(target).toLowerCase(), '/bench')) {
        return problem(400, 'The Test Bench preview target is invalid.');
      }
      if (!previewProvider) return problem(503, 'Preview requires an available provider.');
      return { target: target + query };
    }
    if (method !== 'GET' && method !== 'HEAD') return problem(405, 'Use GET for workbench discovery and assets.');
    if (pathname === '/bench/_api/capabilities') {
      const addBase = (url: string | null) => url === null ? null : basePath + requireLocalPath(url);
      const providers = [...authProviders, ...((await discoverAuth?.(context)) ?? [])];
      return json(200, {
        protocolVersion: 1, apiName, environment, database, identity: publicIdentity(identity),
        openApiUrl: addBase(openApiUrl),
        documents: documents.map(doc => ({ ...doc, url: addBase(doc.url) })),
        fieldModules: fieldModules.map(addBase),
        authProviders: providers.map(({ kind, label, url }) => ({ kind, label, url: addBase(url) })),
        previewOperations: previewProvider ? operations() : [],
        observedSend: Boolean(previewProvider),
      });
    }
    if (pathname.startsWith(tracePrefix)) {
      const traceOwner = owner(identity, basePath);
      if (!traceOwner || !sameOrigin(context)) return problem(404, 'Trace not found.');
      const trace = store.get(pathname.slice(tracePrefix.length), traceOwner);
      return trace ? json(200, trace) : problem(404, 'Trace not found.');
    }
    if (pathname === '/bench') return { status: 302, headers: { ...noStore, Location: basePath + '/bench/' + query }, body: Buffer.alloc(0) };
    const asset = pathname.slice('/bench/'.length) || 'index.html';
    manifest ??= JSON.parse(readFileSync(join(assets, 'manifest.json'), 'utf8')) as AssetManifest;
    const entry = Object.hasOwn(manifest.files, asset) && manifest.files[asset];
    if (!entry) return problem(404, 'Asset not found.');
    const headersOut = {
      'Cache-Control': 'no-cache', 'Content-Type': entry.contentType,
      'X-Content-Type-Options': 'nosniff', ETag: '"' + entry.sha256 + '"',
    };
    const unchanged = headers['if-none-match'] === headersOut.ETag;
    const body = unchanged ? Buffer.alloc(0) : readFileSync(join(assets, asset));
    return { status: unchanged ? 304 : 200, headers: headersOut, body };
  }

  async function preview(context: BenchRequest<Raw>, dispatch: () => Promise<DispatchResponse>): Promise<TransportResponse> {
    if (!enabled) return problem(404, 'Test Bench is unavailable.');
    if (!previewProvider) return problem(503, 'Preview requires an available provider.');
    const capture = new Capture('preview', captureLimits, includeSqlParameterValues);
    try {
      const response = await capture.run(() => previewProvider.preview(dispatch));
      if ('unmatched' in response) return problem(409, 'This operation is unavailable for preview.');
      if (response.status === 401 || response.status === 403) return problem(response.status, 'Preview access denied.');
      if (response.status >= 500) return problem(500, 'The preview operation did not complete safely.');
      if (response.exceeded || response.body.length > maxResponseBytes) {
        return problem(413, 'The preview response exceeds the configured size limit.');
      }
      const headers: Record<string, string> = Object.create(null);
      const connectionTokens = Object.entries(response.headers)
        .filter(([name]) => name.toLowerCase() === 'connection')
        .flatMap(([, value]) => String(value ?? '').toLowerCase().split(',').map(token => token.trim()));
      for (const [name, value] of Object.entries(response.headers).slice(0, 64)) {
        const lower = name.toLowerCase();
        if (value !== undefined && !privateHeaders.has(lower) && !connectionTokens.includes(lower)) headers[lower] = String(value).slice(0, 2048);
      }
      return json(200, {
        status: response.status, headers, body: responseBody(response.body, headers['content-type']),
        ...capture.finish().capture, rolledBack: true,
      }, { 'Preference-Applied': 'tx=rollback' });
    } catch (error) {
      onError(error, context);
      return problem(500, 'The preview could not be completed safely.');
    } finally {
      if (capture.active) capture.finish();
    }
  }

  async function observation(context: BenchRequest<Raw>): Promise<Observation | null> {
    if (!enabled || !previewProvider || context.method === 'HEAD' ||
      !hasPreference(context.headers.prefer, 'trace') || !sameOrigin(context)) return null;
    const identity = await resolveIdentity(context);
    const subject = owner(identity, context.basePath);
    if (!subject || !await authorize(context, identity)) return null;
    const capture = new Capture('send', captureLimits, includeSqlParameterValues);
    return {
      run: callback => capture.run(callback),
      complete(status) {
        if (!capture.active) return undefined;
        const { capture: recorded, timing } = capture.finish();
        if (status === 401 || status === 403 || status >= 500 || status < 200) return undefined;
        // 128 random bits from the CSPRNG, URL-safe.
        const id = randomBytes(16).toString('hex');
        store.save(id, subject, { ...recorded, timing });
        return id;
      },
    };
  }

  return { lookup, preview, observation, maxResponseBytes };
}
