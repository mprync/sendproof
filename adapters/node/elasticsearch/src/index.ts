/**
 * Sendproof write guard for Elasticsearch 8 and OpenSearch 2 (spec/data-stores.md, `guard` mode).
 *
 * `elasticsearchStore(client)` and `opensearchStore(client)` hook a `@elastic/elasticsearch` 8 or
 * `@opensearch-project/opensearch` 2 client in place, at the client's transport: every API method,
 * every helper (`helpers.bulk`, `helpers.scrollSearch` …) and a direct `client.transport.request`
 * sends through it, and it sees the method, path and body before any connection is chosen. Requests
 * are classified by method and endpoint with the shared table (`spec/data-stores/elasticsearch.json`),
 * so a `POST` that searches runs and `_bulk`, `_update_by_query`, `_delete_by_query`, `_reindex` and
 * every `PUT` are refused in a Preview, which then answers 409.
 *
 * `client.child()` returns a hooked client too, with its own transport. A hook is added to the
 * client you pass, before or after it has made requests. On OpenSearch, `client.extend()` methods
 * registered before the hook bind the unhooked transport, so the store is refused at registration
 * when the client already has any; register the store first.
 *
 * Every request except point-in-time, scroll and cursor handles becomes a `Db` log entry whose
 * statement is the request body with every literal replaced by `"?"` (one line per NDJSON line);
 * the path is not logged, because it can hold document ids.
 *
 * Coverage: the hooked client and its children. A second client, or the connection pool used
 * directly, is not covered.
 */
import { classifyElasticsearch, currentCapture, elasticsearchTarget, guard, readSet, sanitizeDocument, storeLabel } from '@sendproof/core';
import type { CaptureRecorder, DataStore, DataStoreDescription } from '@sendproof/core';

/** Options for {@link elasticsearchStore} and {@link opensearchStore}. */
export interface SearchStoreOptions {
  /** Display label for discovery, such as `search`. Never a URL or host name. */
  name?: string;
  /**
   * Endpoint names (as in the table: `search`, `sql.query`, `PUT /{}/_future`) the host states
   * never write. Exact names, no wildcards. A wrongly listed write is not blocked.
   */
  treatAsRead?: string[];
}

/** A hooked Elasticsearch or OpenSearch client, ready for `dataStores`. */
export interface SearchStore<Client, System extends 'elasticsearch' | 'opensearch'> extends DataStore {
  readonly system: System;
  /** The same client, now guarded. */
  readonly client: Client;
}

/** The request a transport is asked to send. */
interface TransportParams {
  method: string;
  path: string;
  body?: unknown;
  bulkBody?: unknown;
  querystring?: unknown;
}

/** The parts of a transport the hook replaces. OpenSearch also takes a callback as the last argument. */
interface Transport {
  request(params: TransportParams, options?: unknown, callback?: unknown): unknown;
}

/** The parts of a client the hook reads and replaces. */
interface SearchClient {
  transport?: Transport;
  child?(...args: unknown[]): SearchClient;
  extend?(name: string, options: object, fn: unknown): void;
  [key: PropertyKey]: unknown;
}

const hooked = Symbol.for('sendproof.search.hooked');
type Callback = (error?: Error | null, result?: unknown) => void;

/** A body as the `Db` entry's statement: every literal replaced by "?", one line per NDJSON line. Streams have none. */
function statementOf(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  const line = (value: unknown) => JSON.stringify(sanitizeDocument(value));
  if (Array.isArray(body)) return body.map(line).join('\n');
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : undefined;
  if (text !== undefined) {
    return text.split('\n').filter(item => item.trim()).map(item => {
      try { return line(JSON.parse(item)); } catch { return '"?"'; }
    }).join('\n');
  }
  return typeof (body as { pipe?: unknown }).pipe === 'function' ? undefined : line(body);
}

/** Documents matched, written or returned, when the reply says so. */
function rowsOf(result: unknown): number | undefined {
  const reply = result as { body?: unknown } | undefined;
  const body = (reply && typeof reply === 'object' && 'body' in reply ? reply.body : result) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return undefined;
  const hits = (body.hits as { hits?: unknown } | undefined)?.hits;
  if (Array.isArray(hits)) return hits.length;
  if (typeof body.updated === 'number') return body.updated;
  if (typeof body.deleted === 'number') return body.deleted;
  return body.result ? 1 : undefined;
}

/** The store's own error type for a failed request, such as `version_conflict_engine_exception`. */
function errorOf(error: unknown): string {
  const failure = error as { body?: { error?: { type?: unknown } }; meta?: { body?: { error?: { type?: unknown } } }; name?: string };
  const type = failure?.meta?.body?.error?.type ?? failure?.body?.error?.type;
  return typeof type === 'string' ? type : failure?.name ?? 'Error';
}

