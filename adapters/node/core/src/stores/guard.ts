/**
 * The write guard of spec/data-stores.md: the single decision point every store hook calls before
 * it sends a command, plus the helpers hooks share for logging and redaction.
 *
 * Outside a Preview the guard does nothing, so Send and observed Send are never blocked. In a
 * Preview it records the first refused write on the request's capture and throws
 * {@link PreviewWriteBlockedError}. The capture's mark, not the handler's response, decides the
 * outcome: a handler that catches the error and returns 200 still produces a 409.
 */
import { currentPreview } from '../capture.js';
import type { CommandKind } from './classify.js';

/** Display names used in "Preview unavailable: this operation writes to <Store>". */
export const storeNames: Readonly<Record<string, string>> = Object.freeze({ mongodb: 'MongoDB', redis: 'Redis', dynamodb: 'DynamoDB' });

/** The display name of a store id; unknown ids are shown as given. */
export const storeName = (store: string): string => storeNames[store] ?? store;

/** The reason shown for a write to a guarded store. */
export const writeReason = (store: string): string => `Preview unavailable: this operation writes to ${storeName(store)}`;

/** Thrown to the handler when the guard refuses a write. No byte of the command reached the store. */
export class PreviewWriteBlockedError extends Error {
  /** Store id, such as `redis`. */
  readonly store: string;
  /** The refused command or action name. */
  readonly operation: string;

  constructor(store: string, operation: string, detail: string) {
    super(detail);
    this.name = 'PreviewWriteBlockedError';
    this.store = store;
    this.operation = operation;
  }
}

/**
 * Thrown when a handler tries to end or escape the Preview transaction: a raw SQL `COMMIT`, a
 * MongoDB `commitTransaction`, or a store command sent with a session other than the Preview's.
 * The Preview answers 500 without confirmation even if the handler catches it.
 */
export class PreviewTransactionControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewTransactionControlError';
  }
}

/**
 * Call before sending a store command. Does nothing outside a Preview or for anything but a write.
 * In a Preview it marks the capture blocked (the first block wins), logs a blocked `Db` entry and
 * throws. `detail` replaces the default "writes to <Store>" reason, for example for a MongoDB
 * command that can't run inside a transaction.
 */
export function guard(store: string, operation: string, kind: CommandKind, detail?: string): void {
  if (kind !== 'write') return;
  const capture = currentPreview();
  if (!capture) return;
  const reason = detail ?? writeReason(store);
  capture.block({ store, operation, detail: reason });
  capture.db({ system: store, operation, blocked: true });
  throw new PreviewWriteBlockedError(store, operation, reason);
}

/**
 * Refuse something that would end or escape the Preview transaction. Records the fault on the
 * current Preview, so the Preview fails with 500 even if the handler catches the error, and
 * returns the error for the caller to throw. Outside a Preview it returns `undefined`.
 */
export function refuseInPreview(message: string): PreviewTransactionControlError | undefined {
  const capture = currentPreview();
  if (!capture) return undefined;
  const error = new PreviewTransactionControlError(message);
  capture.refuse(error);
  return error;
}

/** A plain object literal, as opposed to arrays, dates, buffers and BSON values. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Replace every literal in a command document with `"?"`, keeping field names and operators, for
 * the `statement` of a MongoDB `Db` entry (OpenTelemetry `db.query.text`). BSON values, dates and
 * buffers are literals too.
 */
export function sanitizeDocument(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDocument);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, sanitizeDocument(inner)]));
  return '?';
}

/**
 * Validate the optional label a host gives a store for capabilities `dataStores`. Discovery is
 * shown to anyone who can open the workbench, so the label must be a display name such as
 * `catalog`: never a connection string, URL, host:port, user or password.
 */
export function storeLabel(name: unknown): string | undefined {
  if (name === undefined) return undefined;
  if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\p{Cc}/\\@=;:?#%]/u.test(name)) {
    throw new TypeError('A data store name must be a display label such as "catalog", not a connection string, URL or host.');
  }
  return name;
}

/** Normalize host-declared reads ("TreatAsRead") into an exact-match set, after `transform`. */
export function readSet(names: readonly string[] | undefined, transform: (name: string) => string = name => name): ReadonlySet<string> | undefined {
  if (names === undefined) return undefined;
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name || /[*?\s]/.test(name))) {
    throw new TypeError('treatAsRead takes exact command names, without wildcards.');
  }
  return new Set(names.map(transform));
}
