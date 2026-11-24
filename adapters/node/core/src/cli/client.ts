// The Sendproof protocol from outside the browser: discovery, Preview, Send, observed Send traces,
// lookups and development personas, with one cookie jar for the whole session. It follows the same
// rules as the workbench (spec/README.md): same-origin URLs only, no redirects, no retries, and a
// Preview counts only when its envelope confirms the rollback.

import { dereference, isJsonObject, operations, type Json, type JsonObject, type Operation, type Parameter } from './openapi.js';

export interface ClientOptions {
  /** The application's base URL, including any path base: `http://127.0.0.1:5189` or `https://host/tenant`. */
  api: string;
  /** Where the adapter mounts Sendproof under the base URL. Defaults to `/sendproof`. */
  mount?: string;
  /** Extra headers sent on every request, such as `Authorization`. */
  headers?: Record<string, string>;
  /** Cookies to start with, as `name=value` pairs. */
  cookies?: string[];
  fetch?: typeof fetch;
  /** Milliseconds before a request is abandoned. */
  timeoutMs?: number;
}

export interface Capabilities extends JsonObject {}

export interface RequestInput {
  path?: JsonObject;
  query?: JsonObject;
  headers?: Record<string, string>;
  body?: Json;
  contentType?: string;
}

export interface Blocked { store: string; operation: string; detail: string }

export interface Outcome {
  status: number;
  headers: Record<string, string>;
  body: Json;
  durationMs: number;
  serverTiming?: Record<string, number>;
  changes?: Json[];
  effects?: Json[];
  logs?: Json[];
  truncated?: string[];
  rolledBack?: boolean;
  blocked?: Blocked;
  traceId?: string;
  timing?: Json;
  /** Present when the Preview ran inside a session (spec/README.md, "Preview sessions"). */
  session?: { id: string; step: number };
}

export class SendproofError extends Error {}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isSafeMethod = (method: string) => SAFE.has(method.toUpperCase());

/** Whether send_request (or a Send journey run) may commit: never, only when the API reports
 *  Development, or in any environment. */
export type SendPolicy = 'off' | 'development' | 'anywhere';

/** The reason a commit isn’t allowed right now, given the environment the API reports; `undefined`
 *  when it's fine. Doesn't check the method: callers skip this for GET, HEAD and OPTIONS. */
export function sendPolicyProblem(caps: Capabilities, allowSend: SendPolicy): string | undefined {
  if (allowSend === 'development' && caps.environment !== 'Development') {
    return `This API reports the environment “${String(caps.environment ?? 'unknown')}”. Send is allowed only in Development unless the server was started with --allow-send-anywhere.`;
  }
  return undefined;
}

export interface PreviewSession { id: string; idleTimeoutSeconds: number; maxLifetimeSeconds: number }

export class SendproofClient {
  readonly base: URL;
  readonly mount: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly jar = new Map<string, string>();
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private capabilitiesCache?: Capabilities;
  private documentsCache?: { name: string; url: string; document: JsonObject }[];

  constructor(options: ClientOptions) {
    const base = new URL(options.api);
    if (!/^https?:$/.test(base.protocol)) throw new SendproofError('--api must be an http or https URL.');
    base.search = ''; base.hash = '';
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    this.base = base;
    this.mount = '/' + (options.mount ?? '/sendproof').replace(/^\/+|\/+$/g, '');
    this.extraHeaders = { ...options.headers };
    for (const cookie of options.cookies ?? []) this.storeCookie(cookie);
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** An application-relative path (`/api/orders`) as an absolute URL under the base, refusing anything outside it. */
  url(path: string): URL {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\#]/.test(path)) throw new SendproofError(`Not an application path: ${path}`);
    const url = new URL(path.slice(1), this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) throw new SendproofError(`Outside the application: ${path}`);
    return url;
  }

  /** A URL the capabilities gave (already including the path base, per the spec), kept on this origin. */
  hostUrl(path: string): URL {
    if (!path.startsWith('/') || path.startsWith('//')) throw new SendproofError(`Not a same-origin path: ${path}`);
    const url = new URL(path, this.base.origin);
    const prefix = this.base.pathname.replace(/\/$/, '');
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) url.pathname = prefix + url.pathname;
    return url;
  }

