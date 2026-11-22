/**
 * Sendproof write guard for Azure Cosmos DB for NoSQL (spec/data-stores.md, `guard` mode).
 *
 * `cosmosStore(client)` hooks an `@azure/cosmos` 4 `CosmosClient` in place with a request plugin
 * (`{ on: 'request' }`), which the SDK runs for every HTTP request it makes, metadata and
 * query-plan reads included, before the request is sent. The plugin sees the SDK's `operationType`
 * and `resourceType` and the request's method, path and headers. A call is a write when either the
 * SDK's operation type or the operation derived from the HTTP request is one, or when the request
 * names a trigger, so a stored procedure, a batch, a bulk operation and anything unknown is
 * refused in a Preview, which then answers 409.
 *
 * `client.database(id).container(id)` and every other derived object share the client's request
 * pipeline, so they stay guarded. The hook adds the plugin to the client's own options, which the
 * SDK reads on every request; the `plugins` option is not in the SDK's public documentation, so
 * the dependency is pinned to the 4.10 line, the store is refused at registration when the client
 * doesn't have the shape it expects, and the recordings test (spec/data-stores/recordings/) fails
 * when an SDK upgrade changes what the plugin sees.
 *
 * A `Db` entry's statement is the query text with any inline literals replaced by `?` (values
 * are `@` parameters, never logged); documents are never logged. The authorization header and the
 * account key are never read.
 *
 * Coverage: the hooked `CosmosClient` and everything derived from it. A second `CosmosClient`
 * is not covered.
 */
import { classifyCosmos, cosmosTarget, currentCapture, guard, readSet, sanitizeStatement, storeLabel } from '@sendproof/core';
import type { DataStore, DataStoreDescription } from '@sendproof/core';

/** Options for {@link cosmosStore}. */
export interface CosmosStoreOptions {
  /** Display label for discovery, such as `orders`. Never an endpoint or account name. */
  name?: string;
  /**
   * Operation types the host states never write, such as a custom read. Exact names (`Read`,
   * `Query`), no wildcards. A wrongly listed write is not blocked.
   */
  treatAsRead?: string[];
}

/** What a request plugin is given: the SDK's own request context. Only these fields are read. */
export interface CosmosRequestContext {
  method: string;
  path?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
  operationType?: string;
  resourceType?: string;
}

/** The request plugin as `@azure/cosmos` calls it. */
export type CosmosPlugin = (context: CosmosRequestContext, diagnostics: unknown, next: (context: CosmosRequestContext) => Promise<unknown>) => Promise<unknown>;

/** A hooked Cosmos DB client, ready for `dataStores`. */
export interface CosmosStore<Client> extends DataStore {
  readonly system: 'cosmosdb';
  /** The same client, now guarded. */
  readonly client: Client;
  /** The request plugin that was added to the client, for tests that replay recorded requests. */
  readonly plugin: CosmosPlugin;
}

/** The part of a CosmosClient's options the hook edits: the SDK reads `plugins` on every request. */
interface ClientOptions { plugins?: { on: string; plugin: CosmosPlugin }[] }

const hooked = Symbol.for('sendproof.cosmosdb.hooked');

/**
 * The query text of a request body, with inline literals replaced by `?`. Documents and parameter
 * values are never read. Cosmos DB SQL quotes strings with `'` or `"` (names are bare or
 * `c["name"]`), so double-quoted text is a literal too, unlike CQL.
 */
function queryText(body: unknown): string | undefined {
  let parsed = body;
  if (typeof body === 'string') {
    try { parsed = JSON.parse(body); } catch { return undefined; }
  }
  const query = (parsed as { query?: unknown } | null | undefined)?.query;
  // Both quote styles take backslash escapes (`'it\'s'`), which the CQL-style sanitizer doesn't know.
  return typeof query === 'string' ? sanitizeStatement(query.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '?')) : undefined;
}

/** The request plugin: classify, guard, then send and log. Exported for tests that call it directly. */
export function cosmosGuardPlugin(reads?: ReadonlySet<string>): CosmosPlugin {
  return async function sendproofGuard(context, _diagnostics, next) {
    const request = { method: String(context.method), path: String(context.path ?? ''), headers: context.headers ?? {} };
    const { kind, operation } = classifyCosmos({ operationType: context.operationType, request }, reads);
    guard('cosmosdb', operation, kind);
    const capture = currentCapture();
    const started = performance.now();
    const { database, container } = cosmosTarget(request.path);
    const statement = queryText(context.body);
    const entry = {
      system: 'cosmosdb', operation, ...(container ? { target: container } : {}), ...(database ? { namespace: database } : {}),
      ...(statement === undefined ? {} : { statement }),
    };
    try {
      const response = await next(context);
      capture?.db({ ...entry, elapsedMs: performance.now() - started });
      return response;
    } catch (error) {
      const code = (error as { code?: unknown; name?: string })?.code;
      capture?.db({ ...entry, error: typeof code === 'number' || typeof code === 'string' ? String(code) : (error as Error)?.name ?? 'Error', elapsedMs: performance.now() - started });
      throw error;
    }
  };
}

/**
 * Hook a `CosmosClient` in place and return the store for `dataStores`, before or after it has
 * made requests. Hooking the same client twice is refused, and so is a client without the
 * options object this SDK line keeps its plugins in.
 */
export function cosmosStore<Client extends object>(client: Client, options: CosmosStoreOptions = {}): CosmosStore<Client> {
  const name = storeLabel(options.name);
  const reads = readSet(options.treatAsRead);
  const settings = (client as { clientContext?: { cosmosClientOptions?: ClientOptions } } | null | undefined)?.clientContext?.cosmosClientOptions;
  if (!settings || typeof settings !== 'object') {
    throw new TypeError('cosmosStore takes an @azure/cosmos 4.10 CosmosClient; this client has no request plugin options to hook.');
  }
  // The plugin option is private SDK API: hook only the line it was proven on. The SDK writes its own
  // version into the client's User-Agent ahead of any application suffix, so the first match is the SDK's.
  const agent = (settings as { defaultHeaders?: Record<string, unknown> }).defaultHeaders?.['User-Agent'];
  const version = /\bazure-cosmos-js\/(\d+)\.(\d+)\./.exec(typeof agent === 'string' ? agent : '');
  if (version?.[1] !== '4' || version[2] !== '10') {
    throw new TypeError(`cosmosStore takes an @azure/cosmos 4.10 CosmosClient; this client reports ${version ? `${version[1]}.${version[2]}` : 'no version'}, and the request plugin it relies on is not proven there.`);
  }
  if ((settings as Record<PropertyKey, unknown>)[hooked]) throw new TypeError('This Cosmos DB client is already hooked by cosmosStore.');
  const plugin = cosmosGuardPlugin(reads);
  // First in line, so no plugin the application added can send a request the guard hasn't seen.
  settings.plugins = [{ on: 'request', plugin }, ...(settings.plugins ?? [])];
  Object.defineProperty(settings, hooked, { value: true });
  const description: DataStoreDescription = { system: 'cosmosdb', ...(name === undefined ? {} : { name }), mode: 'guard' };
  return { system: 'cosmosdb', client, plugin, describe: async () => ({ ...description }) };
}
