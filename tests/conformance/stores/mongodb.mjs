/**
 * A minimal MongoDB client for the conformance runner and the data-store reference fixture.
 *
 * It speaks OP_MSG (wire protocol 6+) over one TCP connection and encodes just the BSON types the
 * conformance checks use. The runner must not depend on any binding's driver, and the conformance
 * package has no MongoDB dependency, so this file is the independent reader that proves Preview left
 * nothing behind. It supports unauthenticated servers only, which is how compose.yml runs MongoDB.
 */
import { randomBytes } from 'node:crypto';
import { connect as tcp } from 'node:net';

/** A 64-bit integer. BSON keeps int64 distinct from int32 and double; `txnNumber` must be int64. */
export class Long {
  constructor(value) { this.value = BigInt(value); }
  toJSON() { return Number(this.value); }
}

/** Binary data with a BSON subtype. Session IDs are UUIDs (subtype 4). */
export class Binary {
  constructor(bytes, subtype = 0) { this.bytes = Buffer.from(bytes); this.subtype = subtype; }
  toJSON() { return { $binary: { base64: this.bytes.toString('base64'), subType: this.subtype.toString(16).padStart(2, '0') } }; }
}

/** A 12-byte ObjectId, decoded only (the checks always choose string `_id` values). */
export class ObjectId {
  constructor(bytes) { this.bytes = Buffer.from(bytes); }
  toJSON() { return { $oid: this.bytes.toString('hex') }; }
}

/** A BSON timestamp, as returned in `operationTime` and `$clusterTime`. */
export class Timestamp {
  constructor(low, high) { this.low = low; this.high = high; }
  toJSON() { return { $timestamp: { t: this.high, i: this.low } }; }
}

function cstring(text) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.includes(0)) throw new Error('BSON keys cannot contain NUL');
  return Buffer.concat([bytes, Buffer.alloc(1)]);
}

function encodeValue(name, value) {
  const key = cstring(name);
  const element = (type, payload) => Buffer.concat([Buffer.from([type]), key, payload]);
  if (value === null || value === undefined) return element(0x0a, Buffer.alloc(0));
  if (value instanceof Long) {
    const payload = Buffer.alloc(8);
    payload.writeBigInt64LE(value.value);
    return element(0x12, payload);
  }
  if (value instanceof Binary) {
    const header = Buffer.alloc(5);
    header.writeInt32LE(value.bytes.length);
    header[4] = value.subtype;
    return element(0x05, Buffer.concat([header, value.bytes]));
  }
  if (value instanceof ObjectId) return element(0x07, value.bytes);
  if (value instanceof Date) {
    const payload = Buffer.alloc(8);
    payload.writeBigInt64LE(BigInt(value.getTime()));
    return element(0x09, payload);
  }
  switch (typeof value) {
    case 'string': {
      const bytes = Buffer.from(value, 'utf8');
      const length = Buffer.alloc(4);
      length.writeInt32LE(bytes.length + 1);
      return element(0x02, Buffer.concat([length, bytes, Buffer.alloc(1)]));
    }
    case 'boolean': return element(0x08, Buffer.from([value ? 1 : 0]));
    case 'number': {
      if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) {
        const payload = Buffer.alloc(4);
        payload.writeInt32LE(value);
        return element(0x10, payload);
      }
      const payload = Buffer.alloc(8);
      payload.writeDoubleLE(value);
      return element(0x01, payload);
    }
    case 'bigint': return encodeValue(name, new Long(value));
    case 'object':
      return Array.isArray(value)
        ? element(0x04, encode(Object.fromEntries(value.map((item, index) => [String(index), item]))))
        : element(0x03, encode(value));
    default: throw new TypeError(`Cannot encode ${typeof value} as BSON`);
  }
}

/** Encodes a plain object as a BSON document. Key order is preserved, so the command name comes first. */
export function encode(document) {
  const body = Buffer.concat(Object.entries(document).map(([name, value]) => encodeValue(name, value)));
  const length = Buffer.alloc(4);
  length.writeInt32LE(body.length + 5);
  return Buffer.concat([length, body, Buffer.alloc(1)]);
}

