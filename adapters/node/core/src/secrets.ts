/**
 * Secret detection shared by every capture path: SQL parameters, SQL statement text and the
 * column names of change snapshots. Names are judged by whole words, so `idempotency_key` and
 * `monkey` stay visible while `password_hash`, `api_key` and `refreshToken` are hidden.
 */

/** The value shown in place of anything judged secret. */
export const redacted = '[REDACTED]';

const secretWords = new Set(['password', 'passwd', 'pwd', 'secret', 'token', 'hash', 'salt', 'credential', 'credentials', 'apikey']);

/** `key` alone is ordinary (primary key, idempotency key); it is secret only after one of these words. */
const keyQualifiers = new Set(['api', 'private', 'secret', 'access', 'signing', 'encryption', 'client']);

/** Split identifiers and SQL text into lower-case words at punctuation, underscores and camel-case boundaries. */
function words(text: string): string[] {
  return text.match(/[\p{Lu}]?[\p{Ll}\p{N}]+|[\p{Lu}\p{N}]+(?![\p{Ll}])/gu)?.map(word => word.toLowerCase()) ?? [];
}

/** Whether an identifier or a statement names a secret, judged by whole words. */
export function looksSecret(text: string): boolean {
  let previous: string | undefined;
  for (const word of words(text)) {
    if (secretWords.has(word) || (word === 'key' && previous !== undefined && keyQualifiers.has(previous))) return true;
    previous = word;
  }
  return false;
}

/** Copy a snapshot row with the value of every secret-named column replaced by {@link redacted}. */
export function redactRow<Row extends Record<string, unknown> | null>(row: Row): Row {
  if (row === null || typeof row !== 'object') return row;
  return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, looksSecret(name) ? redacted : value])) as Row;
}

/** A plain object literal, as opposed to arrays, dates, buffers and BSON values. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Copy a row or document with every secret-named field replaced by {@link redacted} at any depth,
 * through nested objects and arrays. Store documents nest, so `profile.apiKey` is hidden too.
 */
export function redactDeep<Value>(value: Value): Value {
  if (Array.isArray(value)) return value.map(redactDeep) as Value;
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, looksSecret(name) ? redacted : redactDeep(inner)])) as Value;
  }
  return value;
}
