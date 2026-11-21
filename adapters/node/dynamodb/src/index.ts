/**
 * Sendproof write guard for DynamoDB (spec/data-stores.md, `guard` mode).
 *
 * `dynamoStore(client)` adds one `initialize`-step middleware to an AWS SDK v3 `DynamoDBClient`.
 * The initialize step runs before serialization and signing, so a refused command never becomes
 * an HTTP request, and credentials, the `Authorization` header and signatures never reach the hook.
 * The operation is `context.commandName` without its `Command` suffix.
 *
 * A `DynamoDBDocumentClient` made with `DynamoDBDocumentClient.from(client)` shares the base
 * client's middleware stack, so hooking either one covers both. A client created separately is not
 * covered.
 */
import { classifyDynamo, currentCapture, guard, readSet, storeLabel } from '@sendproof/core';
import type { DataStore, DataStoreDescription } from '@sendproof/core';

/** Options for {@link dynamoStore}. */
export interface DynamoStoreOptions {
  /** Display label for discovery, such as `orders`. Never an endpoint or ARN. */
  name?: string;
  /** Action names the host states never write, matched exactly. A wrongly listed write is not blocked. */
  treatAsRead?: string[];
}

/** A hooked DynamoDB client, ready for `dataStores`. */
export interface DynamoStore<Client> extends DataStore {
  readonly system: 'dynamodb';
  /** The same client, now guarded. */
  readonly client: Client;
}

/** The part of the AWS SDK middleware stack the hook uses. */
interface MiddlewareStack {
  add(middleware: unknown, options: { step: 'initialize'; name: string; priority?: 'high' | 'normal' | 'low'; override?: boolean }): void;
}

/** What the initialize step sees of a command. */
interface InitializeArgs { input?: Record<string, unknown> }
interface HandlerContext { commandName?: string }
type Handler = (args: InitializeArgs) => Promise<{ output?: Record<string, unknown> }>;

const middlewareName = 'sendproofWriteGuard';
const hooked = new WeakSet<object>();

/** The table a command targets: `TableName`, the first `RequestItems` table, or the quoted PartiQL table. */
function targetOf(input: Record<string, unknown>, statement: string | undefined): string | undefined {
  if (typeof input.TableName === 'string') return input.TableName;
  const items = input.RequestItems;
  if (items && typeof items === 'object') return Object.keys(items)[0];
  return statement ? /"([^"]+)"/.exec(statement)?.[1] : undefined;
}

/**
 * Replace every literal in PartiQL text with `?`: single-quoted strings (with `''` escapes) and
 * numbers. Double-quoted identifiers (table and attribute names) are kept as written. A statement
 * may inline values instead of using `?` parameters, and a value never appears in a `Db` entry.
 */
export function sanitizePartiql(text: string): string {
  let out = '';
  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    if (char === '"') {
      const end = text.indexOf('"', index + 1);
      const stop = end < 0 ? text.length : end + 1;
      out += text.slice(index, stop);
      index = stop;
    } else if (char === "'") {
      let end = index + 1;
      while (end < text.length && !(text[end] === "'" && text[end + 1] !== "'")) end += text[end] === "'" ? 2 : 1;
      out += '?';
      index = end + 1;
    } else if (/[0-9]/.test(char) && !/[\w.]/.test(text[index - 1] ?? '')) {
      const number = /^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index))![0];
      out += '?';
      index += number.length;
    } else {
      out += char;
      index++;
    }
  }
  return out;
}

/** The PartiQL text of a request, with literals replaced by `?`; other actions have no statement. */
function statementOf(input: Record<string, unknown>): string | undefined {
  if (typeof input.Statement === 'string') return sanitizePartiql(input.Statement);
  const list = (input.Statements ?? input.TransactStatements) as { Statement?: unknown }[] | undefined;
  return Array.isArray(list) ? list.map(item => sanitizePartiql(String(item?.Statement ?? ''))).join('; ') : undefined;
}

/** Items matched, returned or written, when the reply says so. */
function rowsOf(output: Record<string, unknown> | undefined): number | undefined {
  if (!output) return undefined;
  if (Array.isArray(output.Items)) return output.Items.length;
  if (typeof output.Count === 'number') return output.Count;
  return output.Item || output.Attributes ? 1 : undefined;
}

/**
 * Hook a DynamoDB client (or document client) in place and return the store for `dataStores`.
 * Hooking a stack twice is refused, so its commands are never logged twice.
 */
export function dynamoStore<Client extends { middlewareStack: unknown }>(client: Client, options: DynamoStoreOptions = {}): DynamoStore<Client> {
  const name = storeLabel(options.name);
  const reads = readSet(options.treatAsRead);
  const stack = client?.middlewareStack as MiddlewareStack | undefined;
  if (!stack || typeof stack.add !== 'function') throw new TypeError('dynamoStore takes an AWS SDK v3 DynamoDBClient or DynamoDBDocumentClient.');
  if (hooked.has(stack)) throw new TypeError('This DynamoDB client is already hooked by dynamoStore.');
  stack.add((next: Handler, context: HandlerContext): Handler => async args => {
    const operation = String(context.commandName ?? '').replace(/Command$/, '');
    const input = args.input ?? {};
    guard('dynamodb', operation, classifyDynamo(operation, input, reads));
    const capture = currentCapture();
    const statement = statementOf(input);
    const target = targetOf(input, statement);
    const entry = { system: 'dynamodb', operation, ...(target ? { target } : {}), ...(statement ? { statement } : {}) };
    const started = performance.now();
    try {
      const result = await next(args);
      const rowsAffected = rowsOf(result.output);
      capture?.db({ ...entry, ...(rowsAffected === undefined ? {} : { rowsAffected }), elapsedMs: performance.now() - started });
      return result;
    } catch (error) {
      capture?.db({ ...entry, error: (error as Error)?.name ?? 'Error', elapsedMs: performance.now() - started });
      throw error;
    }
  }, { step: 'initialize', name: middlewareName, priority: 'high' });
  hooked.add(stack);
  const description: DataStoreDescription = { system: 'dynamodb', ...(name === undefined ? {} : { name }), mode: 'guard' };
  return { system: 'dynamodb', client, describe: async () => ({ ...description }) };
}
