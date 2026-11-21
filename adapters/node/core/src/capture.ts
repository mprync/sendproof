import type { BlockedWrite, CaptureCollection, CaptureLimits, CaptureMode, CaptureSnapshot, CaptureRecorder, Change, DbEntry, Effect, Log, RecordedLog, SqlEntry, Timing } from './types.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import { looksSecret, redacted, redactDeep } from './secrets.js';

const current = new AsyncLocalStorage<Capture>();
const defaults = { changes: 200, effects: 100, logs: 500, bytes: 1024 * 1024, valueBytes: 8192 };
/** Longest captured text value, and longest captured name (parameter, property, category, type). */
const textLimit = 4096;
const nameLimit = 256;
/** Most SQL parameters and log properties kept for one entry. */
const parameterLimit = 64;
const propertyLimit = 32;
const clip = (value: unknown, limit = textLimit) => String(value).slice(0, limit);

/** Bound a structured log's optional fields before it is serialized. */
function boundedLog({ category, eventId, properties, exception }: Log): Partial<Log> {
  const bounded: Partial<Log> = {};
  if (category !== undefined) bounded.category = clip(category, nameLimit);
  if (eventId !== undefined) bounded.eventId = { id: Number(eventId.id), ...(eventId.name === undefined ? {} : { name: clip(eventId.name, nameLimit) }) };
  if (exception !== undefined) bounded.exception = { type: clip(exception.type, nameLimit), message: clip(exception.message) };
  if (properties !== undefined && properties !== null && typeof properties === 'object') {
    const kept: Record<string, string> = {};
    let count = 0;
    for (const name in properties) {
      if (!Object.hasOwn(properties, name) || name === '{OriginalFormat}') continue;
      if (count++ >= propertyLimit) break;
      kept[clip(name, nameLimit)] = clip(properties[name]);
    }
    bounded.properties = kept;
  }
  return bounded;
}

/** Capture methods are request-scoped, including across awaited I/O. */
export function currentCapture(): CaptureRecorder | undefined {
  const capture = current.getStore();
  return capture?.active ? capture : undefined;
}

/**
 * The Preview this code runs inside, even after the Preview finished. Store hooks use it so a
 * write that a handler sends after its response settled is still refused, never sent unguarded.
 */
export function currentPreview(): CaptureRecorder | undefined {
  const capture = current.getStore();
  return capture?.mode === 'preview' ? capture : undefined;
}

/**
 * Request attribution: set for the whole of every HTTP request the process serves (see
 * {@link attributeHttpRequests}) and for work marked {@link detached}. A capture's own context
 * attributes too. A store write seen with none of these while a Preview is open may belong to that
 * Preview, having lost its async context, so it fails every open Preview with 500.
 */
const attribution = new AsyncLocalStorage<'request' | 'detached'>();

/** Previews from start to finish, for failing them all when a write can't be attributed. */
const open = new Set<Capture>();

/**
 * Run background work (a queue consumer, a scheduled job, startup seeding) that writes to a
 * guarded store outside any request. While a Preview is open, a store write with no request
 * attribution fails every open Preview with 500, because it may be a write of the Preview's that
 * lost its async context; marking the work detached says it isn't.
 *
 * Inside a request, including a Preview, `detached` changes nothing: the request's guard still
 * applies, so a Preview can't use it to let a write through.
 *
 * ```ts
 * setInterval(() => detached(() => redis.incr('heartbeat')), 60_000);
 * ```
 */
export function detached<Result>(work: () => Result): Result {
  return current.getStore() ? work() : attribution.run('detached', work);
}

/** Run `work` as one request's: its store writes are attributed to it. Bindings call it per request. */
export function attributeRequest<Result>(work: () => Result): Result {
  return attribution.run('request', work);
}

/** Whether code running now belongs to a request, a capture or detached work. */
export function attributed(): boolean {
  return current.getStore() !== undefined || attribution.getStore() !== undefined;
}

let httpAttribution = false;

/**
 * Attribute every request a Node HTTP server in this process serves, whatever framework or
 * middleware order handles it: `http.server.request.start` is published synchronously just before
 * the server emits `request`, so entering the attribution there covers the handler and every
 * async continuation it starts.
 */
export function attributeHttpRequests(): void {
  if (httpAttribution) return;
  httpAttribution = true;
  subscribe('http.server.request.start', () => attribution.enterWith('request'));
}

/** Mark a Preview open until {@link closePreview}. */
export function openPreview(capture: Capture): void {
  open.add(capture);
}

export function closePreview(capture: Capture): void {
  open.delete(capture);
}

/** The Previews open right now. */
export function openPreviews(): Capture[] {
  return [...open];
}

export class Capture implements CaptureRecorder {
  readonly mode: CaptureMode;
  active = true;
  readonly parameterValues: boolean;
  #started = performance.now();
  #limits: Required<CaptureLimits>;
  #bytes = 0;
  #timing: Timing = { auth: 0, handler: 0, db: 0, queryCount: 0, serialize: 0 };
  #values: CaptureSnapshot = { changes: [], effects: [], logs: [] };
  #blocked: BlockedWrite | null = null;
  #fault: Error | null = null;

  constructor(mode: CaptureMode, limits: CaptureLimits = {}, parameterValues = false) {
    this.mode = mode;
    this.#limits = { ...defaults, ...limits };
    this.parameterValues = parameterValues;
  }

  run<Result>(callback: () => Result): Result {
    return current.run(this, callback);
  }

