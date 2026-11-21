/**
 * Automatic row change capture for Prisma model writes.
 *
 * A Prisma client query extension routes every model write through `ChangeCapture.write`.
 * The rows a write can touch are read before and after it through the request's client, so
 * the reads share the Preview transaction. Rows are identified by the primary key from the
 * generated model metadata and reported with database table and column names.
 */
import { isDeepStrictEqual } from 'node:util';
import type { CaptureRecorder } from '@sendproof/core';
import { delegateName, type PrismaModelKeys, type PrismaModelMetadata } from './metadata.js';

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;

/** The model delegate methods used for before and after reads. */
interface ModelDelegate {
  findUnique(args: object): Promise<Row | null>;
  findFirst(args: object): Promise<Row | null>;
  findMany(args: object): Promise<Row[]>;
}

/** The parameters Prisma passes to a `$allOperations` query extension. */
export interface ModelOperation {
  model?: string;
  operation: string;
  args: unknown;
  query(args: unknown): Promise<unknown>;
}

/** Hooks connecting capture to the provider's request scope. */
export interface CaptureHooks {
  /** The client of the current request, or the attached root client. */
  client(): unknown;
  /** Run an internal read that should not be captured or logged as application SQL. */
  internal<T>(read: () => Promise<T>): Promise<T>;
}

const singleWrites = new Set(['create', 'update', 'upsert', 'delete']);
const manyWrites = new Set(['createMany', 'createManyAndReturn', 'updateMany', 'updateManyAndReturn', 'deleteMany']);
const nestedWriteKeys = new Set(['create', 'createMany', 'connectOrCreate', 'upsert', 'update', 'updateMany',
  'delete', 'deleteMany', 'set', 'connect', 'disconnect']);
const lookupBatch = 100;

/** Whether a Prisma model operation writes rows. */
export function isWrite(operation: string): boolean {
  return singleWrites.has(operation) || manyWrites.has(operation);
}

/** Convert a Prisma value into a JSON-safe value for the trace. */
export function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    const json = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof json === 'function') return json.call(value);
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, plain(entry)]));
  }
  return value;
}

/** Records insert, update and delete changes for model writes. */
export class ChangeCapture {
  readonly #models: Record<string, PrismaModelKeys>;
  readonly #hooks: CaptureHooks;
  readonly #maxRows: number;

  constructor(metadata: PrismaModelMetadata, hooks: CaptureHooks, maxRows: number) {
    this.#models = metadata.models;
    this.#hooks = hooks;
    this.#maxRows = maxRows;
  }

  /** Run a model write and record the rows it changed. */
  async write(operation: ModelOperation, recorder: CaptureRecorder): Promise<unknown> {
    const model = operation.model === undefined ? undefined : this.#models[operation.model];
    if (!model || !operation.model) {
      recorder.truncate('changes');
      return operation.query(operation.args);
    }
    const write = new ModelWrite(operation.model, model, this.#hooks, recorder, this.#maxRows);
    return singleWrites.has(operation.operation) ? write.single(operation) : write.many(operation);
  }
}

class ModelWrite {
  readonly #name: string;
  readonly #model: PrismaModelKeys;
  readonly #hooks: CaptureHooks;
  readonly #recorder: CaptureRecorder;
  readonly #maxRows: number;
  readonly #select: Record<string, true>;
  #incomplete = false;

  constructor(name: string, model: PrismaModelKeys, hooks: CaptureHooks, recorder: CaptureRecorder, maxRows: number) {
    this.#name = name;
    this.#model = model;
    this.#hooks = hooks;
    this.#recorder = recorder;
    this.#maxRows = maxRows;
    this.#select = Object.fromEntries(Object.keys(model.columns).map(field => [field, true]));
  }