/** Record one finished request on the capture that was current when it was sent. */
function record(capture: CaptureRecorder | undefined, system: string, operation: string, params: TransportParams, started: number, result?: unknown, error?: unknown) {
  if (!capture) return;
  const target = elasticsearchTarget(params.path);
  const statement = statementOf(params.bulkBody ?? params.body);
  const rows = error ? undefined : rowsOf(result);
  capture.db({
    system, operation, ...(target === undefined ? {} : { target }), ...(statement === undefined ? {} : { statement }),
    ...(rows === undefined ? {} : { rowsAffected: rows }), ...(error ? { error: errorOf(error) } : {}),
    elapsedMs: performance.now() - started,
  });
}

/** The extension list of an OpenSearch client, which `client.extend()` appends to. */
const extensionsOf = (client: SearchClient): unknown[] | undefined => {
  const key = Object.getOwnPropertySymbols(client).find(symbol => symbol.description === 'opensearchjs-extensions');
  return key === undefined ? undefined : client[key] as unknown[];
};

/** Hook one client's transport, and the clients `child()` returns from it. */
function hookClient(client: SearchClient, system: 'elasticsearch' | 'opensearch', reads: ReadonlySet<string> | undefined, child = false): void {
  const transport = client.transport;
  if (!transport || typeof transport.request !== 'function') {
    throw new TypeError(`${system === 'opensearch' ? 'opensearchStore' : 'elasticsearchStore'} takes an ${system === 'opensearch' ? 'OpenSearch 2' : 'Elasticsearch 8'} client.`);
  }
  if ((transport as unknown as Record<PropertyKey, unknown>)[hooked]) throw new TypeError('This search client is already hooked by a Sendproof store.');
  // A child gets its parent's extensions before it can be hooked; they are registered again below.
  if (!child && extensionsOf(client)?.length) {
    throw new TypeError('This OpenSearch client already has client.extend() methods, which bind its unhooked transport. Register the store before extending the client.');
  }
  const send = transport.request.bind(transport);
  transport.request = function guardedRequest(params: TransportParams, options?: unknown, callback?: unknown) {
    const { kind, operation } = classifyElasticsearch(params?.method, params?.path, params?.bulkBody ?? params?.body, reads);
    try {
      guard(system, operation, kind);
    } catch (error) {
      // OpenSearch also takes a callback, as the second or third argument.
      const done = [options, callback].find((arg): arg is Callback => typeof arg === 'function');
      if (!done) return Promise.reject(error);
      // The OpenSearch client's own helpers destructure `{ body }` from the second argument even on failure.
      process.nextTick(() => done(error as Error, { body: null, statusCode: null, headers: null, warnings: null, meta: null }));
      return { abort() {} };
    }
    if (kind === 'session') return send(params, options, callback);
    const capture = currentCapture();
    const started = performance.now();
    const finish = (result?: unknown, error?: unknown) => record(capture, system, operation, params, started, result, error);
    const done = [options, callback].find((arg): arg is Callback => typeof arg === 'function');
    if (done) {
      const wrapped: Callback = (error, result) => { finish(result, error ?? undefined); done(error, result); };
      return typeof options === 'function' ? send(params, wrapped) : send(params, options, wrapped);
    }
    const reply = send(params, options) as Promise<unknown> & { abort?: () => void };
    reply.then(result => finish(result), error => finish(undefined, error));
    return reply;
  };
  Object.defineProperty(transport, hooked, { value: true });

  if (typeof client.child === 'function') {
    const child = client.child.bind(client);
    client.child = (...args: unknown[]) => {
      const copy = child(...args);
      hookClient(copy, system, reads, true);
      // OpenSearch re-registers the parent's extensions on the child before it can be hooked, so they bound
      // the child's unhooked transport: register them again now that the transport is guarded.
      for (const entry of [...(extensionsOf(copy) ?? [])] as { name: string; opts?: object; fn: unknown }[]) {
        copy.extend?.(entry.name, { ...entry.opts, force: true }, entry.fn);
      }
      return copy;
    };
  }
}

/** Shared by {@link elasticsearchStore} and {@link opensearchStore}. */
function searchStore<Client extends object, System extends 'elasticsearch' | 'opensearch'>(client: Client, system: System, options: SearchStoreOptions): SearchStore<Client, System> {
  const name = storeLabel(options.name);
  const reads = readSet(options.treatAsRead);
  hookClient(client as unknown as SearchClient, system, reads);
  const description: DataStoreDescription = { system, ...(name === undefined ? {} : { name }), mode: 'guard' };
  return { system, client, describe: async () => ({ ...description }) };
}

/**
 * Hook an Elasticsearch 8 client (`new Client({ node })` from `@elastic/elasticsearch`) in place and
 * return the store for `dataStores`. Hooking the same client twice is refused.
 */
export function elasticsearchStore<Client extends object>(client: Client, options: SearchStoreOptions = {}): SearchStore<Client, 'elasticsearch'> {
  return searchStore(client, 'elasticsearch', options);
}

/**
 * Hook an OpenSearch 2 client (`new Client({ node })` from `@opensearch-project/opensearch`) in place
 * and return the store for `dataStores`. Hooking the same client twice is refused, and so is a client
 * that already has `client.extend()` methods.
 */
export function opensearchStore<Client extends object>(client: Client, options: SearchStoreOptions = {}): SearchStore<Client, 'opensearch'> {
  return searchStore(client, 'opensearch', options);
}