  private sendproofUrl(rest: string) { return this.url(`${this.mount}/${rest.replace(/^\/+/, '')}`); }

  async capabilities(refresh = false): Promise<Capabilities> {
    if (this.capabilitiesCache && !refresh) return this.capabilitiesCache;
    const response = await this.request(this.sendproofUrl('_api/capabilities'), { headers: { Accept: 'application/json' } });
    const body = await readJson(response);
    if (!response.ok || !isJsonObject(body)) throw new SendproofError(`Couldn’t read Sendproof capabilities at ${this.sendproofUrl('_api/capabilities')} (HTTP ${response.status}). Is the API running with a Sendproof adapter?`);
    if (body.protocolVersion !== 1) throw new SendproofError(`This API speaks Sendproof protocol ${String(body.protocolVersion)}; this client supports protocol 1.`);
    this.capabilitiesCache = body;
    if (refresh) this.documentsCache = undefined;
    return body;
  }

  /** Every OpenAPI document the capabilities list, fetched once per session (or on refresh). */
  async documents(refresh = false) {
    if (this.documentsCache && !refresh) return this.documentsCache;
    const caps = await this.capabilities(refresh);
    const listed = Array.isArray(caps.documents) && caps.documents.length
      ? caps.documents.filter(isJsonObject).map(d => ({ name: String(d.name ?? caps.apiName ?? 'API'), url: String(d.url) }))
      : [{ name: String(caps.apiName ?? 'API'), url: String(caps.openApiUrl) }];
    const documents = [];
    for (const entry of listed) {
      const response = await this.request(this.hostUrl(entry.url), { headers: { Accept: 'application/json' } });
      const document = await readJson(response);
      if (!response.ok || !isJsonObject(document)) throw new SendproofError(`Couldn’t read the OpenAPI document ${entry.url} (HTTP ${response.status}).`);
      documents.push({ ...entry, document });
    }
    this.documentsCache = documents;
    return documents;
  }

  async operations(): Promise<(Operation & { source: JsonObject })[]> {
    const all = [];
    for (const { name, document } of await this.documents()) {
      for (const op of operations(document, name)) all.push({ ...op, source: document });
    }
    return all;
  }

  async findOperation(id: string) {
    const all = await this.operations();
    const wanted = id.trim();
    const found = all.find(op => op.id === wanted) ?? all.find(op => `${op.method} ${op.path}` === wanted.replace(/\s+/, ' ').replace(/^(\w+)/, m => m.toUpperCase()));
    if (!found) {
      const near = all.filter(op => op.id.toLowerCase().includes(wanted.toLowerCase().split(/[\s.]/).pop() ?? '')).slice(0, 5).map(op => op.id);
      throw new SendproofError(`No operation “${id}”.${near.length ? ` Did you mean ${near.join(', ')}?` : ' Call list_operations to see them.'}`);
    }
    return found;
  }

  /** Whether the adapter offers Preview for an operation, and why not when it doesn't. */
  previewStatus(caps: Capabilities, op: Operation): { previewable: boolean; reason?: string; stores?: string[] } {
    const match = (entry: Json) => isJsonObject(entry) && String(entry.method).toUpperCase() === op.method && entry.path === op.path;
    const marked = Array.isArray(caps.previewUnavailable) ? caps.previewUnavailable.find(match) : undefined;
    if (isJsonObject(marked)) return { previewable: false, reason: String(marked.reason ?? 'Marked preview: false'), stores: Array.isArray(marked.stores) ? marked.stores.map(String) : undefined };
    const listed = Array.isArray(caps.previewOperations) && caps.previewOperations.some(match);
    return listed ? { previewable: true } : { previewable: false, reason: 'The adapter doesn’t offer Preview for this operation (no preview provider covers it, or it isn’t marked for Preview).' };
  }

