import type { CaptureCollection, CaptureLimits, CaptureMode, CaptureSnapshot, CaptureRecorder, Change, Effect, RecordedLog, SqlEntry, Timing } from './types.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const current = new AsyncLocalStorage<Capture>();
const defaults = { changes: 200, effects: 100, logs: 500, bytes: 1024 * 1024, valueBytes: 8192 };
const secretName = /password|passphrase|secret|token|api.?key|authorization|credential|private.?key/i;
const clip = (value: unknown) => String(value).slice(0, 2048);

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

  change(value: Change) { this.#append('changes', value); }

  truncate(name: CaptureCollection) {
    if (this.active) this.#values[`${name}Truncated`] = true;
  }

  effect(value: Effect) {
    const { delivered, ...payload } = value;
    this.#append('effects', this.mode === 'preview' || delivered === undefined ? payload : { ...payload, delivered });
  }

  log(value: RecordedLog) {
    this.#append('logs', { ...value, level: clip(value.level), message: clip(value.message),
      offsetMs: performance.now() - this.#started });
  }

  sql({ text, parameters = [], rowsAffected, elapsedMs = 0 }: SqlEntry) {
    if (!this.active) return;
    this.#timing.queryCount++;
    this.#timing.db += elapsedMs;
    if (parameters.length > 64) this.#values.logsTruncated = true;
    this.log({ level: 'Sql', message: 'Executed SQL', elapsedMs, sql: {
      text: clip(text),
      parameters: parameters.slice(0, 64).map(({ name, value, dbType }) => ({
        name: clip(name),
        value: secretName.test(name) || !this.parameterValues ? '[REDACTED]' : value == null ? null : clip(value),
        dbType: clip(dbType),
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