  #append<Name extends CaptureCollection>(name: Name, value: CaptureSnapshot[Name][number]): void {
    if (!this.active) return;
    const values = this.#values[name];
    const truncated: `${CaptureCollection}Truncated` = `${name}Truncated`;
    if (values.length >= this.#limits[name]) {
      this.#values[truncated] = true;
      return;
    }
    try {
      const encoded = JSON.stringify(value);
      const bytes = encoded === undefined ? Infinity : Buffer.byteLength(encoded);
      if (encoded !== undefined && bytes <= this.#limits.valueBytes && this.#bytes + bytes <= this.#limits.bytes) {
        values.push(JSON.parse(encoded));
        this.#bytes += bytes;
        return;
      }
    } catch {
      // An unserializable value never changes the host operation.
    }
    this.#values[truncated] = true;
  }

  get blocked(): BlockedWrite | null {
    return this.#blocked;
  }

  get fault(): Error | null {
    return this.#fault;
  }

  /** Keep the first refused write; it decides the Preview's 409, whatever the handler returns. */
  block(value: BlockedWrite) {
    if (this.mode !== 'preview' || this.#blocked) return;
    this.#blocked = { store: clip(value.store, nameLimit), operation: clip(value.operation, nameLimit), detail: clip(value.detail) };
  }

  /** Keep the first fault; it withholds confirmation, whatever the handler returns. */
  refuse(fault: Error) {
    if (this.mode === 'preview') this.#fault ??= fault;
  }

  /**
   * Record a row, document, item or key change. Secret-named fields (for example `password_hash`)
   * never leave the process, at any depth of a nested document.
   */
  change(value: Change) {
    if (!this.active) return;
    this.#append('changes', { ...value, key: redactDeep(value.key), before: redactDeep(value.before), after: redactDeep(value.after) });
  }

  truncate(name: CaptureCollection) {
    if (this.active) this.#values[`${name}Truncated`] = true;
  }

  effect(value: Effect) {
    const { delivered, ...payload } = value;
    this.#append('effects', this.mode === 'preview' || delivered === undefined ? payload : { ...payload, delivered });
  }

  log(value: RecordedLog) {
    if (!this.active) return;
    const { level, message, elapsedMs, sql, db } = value;
    this.#append('logs', {
      level: clip(level, nameLimit), message: clip(message), ...boundedLog(value),
      ...(elapsedMs === undefined ? {} : { elapsedMs }), ...(sql === undefined ? {} : { sql }),
      ...(db === undefined ? {} : { db }),
      offsetMs: performance.now() - this.#started,
    });
  }

  /**
   * Record one data-store command as a `Db` log entry. The message is the OpenTelemetry span name,
   * `{operation} {target}`. Hooks pass sanitized statements only; values never reach this method.
   */
  db({ system, operation, target, namespace, statement, rowsAffected, blocked, error, elapsedMs }: DbEntry) {
    if (!this.active) return;
    if (!blocked) {
      this.#timing.queryCount++;
      this.#timing.db += elapsedMs ?? 0;
    }
    if (statement !== undefined && statement.length > textLimit) this.#values.logsTruncated = true;
    const db: NonNullable<RecordedLog['db']> = { system: clip(system, nameLimit), operation: clip(operation, nameLimit) };
    if (target !== undefined) db.target = clip(target, nameLimit);
    if (namespace !== undefined) db.namespace = clip(namespace, nameLimit);
    if (statement !== undefined) db.statement = clip(statement);
    if (rowsAffected !== undefined && Number.isSafeInteger(rowsAffected) && rowsAffected >= 0) db.rowsAffected = rowsAffected;
    if (blocked) db.blocked = true;
    if (error) db.error = clip(error, nameLimit);
    this.log({
      level: 'Db', message: db.target === undefined ? db.operation : `${db.operation} ${db.target}`, db,
      ...(elapsedMs === undefined ? {} : { elapsedMs: Math.max(0, elapsedMs) }),
    });
  }

  /**
   * Record one statement. Values are shown only when parameter values are enabled, never for a
   * secret-named parameter, and never for any parameter of a statement whose text names a secret
   * (generated placeholders such as `$1` carry no column name to judge).
   */
  sql({ text, parameters = [], rowsAffected, elapsedMs = 0 }: SqlEntry) {
    if (!this.active) return;
    this.#timing.queryCount++;
    this.#timing.db += elapsedMs;
    const statement = String(text);
    if (parameters.length > parameterLimit || statement.length > textLimit) this.#values.logsTruncated = true;
    const hideAll = !this.parameterValues || looksSecret(statement);
    this.log({ level: 'Sql', message: 'Executed SQL', elapsedMs, sql: {
      text: clip(statement),
      parameters: parameters.slice(0, parameterLimit).map(({ name, value, dbType }) => ({
        name: clip(name, nameLimit),
        value: hideAll || looksSecret(String(name)) ? redacted : value == null ? null : clip(value),
        dbType: clip(dbType, nameLimit),
      })),
      ...(rowsAffected === undefined ? {} : { rowsAffected: Number(rowsAffected) }),
    } });
  }

  finish() {
    this.active = false;
    this.#timing.handler = performance.now() - this.#started;
    return { capture: this.#values, timing: this.#timing };
  }
}

/** Suppress a registered external effect in Preview. In Send, record successful delivery. */
export async function deliverEffect<Result>(effect: Effect, deliver: () => Result | Promise<Result>): Promise<Result | undefined> {
  const capture = current.getStore();
  if (capture?.mode === 'preview') {
    capture.effect(effect);
    return;
  }
  const result = await deliver();
  capture?.effect({ ...effect, delivered: true });
  return result;
}