  /** The request an operation and its inputs describe: method, URL and headers, validated like the workbench. */
  build(op: Operation & { source: JsonObject }, input: RequestInput) {
    let path = op.path;
    const query = new URLSearchParams();
    const headers: Record<string, string> = {};
    const given = { path: input.path ?? {}, query: input.query ?? {}, header: input.headers ?? {} };
    const known = new Set(op.parameters.map(p => `${p.in}:${p.name}`));
    for (const name of Object.keys(given.path)) if (!known.has(`path:${name}`)) throw new SendproofError(`${op.id} has no path parameter “${name}”.`);
    for (const name of Object.keys(given.query)) if (!known.has(`query:${name}`)) throw new SendproofError(`${op.id} has no query parameter “${name}”.`);
    for (const parameter of op.parameters) {
      const source = parameter.in === 'path' ? given.path : parameter.in === 'query' ? given.query : parameter.in === 'header' ? given.header : {};
      const value = (source as JsonObject)[parameter.name];
      if (value === undefined || value === null || value === '') {
        if (parameter.required && parameter.in !== 'header') throw new SendproofError(`${parameter.name} (${parameter.in}) is required by ${op.id}.`);
        continue;
      }
      if (parameter.in === 'path') path = path.replace(`{${parameter.name}}`, () => pathValue(parameter, value));
      else if (parameter.in === 'query') addQuery(query, parameter, value);
      else if (parameter.in === 'cookie') throw new SendproofError(`Cookie parameter ${parameter.name} comes from the session, not the request.`);
    }
    for (const [name, value] of Object.entries(input.headers ?? {})) headers[name] = String(value);
    if (/\{[^}]+\}/.test(path)) throw new SendproofError(`Fill every path parameter of ${op.id}: ${path}`);
    const url = this.url(path);
    url.search = query.toString();
    let body: string | undefined;
    if (input.body !== undefined) {
      const declared = dereference(op.operation.requestBody, op.source);
      const types = isJsonObject(declared) && isJsonObject(declared.content) ? Object.keys(declared.content) : [];
      const type = input.contentType ?? types.find(t => /json/i.test(t)) ?? types[0] ?? 'application/json';
      body = encodeBody(input.body, type);
      headers['Content-Type'] = type;
    }
    return { method: op.method, url, headers, body };
  }

  async preview(op: Operation & { source: JsonObject }, input: RequestInput, { sessionId }: { sessionId?: string } = {}): Promise<Outcome> {
    const built = this.build(op, input);
    const relative = built.url.pathname.slice(this.base.pathname.length - 1);
    const target = this.sendproofUrl(`_preview${relative}`);
    target.search = built.url.search;
    const started = performance.now();
    const headers: Record<string, string> = { ...built.headers, Prefer: 'tx=rollback', Accept: 'application/json' };
    if (sessionId) headers['Sendproof-Session'] = sessionId;
    const response = await this.request(target, { method: built.method, headers, body: built.body });
    const durationMs = Math.round(performance.now() - started);
    const envelope = await readJson(response);
    const serverTiming = parseServerTiming(response.headers.get('server-timing'));
    // The write guard stopped it: a designed outcome, nothing ran to completion and nothing was written.
    if (response.status === 409 && isJsonObject(envelope) && envelope.code === 'preview_unavailable') {
      return { status: 409, headers: {}, body: envelope, durationMs, serverTiming,
        blocked: { store: String(envelope.store ?? ''), operation: String(envelope.operation ?? ''), detail: String(envelope.detail ?? envelope.title ?? 'Preview unavailable') } };
    }
    if (isJsonObject(envelope) && typeof envelope.code === 'string' && envelope.code.startsWith('session_')) {
      throw sessionError(envelope.code, response.status, envelope);
    }
    if (!response.ok || !isJsonObject(envelope) || envelope.rolledBack !== true || !Number.isInteger(envelope.status)) {
      const reason = isJsonObject(envelope) ? String(envelope.detail ?? envelope.title ?? '') : '';
      throw new SendproofError(`The Preview wasn’t confirmed as rolled back (HTTP ${response.status})${reason ? `: ${reason}` : ''}. Treat its effect as unknown.`);
    }
    const truncated = ['logs', 'effects', 'changes'].filter(name => envelope[`${name}Truncated`] === true);
    return {
      status: envelope.status as number,
      headers: isJsonObject(envelope.headers) ? Object.fromEntries(Object.entries(envelope.headers).map(([k, v]) => [k, String(v)])) : {},
      body: envelope.body ?? null,
      durationMs, serverTiming,
      changes: Array.isArray(envelope.changes) ? envelope.changes : [],
      effects: Array.isArray(envelope.effects) ? envelope.effects : [],
      logs: Array.isArray(envelope.logs) ? envelope.logs : [],
      truncated: truncated.length ? truncated : undefined,
      rolledBack: true,
      session: isJsonObject(envelope.session) ? { id: String(envelope.session.id), step: Number(envelope.session.step) } : undefined,
    };
  }

  /** Opens a Preview session (spec/README.md, "Preview sessions"): a series of Previews that
   *  behave like one, so a later step sees an earlier one's uncommitted rows. Sign in, or switch
   *  persona, first: a session belongs to the identity that opened it. */
  async openSession(): Promise<PreviewSession> {
    const response = await this.request(this.sendproofUrl('_api/sessions'), { method: 'POST', headers: { Accept: 'application/json' } });
    const body = await readJson(response);
    if (response.status !== 201 || !isJsonObject(body) || typeof body.id !== 'string') {
      if (isJsonObject(body) && typeof body.code === 'string' && body.code.startsWith('session_')) throw sessionError(body.code, response.status, body);
      // The API's problem title and detail say why (such as another session holding the database).
      const why = isJsonObject(body) ? [body.title, body.detail].filter(t => typeof t === 'string' && t.trim()).join(' ') : '';
      throw new SendproofError(`Couldn’t open a Preview session (HTTP ${response.status})${why ? `: ${why}` : '.'}`);
    }
    return { id: body.id, idleTimeoutSeconds: Number(body.idleTimeoutSeconds ?? 300), maxLifetimeSeconds: Number(body.maxLifetimeSeconds ?? 1800) };
  }

  /** Rolls a session back to the savepoint before `step` (1-based); steps from `step` on are
   *  discarded and the next Preview in the session becomes that step. */
  async rewindSession(id: string, step: number): Promise<void> {
    const response = await this.request(this.sendproofUrl(`_api/sessions/${encodeURIComponent(id)}/rewind`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step }),
    });
    if (response.status === 204) { await response.body?.cancel(); return; }
    const problem = await readJson(response);
    if (isJsonObject(problem) && typeof problem.code === 'string' && problem.code.startsWith('session_')) throw sessionError(problem.code, response.status, problem);
    throw new SendproofError(`Couldn’t rewind the session to step ${step} (HTTP ${response.status})${isJsonObject(problem) && problem.detail ? `: ${String(problem.detail)}` : ''}.`);
  }

  /** Rolls everything in the session back and ends it. Idempotent: an already-gone session is fine. */
  async deleteSession(id: string): Promise<void> {
    const response = await this.request(this.sendproofUrl(`_api/sessions/${encodeURIComponent(id)}`), { method: 'DELETE' });
    await response.body?.cancel();
    if (response.status !== 204 && response.status !== 404) throw new SendproofError(`Couldn’t end the Preview session (HTTP ${response.status}).`);
  }

  async send(op: Operation & { source: JsonObject }, input: RequestInput, { trace = false } = {}): Promise<Outcome> {
    const built = this.build(op, input);
    const headers: Record<string, string> = { ...built.headers, Accept: built.headers.Accept ?? 'application/json, */*' };
    if (trace) headers.Prefer = [headers.Prefer, 'trace'].filter(Boolean).join(', ');
    const started = performance.now();
    const response = await this.request(built.url, { method: built.method, headers, body: built.body });
    const durationMs = Math.round(performance.now() - started);
    const body = await readBody(response);
    const outcome: Outcome = {
      status: response.status,
      headers: Object.fromEntries([...response.headers].filter(([name]) => name !== 'set-cookie')),
      body, durationMs, serverTiming: parseServerTiming(response.headers.get('server-timing')),
    };
    const traceId = response.headers.get('x-sendproof-trace');
    if (trace && traceId) {
      // The Send already happened; a trace that can't be read never changes its outcome.
      Object.assign(outcome, await this.trace(traceId).catch(() => ({ traceId })));
    }
    return outcome;
  }

  async trace(id: string) {
    if (!/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id)) throw new SendproofError('That isn’t a trace ID.');
    const response = await this.request(this.sendproofUrl(`_api/traces/${id}`), { headers: { Accept: 'application/json' } });
    const trace = await readJson(response);
    if (response.status === 404) throw new SendproofError('No such trace: traces expire after a few minutes and belong to the signed-in user who sent the request.');
    if (!response.ok || !isJsonObject(trace)) throw new SendproofError(`Couldn’t read the trace (HTTP ${response.status}).`);
    const truncated = ['logs', 'effects', 'changes'].filter(name => trace[`${name}Truncated`] === true);
    return {
      traceId: id,
      changes: Array.isArray(trace.changes) ? trace.changes : [],
      effects: Array.isArray(trace.effects) ? trace.effects : [],
      logs: Array.isArray(trace.logs) ? trace.logs : [],
      timing: trace.timing ?? undefined,
      truncated: truncated.length ? truncated : undefined,
    };
  }

  /** Values for an `x-lookup` field: real records the signed-in user can see. */
  async lookup(metadata: JsonObject, search?: string) {
    if (Array.isArray(metadata.options)) {
      return metadata.options.map(option => isJsonObject(option) ? { value: option.value ?? null, label: String(option.label ?? option.value ?? '') } : { value: option, label: String(option) });
    }
    if (typeof metadata.url !== 'string') throw new SendproofError('This field’s lookup has no URL or options.');
    const url = metadata.url.startsWith('/') ? this.hostUrl(metadata.url) : this.url('/' + metadata.url);
    if (search && typeof metadata.searchParam === 'string') url.searchParams.set(metadata.searchParam, search);
    const response = await this.request(url, { headers: { Accept: 'application/json' } });
    const data = await readJson(response);
    if (!response.ok) throw new SendproofError(`The lookup at ${url.pathname} answered HTTP ${response.status}.`);
    const list = Array.isArray(data) ? data : isJsonObject(data) ? data[String(metadata.itemsField ?? 'items')] : undefined;
    if (!Array.isArray(list)) throw new SendproofError(`The lookup at ${url.pathname} returned no list.`);
    const field = (item: JsonObject, key: Json | undefined, fallback: string) => item[String(key ?? fallback)];
    return list.filter(isJsonObject).map(item => ({
      value: field(item, metadata.valueField, 'id') ?? null,
      label: String(field(item, metadata.labelField, 'name') ?? field(item, metadata.valueField, 'id') ?? ''),
      ...(field(item, metadata.detailField, 'detail') !== undefined ? { detail: field(item, metadata.detailField, 'detail') } : {}),
    }));
  }

  personasProvider(caps: Capabilities) {
    const providers = Array.isArray(caps.authProviders) ? caps.authProviders.filter(isJsonObject) : [];
    return providers.find(p => String(p.kind).toLowerCase() === 'personas' && typeof p.url === 'string');
  }

  async personas() {
    const caps = await this.capabilities();
    const provider = this.personasProvider(caps);
    if (!provider) throw new SendproofError('This API offers no development personas.');
    const response = await this.request(this.hostUrl(String(provider.url)), { headers: { Accept: 'application/json' } });
    if ([401, 403, 404].includes(response.status)) throw new SendproofError('This API doesn’t offer its personas to this client. Run against a local API, or pass a signed-in session with --cookie or --header.');
    const list = await readJson(response);
    if (!response.ok || !Array.isArray(list)) throw new SendproofError(`Couldn’t list personas (HTTP ${response.status}).`);
    return list.filter(isJsonObject).map(p => ({ email: String(p.email), name: String(p.name ?? p.email), role: p.role === undefined ? undefined : String(p.role) }));
  }

  async switchPersona(email: string) {
    const caps = await this.capabilities();
    const provider = this.personasProvider(caps);
    if (!provider) throw new SendproofError('This API offers no development personas.');
    const url = this.hostUrl(`${String(provider.url).replace(/\/$/, '')}/${encodeURIComponent(email)}`);
    const response = await this.request(url, { method: 'POST' });
    if (!response.ok) {
      const problem = await readJson(response);
      throw new SendproofError(`Couldn’t switch to ${email} (HTTP ${response.status})${isJsonObject(problem) && problem.detail ? `: ${String(problem.detail)}` : ''}.`);
    }
    await response.body?.cancel();
    return this.capabilities(true);
  }

  /** Signs in through a password provider (`kind: cookie`) with `{ email, password }`. */
  async signIn(email: string, password: string) {
    const caps = await this.capabilities();
    const providers = Array.isArray(caps.authProviders) ? caps.authProviders.filter(isJsonObject) : [];
    const provider = providers.find(p => String(p.kind).toLowerCase() === 'cookie' && typeof p.url === 'string');
    if (!provider) throw new SendproofError('This API has no password sign-in for clients. Pass a session with --cookie or --header instead.');
    const response = await this.request(this.hostUrl(String(provider.url)), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email, password }) });
    if (!response.ok) throw new SendproofError(`Sign-in as ${email} failed (HTTP ${response.status}).`);
    await response.body?.cancel();
    return this.capabilities(true);
  }

  /** One HTTP exchange: session cookies in and out, no redirects, a timeout, and clear transport errors. */
  async request(url: URL, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    if (url.origin !== this.base.origin) throw new SendproofError(`Refusing a request to another origin: ${url.origin}`);
    const headers = new Headers({ ...this.extraHeaders, ...init.headers });
    const cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookie) headers.set('Cookie', cookie);
    let response: Response;
    try {
      response = await this.fetcher(url, { method: init.method ?? 'GET', headers, body: init.body, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new SendproofError(`Couldn’t reach ${url.origin} (${cause}). Is the API running?`);
    }
    for (const line of response.headers.getSetCookie?.() ?? []) this.storeCookie(line);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new SendproofError(`${url.pathname} redirected (HTTP ${response.status}) to ${response.headers.get('location') ?? 'another page'}. Sendproof never follows redirects; usually this means the request needs a signed-in session.`);
    }
    return response;
  }

  private storeCookie(line: string) {
    const [pair, ...attributes] = line.split(';');
    const index = pair.indexOf('=');
    if (index <= 0) return;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attributes.some(a => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a)) ||
      attributes.some(a => { const m = /^\s*expires\s*=\s*(.+)$/i.exec(a); return m ? Date.parse(m[1]) < Date.now() : false; });
    if (expired || value === '') this.jar.delete(name); else this.jar.set(name, value);
  }
}