  /** `create`, `update`, `upsert` and `delete` address one row. */
  async single({ operation, args, query }: ModelOperation): Promise<unknown> {
    const input = (args ?? {}) as Args;
    this.#checkNested(operation === 'upsert' ? [input.create, input.update] : [input.data]);
    const before = operation === 'create' ? null : await this.#read(delegate => delegate.findUnique({
      where: input.where, select: this.#select,
    }));
    const { args: keyed, added } = this.#withKey(input);
    const result = await query(keyed) as Row | null;
    const after = operation === 'delete' || !result || !this.#hasKey(result)
      ? null
      : await this.#read(delegate => delegate.findFirst({ where: this.#keyOf(result), select: this.#select }));
    if (operation !== 'delete' && result && !this.#hasKey(result)) this.#incomplete = true;
    if (before !== undefined && after !== undefined) this.#record(before, after);
    this.#finish();
    return strip(result, added);
  }

  /** `createMany`, `updateMany`, `deleteMany` and their `AndReturn` forms address many rows. */
  async many({ operation, args, query }: ModelOperation): Promise<unknown> {
    const input = (args ?? {}) as Args;
    if (operation.startsWith('create')) return this.#createMany(operation, input, query);
    const changesKey = operation.startsWith('update') && this.#touchesKey(input.data);
    this.#checkNested([input.data]);
    const found = changesKey ? undefined : await this.#read(delegate => delegate.findMany({
      where: input.where, select: this.#select, take: this.#maxRows + 1,
    }));
    const { args: keyed, added } = operation === 'updateManyAndReturn' ? this.#withKey(input) : { args: input, added: [] };
    const result = await query(keyed);
    if (!found) {
      this.#incomplete = true;
    } else {
      if (found.length > this.#maxRows) this.#incomplete = true;
      const before = found.slice(0, this.#maxRows);
      const after = await this.#rows(before.map(row => this.#keyOf(row)));
      if (after) for (const row of before) this.#record(row, after.get(this.#identity(row)) ?? null);
    }
    this.#finish();
    return Array.isArray(result) ? result.map(row => strip(row as Row, added)) : result;
  }

  async #createMany(operation: string, input: Args, query: ModelOperation['query']): Promise<unknown> {
    const data = (Array.isArray(input.data) ? input.data : [input.data]) as (Row | undefined)[];
    if (operation === 'createManyAndReturn') {
      const { args: keyed, added } = this.#withKey(input);
      const result = await query(keyed) as Row[];
      const keys = result.filter(row => this.#hasKey(row)).map(row => this.#keyOf(row));
      if (keys.length !== result.length || keys.length > this.#maxRows) this.#incomplete = true;
      const after = await this.#rows(keys.slice(0, this.#maxRows));
      if (after) for (const row of after.values()) this.#record(null, row);
      this.#finish();
      return result.map(row => strip(row, added));
    }
    // createMany returns only a count, so rows are found again by the keys supplied in data.
    const keys = data.every(row => row && this.#hasKey(row)) ? data.map(row => this.#keyOf(row!)) : undefined;
    if (!keys || keys.length > this.#maxRows) {
      this.#incomplete = true;
      const result = await query(input);
      this.#finish();
      return result;
    }
    const before = await this.#rows(keys);
    const result = await query(input);
    const after = await this.#rows(keys);
    if (before && after) {
      for (const key of keys) {
        const identity = this.#identity(key);
        this.#record(before.get(identity) ?? null, after.get(identity) ?? null);
      }
    }
    this.#finish();
    return result;
  }

  /** Read rows by key in batches. `undefined` means the read failed and capture is incomplete. */
  async #rows(keys: Row[]): Promise<Map<string, Row> | undefined> {
    const found = new Map<string, Row>();
    for (let index = 0; index < keys.length; index += lookupBatch) {
      const batch = keys.slice(index, index + lookupBatch);
      const rows = await this.#read(delegate => delegate.findMany({ where: { OR: batch }, select: this.#select }));
      if (!rows) return undefined;
      for (const row of rows) found.set(this.#identity(row), row);
    }
    return found;
  }

  async #read<T>(read: (delegate: ModelDelegate) => Promise<T>): Promise<T | undefined> {
    const client = this.#hooks.client() as Record<string, ModelDelegate | undefined> | undefined;
    const delegate = client?.[delegateName(this.#name)];
    if (!delegate) {
      this.#incomplete = true;
      return undefined;
    }
    try {
      return await this.#hooks.internal(() => read(delegate));
    } catch {
      this.#incomplete = true;
      return undefined;
    }
  }

  /** Make sure the write returns the key fields, remembering which ones the caller did not ask for. */
  #withKey(input: Args): { args: Args; added: string[] } {
    const select = input.select as Record<string, unknown> | undefined;
    if (select) {
      const added = this.#model.key.filter(field => select[field] !== true);
      return { args: { ...input, select: { ...select, ...flags(added, true) } }, added };
    }
    const omit = input.omit as Record<string, unknown> | undefined;
    const added = omit ? this.#model.key.filter(field => omit[field] === true) : [];
    return added.length ? { args: { ...input, omit: { ...omit, ...flags(added, false) } }, added } : { args: input, added };
  }

  #record(before: Row | null, after: Row | null): void {
    if (before === null && after === null) return;
    const beforeRow = before && this.#columns(before);
    const afterRow = after && this.#columns(after);
    if (beforeRow && afterRow && isDeepStrictEqual(beforeRow, afterRow)) return;
    const source = (after ?? before)!;
    this.#recorder.change({
      operation: before === null ? 'insert' : after === null ? 'delete' : 'update',
      table: this.#model.table,
      key: Object.fromEntries(this.#model.key.map(field => [this.#model.columns[field] ?? field, plain(source[field])])),
      before: beforeRow,
      after: afterRow,
    });
  }

  #columns(row: Row): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this.#model.columns)
      .filter(([field]) => field in row)
      .map(([field, column]) => [column, plain(row[field])]));
  }

  #checkNested(inputs: unknown[]): void {
    for (const input of inputs) {
      if (!input || typeof input !== 'object') continue;
      const values = Array.isArray(input) ? input : [input];
      for (const value of values) {
        for (const relation of this.#model.relations) {
          const nested = (value as Row)[relation];
          if (nested && typeof nested === 'object' && Object.keys(nested).some(key => nestedWriteKeys.has(key))) {
            this.#incomplete = true;
          }
        }
      }
    }
  }

  #touchesKey(data: unknown): boolean {
    return !!data && typeof data === 'object' && this.#model.key.some(field => field in data);
  }

  #hasKey(row: Row): boolean {
    return this.#model.key.every(field => row[field] !== undefined && row[field] !== null);
  }

  #keyOf(row: Row): Row {
    return Object.fromEntries(this.#model.key.map(field => [field, row[field]]));
  }

  #identity(row: Row): string {
    return JSON.stringify(this.#model.key.map(field => plain(row[field])));
  }

  #finish(): void {
    if (this.#incomplete) this.#recorder.truncate('changes');
  }
}

function flags(fields: string[], value: boolean): Record<string, boolean> {
  return Object.fromEntries(fields.map(field => [field, value]));
}

function strip<T>(row: T, added: string[]): T {
  if (!added.length || !row || typeof row !== 'object') return row;
  const copy = { ...row } as Record<string, unknown>;
  for (const field of added) delete copy[field];
  return copy as T;
}
