import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { BenchBinding, BenchIdentity, BenchOptions, BenchRequest, BlockedWrite, DispatchResponse, LookupResponse, Observation, PreviewProvider, RegisteredOperation, SessionAccess, Trace, TransportResponse, UnavailableOperation, UnavailableOptions } from './types.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attributeHttpRequests, Capture, closePreview, openPreview } from './capture.js';
import { hasPreference, localPath, requireLocalPath, requestsRollback, sameOrigin } from './paths.js';
import { writeReason } from './stores/guard.js';
import { journeyPrefix, registerJourneys } from './journeys.js';
import { failed, notFound, PreviewSessionEndedError, SessionProblem, Sessions } from './sessions.js';

export type * from './types.js';
export { PreviewSessionEndedError, PreviewStoreBusyError } from './sessions.js';
export { attributeRequest, Capture, currentCapture, currentPreview, deliverEffect, detached } from './capture.js';
export { looksSecret, redacted, redactDeep, redactRow } from './secrets.js';
export { classifyDynamo, classifyMongo, classifyRedis, partiqlVerb, type CommandKind, type MongoClassification } from './stores/classify.js';
export {
  guard, PreviewTransactionControlError, PreviewWriteBlockedError, readSet, refuseInPreview, sanitizeDocument, storeLabel, storeName, storeNames,
  unattributedWrite, writeReason,
} from './stores/guard.js';
export {
  cassandraTarget, classifyCassandra, classifyCassandraMessage, classifyCosmos, classifyElasticsearch, classifyFirestore, cosmosOperation, cosmosTarget,
  elasticsearchTarget, firestoreRpc, namesTrigger, sanitizeStatement, statementShape,
  type Classified, type CosmosRequest, type StatementDialect, type StatementShape,
} from './stores/classify-batch-two.js';
export { cassandraTable, cosmosdbTable, dynamodbTable, elasticsearchTable, firestoreTable, mongodbTable, redisTable } from './stores/tables.js';
export {
  controlsTransaction, endsTransaction, isRollback, mayWrite, previewSavepoint, previewSavepointHeld, rollsBackTransaction, setPreviewSavepoint, refusedStatement, safeProcedureNames,
  splitStatements, type AdapterProvider,
} from './statements.js';

const prefix = '/sendproof/_preview';
const tracePrefix = '/sendproof/_api/traces/';
const sessionsPath = '/sendproof/_api/sessions';
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
const noContent = (): TransportResponse => ({ status: 204, headers: noStore, body: Buffer.alloc(0) });

/**
 * The blocked-Preview response of spec/data-stores.md: 409 problem+json, never a confirmation.
 * It carries nothing the handler produced, and names the command, never its arguments.
 */
const blockedPreview = ({ store, operation, detail }: BlockedWrite) => json(409, {
  type: 'about:blank', title: 'Preview unavailable', status: 409, code: 'preview_unavailable',
  detail, store, operation, rolledBack: false,
}, { 'Content-Type': 'application/problem+json' });

/**
 * Validate the options of an operation marked `preview: false` and build its capabilities entry.
 * The reason defaults to the first store's "writes to <Store>" sentence; one of the two is required.
 */
export function unavailableOperation(method: string, path: string, options: UnavailableOptions): UnavailableOperation {
  const { reason, stores } = options ?? {};
  if (stores !== undefined && (!Array.isArray(stores) || stores.some(store => typeof store !== 'string' || !/^[a-z][a-z0-9]*$/.test(store)))) {
    throw new TypeError('List the stores an unavailable operation writes as store ids such as "redis".');
  }
  const text = reason ?? (stores?.length ? writeReason(stores[0]!) : undefined);
  if (typeof text !== 'string' || !text.trim() || text.length > 512) {
    throw new TypeError('Give an unavailable operation a reason, or the stores it writes.');
  }
  return { method, path, reason: text, ...(stores?.length ? { stores: [...stores] } : {}) };
}

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

/** Capabilities `database`: the label alone, or `{ name, system }` when the SQL provider names itself. */
function databaseOf(label: string | null, provider: { system?: unknown } | undefined): string | null | { name: string | null; system: string } {
  const system = provider?.system;
  return typeof system === 'string' && /^[a-z][a-z0-9]{0,31}$/.test(system) ? { name: label, system } : label;
}

/**
 * Internal protocol interface used by the framework packages. `binding` names the framework for
 * capabilities, so the workbench writes guidance such as the `preview: false` snippet in its idiom.
 */