/** A session problem (spec/README.md, "Session errors") as a clear, actionable message. */
function sessionError(code: string, status: number, problem: JsonObject): SendproofError {
  const detail = typeof problem.detail === 'string' ? problem.detail : undefined;
  const messages: Record<string, string> = {
    session_not_found: 'The Preview session is gone: unknown, expired, ended, or it belongs to someone else. End this run and start a new one.',
    session_busy: 'The Preview session is already serving another request: it takes one at a time. Try again.',
    session_failed: 'A store ended the session’s transaction on its own (such as a long-running MongoDB transaction). The session is closed and rolled back; end this run and start a new one.',
    session_limit: 'Too many open Preview sessions (four per caller, sixteen per host). End another run first.',
  };
  return new SendproofError(`${messages[code] ?? `Session error (HTTP ${status}): ${code}.`}${detail ? ` ${detail}` : ''}`);
}

function scalarParts(value: Json): string[] {
  if (Array.isArray(value)) return value.map(v => String(v));
  if (isJsonObject(value)) return Object.entries(value).flatMap(([k, v]) => [k, String(v)]);
  return [String(value)];
}

function pathValue(parameter: Parameter, value: Json) {
  const style = parameter.style ?? 'simple';
  const explode = parameter.explode ?? false;
  const parts = isJsonObject(value) && explode
    ? Object.entries(value).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    : scalarParts(value).map(encodeURIComponent);
  if (style === 'label') return '.' + parts.join(explode ? '.' : ',');
  if (style === 'matrix') {
    if (explode && isJsonObject(value)) return ';' + parts.join(';');
    const prefix = `;${encodeURIComponent(parameter.name)}=`;
    return prefix + parts.join(explode ? prefix : ',');
  }
  return parts.join(',');
}