/** Decodes one BSON document starting at `offset`. Int64 values become numbers when they are safe. */
export function decode(buffer, offset = 0, array = false) {
  const end = offset + buffer.readInt32LE(offset);
  const result = array ? [] : {};
  let position = offset + 4;
  while (position < end - 1) {
    const type = buffer[position++];
    const nameEnd = buffer.indexOf(0, position);
    const name = buffer.toString('utf8', position, nameEnd);
    position = nameEnd + 1;
    let value;
    switch (type) {
      case 0x01: value = buffer.readDoubleLE(position); position += 8; break;
      case 0x02: {
        const length = buffer.readInt32LE(position);
        value = buffer.toString('utf8', position + 4, position + 4 + length - 1);
        position += 4 + length;
        break;
      }
      case 0x03: case 0x04: value = decode(buffer, position, type === 0x04); position += buffer.readInt32LE(position); break;
      case 0x05: {
        const length = buffer.readInt32LE(position);
        value = new Binary(buffer.subarray(position + 5, position + 5 + length), buffer[position + 4]);
        position += 5 + length;
        break;
      }
      case 0x07: value = new ObjectId(buffer.subarray(position, position + 12)); position += 12; break;
      case 0x08: value = buffer[position++] === 1; break;
      case 0x09: value = new Date(Number(buffer.readBigInt64LE(position))); position += 8; break;
      case 0x0a: value = null; break;
      case 0x10: value = buffer.readInt32LE(position); position += 4; break;
      case 0x11: value = new Timestamp(buffer.readUInt32LE(position), buffer.readUInt32LE(position + 4)); position += 8; break;
      case 0x12: {
        const big = buffer.readBigInt64LE(position);
        value = big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : new Long(big);
        position += 8;
        break;
      }
      default: throw new Error(`Unsupported BSON type 0x${type.toString(16)} in field ${name}`);
    }
    if (array) result.push(value); else result[name] = value;
  }
  return result;
}

/** A MongoDB command failure, carrying the server's code, code name and error labels. */
export class MongoCommandError extends Error {
  constructor(reply) {
    super(reply.errmsg ?? `MongoDB command failed (${reply.codeName ?? reply.code})`);
    this.code = reply.code;
    this.codeName = reply.codeName;
    this.labels = reply.errorLabels ?? [];
  }
}

/**
 * Opens one connection to a `mongodb://host:port/database` URL. The path names the default database.
 * Only a single host is supported; with a single-node replica set use `?directConnection=true`.
 */
export async function connectMongo(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'mongodb:') throw new Error('Expected a mongodb:// URL');
  if (parsed.username) throw new Error('This minimal client supports unauthenticated servers only');
  const database = decodeURIComponent(parsed.pathname.slice(1)) || 'test';
  const socket = tcp({ host: parsed.hostname, port: Number(parsed.port || 27017) });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.setNoDelay(true);

  let pending = Buffer.alloc(0);
  let nextId = 1;
  const waiting = new Map();
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= pending.readInt32LE(0)) {
      const length = pending.readInt32LE(0);
      const message = pending.subarray(0, length);
      pending = pending.subarray(length);
      const responseTo = message.readInt32LE(8);
      // OP_MSG: header (16), flagBits (4), then section kind 0 (one body document).
      const reply = decode(message, 21);
      waiting.get(responseTo)?.resolve(reply);
      waiting.delete(responseTo);
    }
  });
  const failAll = error => {
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
  };
  socket.on('error', failAll);
  socket.on('close', () => failAll(new Error('MongoDB connection closed')));

  /** Runs one command document. `$db` defaults to the URL's database. Rejects on `ok: 0`. */
  function command(document, db = database) {
    const id = nextId++;
    const body = encode({ ...document, $db: document.$db ?? db });
    const header = Buffer.alloc(21);
    header.writeInt32LE(21 + body.length, 0);
    header.writeInt32LE(id, 4);
    header.writeInt32LE(0, 8);
    header.writeInt32LE(2013, 12); // OP_MSG
    header.writeUInt32LE(0, 16); // flagBits
    header[20] = 0; // section kind 0
    return new Promise((resolve, reject) => {
      waiting.set(id, {
        resolve: reply => reply.ok === 1 ? resolve(reply) : reject(new MongoCommandError(reply)),
        reject,
      });
      socket.write(Buffer.concat([header, body]));
    });
  }

  /** Returns every document a filter matches in a collection, following cursors. */
  async function find(collection, filter = {}, db = database) {
    let reply = await command({ find: collection, filter }, db);
    const documents = [...reply.cursor.firstBatch];
    while (reply.cursor.id !== 0) {
      const cursor = reply.cursor.id instanceof Long ? reply.cursor.id : new Long(reply.cursor.id);
      reply = await command({ getMore: cursor, collection }, db);
      documents.push(...reply.cursor.nextBatch);
    }
    return documents;
  }

  return {
    database,
    command,
    find,
    /** A new logical session ID: `{ id: UUID }`, used for transactions. */
    newSession: () => ({ id: new Binary(randomBytes(16), 4) }),
    close: () => new Promise(resolve => { socket.end(resolve); }),
  };
}
