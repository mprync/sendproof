import type { CaptureCollection, CaptureLimits, CaptureMode, CaptureSnapshot, CaptureRecorder, Change, Effect, Log, RecordedLog, SqlEntry, Timing } from './types.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { looksSecret, redacted, redactRow } from './secrets.js';

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

export class Capture implements CaptureRecorder {
  readonly mode: CaptureMode;
  active = true;
  readonly parameterValues: boolean;
  #started = performance.now();
  #limits: Required<CaptureLimits>;
  #bytes = 0;
  #timing: Timing = { auth: 0, handler: 0, db: 0, queryCount: 0, serialize: 0 };
  #values: CaptureSnapshot = { changes: [], effects: [], logs: [] };

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

  /** Record a row change. Secret-named columns (for example `password_hash`) never leave the process. */
  change(value: Change) {
    if (!this.active) return;
    const key = value.key !== null && typeof value.key === 'object' && !Array.isArray(value.key)
      ? redactRow(value.key as Record<string, unknown>) : value.key;
    this.#append('changes', { ...value, key, before: redactRow(value.before), after: redactRow(value.after) });
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
    const { level, message, elapsedMs, sql } = value;
    this.#append('logs', {
      level: clip(level, nameLimit), message: clip(message), ...boundedLog(value),
      ...(elapsedMs === undefined ? {} : { elapsedMs }), ...(sql === undefined ? {} : { sql }),
      offsetMs: performance.now() - this.#started,
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
