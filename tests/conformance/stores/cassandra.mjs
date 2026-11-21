/**
 * A minimal Cassandra client (CQL native protocol v4) for the conformance runner and the data-store
 * reference fixture.
 *
 * One TCP connection, no authentication, consistency ONE. It supports QUERY, PREPARE, EXECUTE and
 * BATCH with text, int, bigint, boolean and null values, and decodes rows of the common scalar
 * types. It is the runner's independent reader: it never shares a connection with the fixture.
 */
import { connect as tcp } from 'node:net';

const opcodes = { ERROR: 0x00, STARTUP: 0x01, READY: 0x02, AUTHENTICATE: 0x03, QUERY: 0x07, RESULT: 0x08, PREPARE: 0x09, EXECUTE: 0x0a, BATCH: 0x0d };
const consistencyOne = 0x0001;
const batchTypes = { logged: 0, unlogged: 1, counter: 2 };

/** An ERROR response from Cassandra, such as a syntax or invalid-request error. */
export class CassandraError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const short = value => { const buffer = Buffer.alloc(2); buffer.writeUInt16BE(value); return buffer; };
const int = value => { const buffer = Buffer.alloc(4); buffer.writeInt32BE(value); return buffer; };
const string = value => { const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([short(bytes.length), bytes]); };
const longString = value => { const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([int(bytes.length), bytes]); };
const shortBytes = bytes => Buffer.concat([short(bytes.length), bytes]);

/** Serializes one bound value. Strings are text, numbers int, bigints bigint, booleans boolean. */
function value(item) {
  if (item === null || item === undefined) return int(-1);
  let bytes;
  if (typeof item === 'string') bytes = Buffer.from(item, 'utf8');
  else if (typeof item === 'number') bytes = int(item);
  else if (typeof item === 'bigint') { bytes = Buffer.alloc(8); bytes.writeBigInt64BE(item); }
  else if (typeof item === 'boolean') bytes = Buffer.from([item ? 1 : 0]);
  else if (Buffer.isBuffer(item)) bytes = item;
  else throw new TypeError(`Unsupported CQL value: ${typeof item}`);
  return Buffer.concat([int(bytes.length), bytes]);
}

const values = list => Buffer.concat([short(list.length), ...list.map(value)]);
/** QUERY and EXECUTE parameters: consistency ONE, with values when there are any. */
const parameters = list => Buffer.concat([short(consistencyOne), Buffer.from([list.length ? 0x01 : 0x00]), ...(list.length ? [values(list)] : [])]);

/** Reads protocol values from a response body. */
class Reader {
  constructor(buffer) { this.buffer = buffer; this.offset = 0; }
  int() { const result = this.buffer.readInt32BE(this.offset); this.offset += 4; return result; }
  short() { const result = this.buffer.readUInt16BE(this.offset); this.offset += 2; return result; }
  string() { const length = this.short(); const result = this.buffer.toString('utf8', this.offset, this.offset + length); this.offset += length; return result; }
  bytes() { const length = this.int(); if (length < 0) return null; const result = this.buffer.subarray(this.offset, this.offset + length); this.offset += length; return result; }
  shortBytes() { const length = this.short(); const result = this.buffer.subarray(this.offset, this.offset + length); this.offset += length; return result; }
  /** A type option: `{ id, inner? }`. Collections, tuples and UDTs are read so the offset stays right. */
  type() {
    const id = this.short();
    if (id === 0x0000) return { id, custom: this.string() };
    if (id === 0x0020 || id === 0x0022) return { id, inner: [this.type()] };
    if (id === 0x0021) return { id, inner: [this.type(), this.type()] };
    if (id === 0x0030) { this.string(); this.string(); const count = this.short(); for (let i = 0; i < count; i++) { this.string(); this.type(); } return { id }; }
    if (id === 0x0031) { const count = this.short(); for (let i = 0; i < count; i++) this.type(); return { id }; }
    return { id };
  }
}

/** Decodes a cell of a scalar type; other types come back as hex. */
function decodeCell(type, bytes) {
  if (bytes === null) return null;
  switch (type.id) {
    case 0x0001: case 0x000d: return bytes.toString('utf8');
    case 0x0002: case 0x0005: return Number(bytes.readBigInt64BE());
    case 0x0004: return bytes[0] !== 0;
    case 0x0009: return bytes.readInt32BE();
    case 0x0013: return bytes.readInt16BE();
    case 0x0014: return bytes.readInt8();
    case 0x0007: return bytes.readDoubleBE();
    default: return bytes.toString('hex');
  }
}