export function createBench<Raw = unknown>(options: BenchOptions<Raw> = {}, registered: () => RegisteredOperation[] = () => [], binding?: BenchBinding) {
  const {
    apiName = 'API', environment = process.env.NODE_ENV ?? 'production', environments = ['development'],
    openApiUrl = '/openapi.json', documents = [], journeys = [], fieldModules = [], database = null, authProviders = [],
    resolveIdentity = () => null, authorize = () => true, discoverAuth, previewProvider: sqlProvider,
    previewSessions = {},
    maxResponseBytes = 1024 * 1024, captureLimits = {}, traceTtlMs = 300000, traceClock = () => performance.now(),
    includeSqlParameterValues = environment.toLowerCase() === 'development', dataStores = [],
    onError = () => {},
  } = options;
  if (!Array.isArray(dataStores) || dataStores.some(store => typeof store?.system !== 'string' || typeof store.describe !== 'function')) {
    throw new TypeError('dataStores takes stores made by redisStore, dynamoStore, mongoStore, mongooseStore, cassandraStore, elasticsearchStore, opensearchStore, cosmosStore or firestoreStore.');
  }
  // Without a SQL provider, hooked stores alone can carry a Preview: MongoDB rolls back its own
  // transaction in finishPreview and guarded stores block writes, so the dispatch needs no wrapper.
  const previewProvider: PreviewProvider | undefined = sqlProvider ?? (dataStores.length ? { preview: dispatch => dispatch() } : undefined);
  const operations = () => registered().filter(entry => !('preview' in entry)).map(({ method, path }) => ({ method, path }));
  const unavailable = () => registered().flatMap(entry => 'preview' in entry
    ? [{ method: entry.method, path: entry.path, reason: entry.reason, ...(entry.stores ? { stores: entry.stores } : {}) }] : []);
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
  // Store writes are attributed to the request that sent them, so one with no request while a
  // Preview is open can fail that Preview (guard.ts unattributedWrite).
  if (dataStores.length) attributeHttpRequests();
  const store = new TraceStore(traceTtlMs, traceClock);
  const journeyFiles = registerJourneys(journeys);
  const sessions = previewSessions === false ? undefined
    : new Sessions(previewSessions.idleTimeoutSeconds ?? 300, previewSessions.maxLifetimeSeconds ?? 1800);
  const hasSessions = (stores: Awaited<ReturnType<typeof describeStores>>) => Boolean(
    sessions && previewProvider && (!sqlProvider || sqlProvider.openSession)
    && stores.every(({ mode }, index) => mode === 'guard' || dataStores[index].openSession),
  );
  const describeStores = () => Promise.all(dataStores.map(store => store.describe()));
  let manifest: AssetManifest | undefined;

  function sessionError(error: unknown, context: BenchRequest<Raw>) {
    if (error instanceof PreviewSessionEndedError) error = failed();
    if (error instanceof SessionProblem) {
      const { status, code, message: title } = error;
      const idle = sessions?.idleTimeoutSeconds;
      return json(status, {
        type: 'about:blank', status, code, title,
        ...(code === 'store_busy' ? {
          detail: `That session ends by itself after its idle timeout (${idle} seconds), or when it is ended.`,
          idleTimeoutSeconds: idle,
        } : {}),
      }, { 'Content-Type': 'application/problem+json' });
    }
    onError(error, context);
    return problem(500, 'The preview session could not be completed safely.');
  }

  async function sessionRoute(context: BenchRequest<Raw>, subject: string | undefined, readBody?: () => Promise<unknown>) {
    const { pathname, method } = context;
    const resource = pathname.slice(sessionsPath.length).match(/^\/([^/]+)(\/rewind)?$/);
    if (pathname === sessionsPath && method === 'POST') {
      if (!sameOrigin(context)) return problem(403, 'Preview sessions must be opened from the application origin.');
      if (!subject) return problem(403, 'A Preview session needs one stable subject for the signed-in caller.');
      if (!sessions) return problem(409, 'Preview sessions are unavailable.');
      try {
        const stores = await describeStores();
        if (!hasSessions(stores)) return problem(409, 'Preview sessions are unavailable.');
        const guards = dataStores.filter((store, index) => stores[index].mode === 'guard' && store.around);
        const opened = await sessions.open(subject, guards, async add => {
          if (sqlProvider?.openSession) await add(await sqlProvider.openSession());
          for (const [index, dataStore] of dataStores.entries()) {
            if (stores[index].mode === 'preview') await add(await dataStore.openSession!());
          }
        }, error => onError(error, context));
        return json(201, opened);
      } catch (error) {
        if (!(error instanceof SessionProblem)) onError(error, context);
        return sessionError(error instanceof SessionProblem ? error : failed(), context);
      }
    }
    if (!resource) return pathname === sessionsPath ? problem(405, 'Use POST to open a Preview session.') : sessionError(notFound(), context);
    const [, id, rewind] = resource;
    if (!sessions || !sameOrigin(context)) return sessionError(notFound(), context);
    if (method !== (rewind ? 'POST' : 'DELETE')) return problem(405, 'Use POST to rewind or DELETE to end a Preview session.');
    try {
      const session = sessions.enter({ id, owner: subject });
      try {
        if (!rewind) {
          await sessions.close(session);
        } else {
          const input = await readBody?.().catch(() => null);
          const step = input && typeof input === 'object' && 'step' in input ? input.step : undefined;
          if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 1 || step > session.nextStep) {
            return problem(400, 'Choose a step from 1 through the next Preview step.');
          }
          if (step < session.nextStep) {
            for (const part of session.parts.toReversed()) await part.rewind(step);
            session.nextStep = step;
          }
        }
        return noContent();
      } catch (error) {
        await sessions.close(session).catch(error => onError(error, context));
        throw error;
      } finally {
        await sessions.exit(session);
      }
    } catch (error) {
      return sessionError(error, context);
    }
  }

  async function lookup(context: BenchRequest<Raw>, readBody?: () => Promise<unknown>): Promise<LookupResponse> {
    const { pathname, query = '', basePath = '', method, headers } = context;
    const prefer = headers.prefer;
    const isPreview = under(pathname, prefix);
    if (!isPreview && requestsRollback(prefer)) return problem(400, 'Use the Sendproof preview URL.');
    if (!under(pathname, '/sendproof')) return null;
    if (!enabled) return problem(404, 'Sendproof is unavailable.');

    const identity = await resolveIdentity(context);
    if (!await authorize(context, identity)) return problem(identity ? 403 : 401, 'Workbench access denied.');
    const subject = () => identity ? owner(identity, basePath) : JSON.stringify([basePath]);
    if (under(pathname, sessionsPath)) return sessionRoute(context, subject(), readBody);
    if (isPreview) {
      if (!hasPreference(prefer, 'tx=rollback')) return problem(400, 'A Sendproof preview requires Prefer: tx=rollback.');
      if (method === 'HEAD') return problem(405, 'A preview requires a response body.');
      const sessionId = headers['sendproof-session'];
      if (sessionId !== undefined && (!sessions || !sameOrigin(context))) return sessionError(notFound(), context);
      if (!sameOrigin(context)) return problem(403, 'Preview is restricted to the application origin.');
      const target = pathname.slice(prefix.length);
      if (!localPath(target) || under(decodeURIComponent(target).toLowerCase(), '/sendproof')) {
        return problem(400, 'The Sendproof preview target is invalid.');
      }
      if (sessionId !== undefined) return {
        target: target + query,
        session: { id: typeof sessionId === 'string' ? sessionId : '', owner: subject() },
      };
      if (!previewProvider) return problem(503, 'Preview requires an available provider.');
      return { target: target + query };
    }
    if (method !== 'GET' && method !== 'HEAD') return problem(405, 'Use GET for workbench discovery and assets.');
    if (pathname === '/sendproof/_api/capabilities') {
      const addBase = (url: string | null) => url === null ? null : basePath + requireLocalPath(url);
      const providers = [...authProviders, ...((await discoverAuth?.(context)) ?? [])];
      const stores = await describeStores();
      return json(200, {
        protocolVersion: 1, apiName, environment, ...(binding ? { binding: { language: binding.language, framework: binding.framework } } : {}),
        database: databaseOf(database, sqlProvider), identity: publicIdentity(identity),
        openApiUrl: addBase(openApiUrl),
        documents: documents.map(doc => ({ ...doc, url: addBase(doc.url) })),
        fieldModules: fieldModules.map(addBase),
        authProviders: providers.map(({ kind, label, url }) => ({ kind, label, url: addBase(url) })),
        previewOperations: previewProvider ? operations() : [],
        ...(previewProvider && unavailable().length ? { previewUnavailable: unavailable() } : {}),
        ...(dataStores.length ? { dataStores: stores } : {}),
        previewSessions: hasSessions(stores),
        ...(journeys.length ? { journeys: journeyFiles.discover(basePath) } : {}),
        observedSend: Boolean(previewProvider),
      });
    }
    if (pathname.startsWith(tracePrefix)) {
      const traceOwner = owner(identity, basePath);
      if (!traceOwner || !sameOrigin(context)) return problem(404, 'Trace not found.');
      const trace = store.get(pathname.slice(tracePrefix.length), traceOwner);
      return trace ? json(200, trace) : problem(404, 'Trace not found.');
    }
    if (pathname === '/sendproof') return { status: 302, headers: { ...noStore, Location: basePath + '/sendproof/' + query }, body: Buffer.alloc(0) };
    if (pathname.startsWith(journeyPrefix)) {
      const document = journeyFiles.document(pathname, basePath);
      if (document !== undefined) return json(200, document, { 'X-Content-Type-Options': 'nosniff' });
    }
    const asset = pathname.slice('/sendproof/'.length) || 'index.html';
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

  function refusal(capture: Capture, response: TransportResponse): TransportResponse | undefined {
    if (capture.fault) return problem(500, 'The preview could not be completed safely.');
    if (capture.blocked) return blockedPreview(capture.blocked);
    if (response.status === 401 || response.status === 403) return problem(response.status, 'Preview access denied.');
    if (response.status >= 500) return problem(500, 'The preview operation did not complete safely.');
    if (response.exceeded || response.body.length > maxResponseBytes) return problem(413, 'The preview response exceeds the configured size limit.');
  }

  const unmatched = () => problem(409, 'This operation is unavailable for preview.');

  function confirmed(capture: Capture, response: TransportResponse, session?: { id: string; step: number }) {
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
      ...capture.finish().capture, rolledBack: true, ...(session ? { session } : {}),
    }, { 'Preference-Applied': 'tx=rollback' });
  }

  async function sessionPreview(context: BenchRequest<Raw>, access: SessionAccess, dispatch: () => Promise<DispatchResponse>) {
    if (!sessions) return sessionError(notFound(), context);
    try {
      const session = sessions.enter(access);
      const step = session.nextStep;
      const capture = new Capture('preview', captureLimits, includeSqlParameterValues);
      openPreview(capture);
      try {
        for (const part of session.parts) await part.checkpoint(step);
        const guarded = session.guards.reduceRight<() => Promise<DispatchResponse>>(
          (next, store) => () => store.around!(capture, next, 'guard'), dispatch);
        const handler = session.parts.reduceRight<() => Promise<DispatchResponse>>(
          (next, part) => () => part.run(capture, next), guarded);
        let rejected: TransportResponse;
        try {
          const response = await capture.run(handler);
          if ('unmatched' in response) {
            rejected = capture.blocked ? blockedPreview(capture.blocked) : unmatched();
          } else {
            const refused = refusal(capture, response);
            if (!refused) {
              for (const part of session.parts) await part.verify(step);
              const rendered = confirmed(capture, response, { id: session.id, step });
              session.nextStep++;
              return rendered;
            }
            rejected = refused;
          }
        } catch (error) {
          if (error instanceof PreviewSessionEndedError) throw error;
          onError(error, context);
          rejected = capture.blocked && !capture.fault
            ? blockedPreview(capture.blocked) : problem(500, 'The preview could not be completed safely.');
        }
        if (capture.fault) throw capture.fault;
        for (const part of session.parts.toReversed()) await part.rewind(step);
        return rejected;
      } catch (error) {
        await sessions.close(session).catch(error => onError(error, context));
        throw error;
      } finally {
        if (capture.active) capture.finish();
        closePreview(capture);
        await sessions.exit(session);
      }
    } catch (error) {
      return sessionError(error, context);
    }
  }

  async function preview(context: BenchRequest<Raw>, dispatch: () => Promise<DispatchResponse>, session?: SessionAccess): Promise<TransportResponse> {
    if (!enabled) return problem(404, 'Sendproof is unavailable.');
    if (session) return sessionPreview(context, session, dispatch);
    if (!previewProvider) return problem(503, 'Preview requires an available provider.');
    const capture = new Capture('preview', captureLimits, includeSqlParameterValues);
    let storesFinished = true;
    // A handler that throws after a blocked write still gets the 409, once the provider rolled
    // back and rethrew that same error. Any other rejection means the rollback itself failed.
    const failure: { error?: unknown } = {};
    openPreview(capture);
    try {
      // Pipeline order (spec/data-stores.md): run the handler; abort every preview-mode store
      // transaction; roll back SQL. A failed abort or rollback, or a recorded fault, answers 500;
      // otherwise a blocked write answers 409; otherwise the Preview is confirmed.
      const handler = dataStores.reduceRight<() => Promise<DispatchResponse>>(
        (next, store) => store.around ? () => store.around!(capture, next) : next, dispatch);
      const response = await capture.run(() => previewProvider.preview(async () => {
        try {
          return await handler();
        } catch (error) {
          failure.error = error;
          throw error;
        } finally {
          for (const store of dataStores) {
            try {
              await store.finishPreview?.(capture);
            } catch (error) {
              storesFinished = false;
              onError(error, context);
            }
          }
        }
      }));
      if (!storesFinished || capture.fault) return problem(500, 'The preview could not be completed safely.');
      if (capture.blocked) return blockedPreview(capture.blocked);
      if ('unmatched' in response) return unmatched();
      return refusal(capture, response) ?? confirmed(capture, response);
    } catch (error) {
      onError(error, context);
      if ('error' in failure && error === failure.error && storesFinished && !capture.fault && capture.blocked) {
        return blockedPreview(capture.blocked);
      }
      return problem(500, 'The preview could not be completed safely.');
    } finally {
      closePreview(capture);
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

  return { lookup, preview, observation, maxResponseBytes, close: async () => sessions?.shutdown() };
}