function addQuery(query: URLSearchParams, parameter: Parameter, value: Json) {
  const style = parameter.style ?? 'form';
  const explode = parameter.explode ?? style === 'form';
  if (isJsonObject(value) && (explode || style === 'deepObject')) {
    for (const [key, item] of Object.entries(value)) query.append(style === 'deepObject' ? `${parameter.name}[${key}]` : key, String(item));
  } else if (Array.isArray(value) && explode) {
    for (const item of value) query.append(parameter.name, String(item));
  } else {
    const separator = ({ spaceDelimited: ' ', pipeDelimited: '|' } as Record<string, string>)[style] ?? ',';
    query.append(parameter.name, scalarParts(value).join(separator));
  }
}

function encodeBody(value: Json, mediaType: string): string {
  const type = mediaType.split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) return JSON.stringify(value);
  if (type === 'application/x-www-form-urlencoded') {
    if (!isJsonObject(value)) throw new SendproofError('A form-encoded body needs named fields.');
    const form = new URLSearchParams();
    for (const [name, field] of Object.entries(value)) {
      for (const item of Array.isArray(field) ? field : [field]) {
        if (item !== null && item !== undefined) form.append(name, typeof item === 'object' ? JSON.stringify(item) : String(item));
      }
    }
    return form.toString();
  }
  if (type === 'multipart/form-data') throw new SendproofError('Multipart bodies (file uploads) aren’t supported from MCP yet. Use the workbench.');
  if (typeof value === 'string') return value;
  throw new SendproofError(`Give a text body for ${mediaType}.`);
}

async function readJson(response: Response): Promise<Json | undefined> {
  const text = await response.text();
  if (!text) return undefined;
  try { return JSON.parse(text) as Json; } catch { return undefined; }
}

async function readBody(response: Response): Promise<Json> {
  const text = await response.text();
  if (!text) return null;
  if (/json/i.test(response.headers.get('content-type') ?? '')) {
    try { return JSON.parse(text) as Json; } catch { /* keep the text */ }
  }
  return text;
}

/** `auth;dur=1.2, db;dur=3;desc="2 queries"` as `{ auth: 1.2, db: 3 }`. */
export function parseServerTiming(header: string | null): Record<string, number> | undefined {
  if (!header) return undefined;
  const out: Record<string, number> = {};
  for (const entry of header.split(',')) {
    const [name, ...params] = entry.trim().split(';');
    const dur = params.map(p => /^\s*dur\s*=\s*([\d.]+)/.exec(p)).find(Boolean);
    if (name && dur) out[name.trim()] = Number(dur[1]);
  }
  return Object.keys(out).length ? out : undefined;
}