/** Reads row metadata: flags, column specs and the paging state. */
function metadata(reader) {
  const flags = reader.int();
  const count = reader.int();
  if (flags & 0x0002) reader.bytes();
  if (flags & 0x0004) return { columns: [] };
  const global = flags & 0x0001;
  if (global) { reader.string(); reader.string(); }
  const columns = [];
  for (let i = 0; i < count; i++) {
    if (!global) { reader.string(); reader.string(); }
    columns.push({ name: reader.string(), type: reader.type() });
  }
  return { columns };
}

/** Decodes a RESULT body into `{ kind, rows?, keyspace?, id? }`. */
function result(body) {
  const reader = new Reader(body);
  const kind = reader.int();
  if (kind === 0x0001) return { kind: 'void' };
  if (kind === 0x0002) {
    const { columns } = metadata(reader);
    const count = reader.int();
    const rows = [];
    for (let i = 0; i < count; i++) rows.push(Object.fromEntries(columns.map(column => [column.name, decodeCell(column.type, reader.bytes())])));
    return { kind: 'rows', rows };
  }
  if (kind === 0x0003) return { kind: 'keyspace', keyspace: reader.string() };
  if (kind === 0x0004) return { kind: 'prepared', id: Buffer.from(reader.shortBytes()) };
  return { kind: 'schema' };
}

/**
 * Connects to `host:port`. Returns `{ query, prepare, execute, batch, close }`; `query` and `execute`
 * resolve to `{ kind, rows }` and reject with `CassandraError`.
 */
export async function connectCassandra(contactPoint) {
  const [host, port] = String(contactPoint).split(':');
  const socket = tcp({ host, port: Number(port) });
  socket.setNoDelay(true);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const pending = new Map();
  let nextStream = 1;
  let buffered = Buffer.alloc(0);
  let failure = null;
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 9) {
      const length = buffered.readInt32BE(5);
      if (buffered.length < 9 + length) break;
      const flags = buffered[1];
      const stream = buffered.readInt16BE(2);
      const opcode = buffered[4];
      let body = buffered.subarray(9, 9 + length);
      // Optional prefixes, in protocol order: a tracing id, server warnings, a custom payload.
      const prefix = new Reader(body);
      if (flags & 0x02) prefix.offset += 16;
      if (flags & 0x08) { const count = prefix.short(); for (let i = 0; i < count; i++) prefix.string(); }
      if (flags & 0x04) { const count = prefix.short(); for (let i = 0; i < count; i++) { prefix.string(); prefix.bytes(); } }
      body = body.subarray(prefix.offset);
      buffered = buffered.subarray(9 + length);
      const waiter = pending.get(stream);
      pending.delete(stream);
      if (!waiter) continue;
      if (opcode === opcodes.ERROR) {
        const reader = new Reader(body);
        const code = reader.int();
        waiter.reject(new CassandraError(code, reader.string()));
      } else waiter.resolve({ opcode, body });
    }
  });
  const fail = error => { failure = error; for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Cassandra connection closed')));

  function send(opcode, body) {
    if (failure) return Promise.reject(failure);
    const stream = nextStream;
    nextStream = nextStream >= 32767 ? 1 : nextStream + 1;
    const header = Buffer.alloc(9);
    header[0] = 0x04;
    header.writeInt16BE(stream, 2);
    header[4] = opcode;
    header.writeInt32BE(body.length, 5);
    return new Promise((resolve, reject) => {
      pending.set(stream, { resolve, reject });
      socket.write(Buffer.concat([header, body]));
    });
  }

  const ready = await send(opcodes.STARTUP, Buffer.concat([short(1), string('CQL_VERSION'), string('3.0.0')]));
  if (ready.opcode === opcodes.AUTHENTICATE) throw new Error('This minimal Cassandra client does not support authentication');

  return {
    async query(cql, list = []) { return result((await send(opcodes.QUERY, Buffer.concat([longString(cql), parameters(list)]))).body); },
    async prepare(cql) { return result((await send(opcodes.PREPARE, longString(cql))).body).id; },
    async execute(id, list = []) { return result((await send(opcodes.EXECUTE, Buffer.concat([shortBytes(id), parameters(list)]))).body); },
    /** Sends one BATCH message. `statements` are `{ query, values }` or `{ id, values }`. */
    async batch(statements, { type = 'logged' } = {}) {
      const parts = statements.map(item => Buffer.concat([
        Buffer.from([item.id ? 1 : 0]), item.id ? shortBytes(item.id) : longString(item.query), values(item.values ?? []),
      ]));
      const body = Buffer.concat([Buffer.from([batchTypes[type]]), short(parts.length), ...parts, short(consistencyOne), Buffer.from([0])]);
      return result((await send(opcodes.BATCH, body)).body);
    },
    close: async () => { failure ??= new Error('closed'); socket.end(); },
  };
}
