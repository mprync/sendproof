/**
 * A minimal Redis client (RESP2) for the conformance runner and the data-store reference fixture.
 *
 * One TCP connection, commands answered in order. It supports `redis://[:password@]host:port[/db]`
 * URLs and is the runner's independent reader: it never shares a connection with the fixture under test.
 */
import { connect as tcp } from 'node:net';

/** An error reply from Redis, such as `NOAUTH` or `WRONGTYPE`. */
export class RedisReplyError extends Error {}

/** Encodes one command as a RESP array of bulk strings. */
export function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const bytes = Buffer.from(String(arg), 'utf8');
    parts.push(`$${bytes.length}\r\n`, bytes, '\r\n');
  }
  return Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part) : part));
}

/** Parses one RESP2 reply at `offset`. Returns `undefined` when the buffer holds an incomplete reply. */
function parse(buffer, offset) {
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd < 0) return undefined;
  const kind = String.fromCharCode(buffer[offset]);
  const line = buffer.toString('utf8', offset + 1, lineEnd);
  const next = lineEnd + 2;
  switch (kind) {
    case '+': return { value: line, end: next };
    case '-': return { value: new RedisReplyError(line), end: next };
    case ':': return { value: Number(line), end: next };
    case '$': {
      const length = Number(line);
      if (length < 0) return { value: null, end: next };
      if (buffer.length < next + length + 2) return undefined;
      return { value: buffer.toString('utf8', next, next + length), end: next + length + 2 };
    }
    case '*': {
      const count = Number(line);
      if (count < 0) return { value: null, end: next };
      const items = [];
      let position = next;
      for (let index = 0; index < count; index++) {
        const item = parse(buffer, position);
        if (!item) return undefined;
        items.push(item.value);
        position = item.end;
      }
      return { value: items, end: position };
    }
    default: throw new Error(`Unexpected RESP type ${kind}`);
  }
}

/** Connects, authenticates with the URL's password and selects the URL's database number. */
export async function connectRedis(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:') throw new Error('Expected a redis:// URL');
  const socket = tcp({ host: parsed.hostname, port: Number(parsed.port || 6379) });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.setNoDelay(true);
  let pending = Buffer.alloc(0);
  const queue = [];
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const reply = pending.length ? parse(pending, 0) : undefined;
      if (!reply) break;
      pending = pending.subarray(reply.end);
      const waiter = queue.shift();
      if (reply.value instanceof RedisReplyError) waiter?.reject(reply.value); else waiter?.resolve(reply.value);
    }
  });
  const failAll = error => { while (queue.length) queue.shift().reject(error); };
  socket.on('error', failAll);
  socket.on('close', () => failAll(new Error('Redis connection closed')));

  /** Sends one command, such as `send('HGETALL', key)`, and resolves with its reply. */
  const send = (...args) => new Promise((resolve, reject) => {
    queue.push({ resolve, reject });
    socket.write(encodeCommand(args));
  });

  const password = decodeURIComponent(parsed.password);
  if (password) {
    const user = decodeURIComponent(parsed.username);
    await (user ? send('AUTH', user, password) : send('AUTH', password));
  }
  const db = parsed.pathname.slice(1);
  if (db) await send('SELECT', db);

  return {
    send,
    /** Every key matching a glob pattern, collected with SCAN so a large database never blocks. */
    async keys(pattern) {
      const found = [];
      let cursor = '0';
      do {
        const [next, batch] = await send('SCAN', cursor, 'MATCH', pattern, 'COUNT', 500);
        found.push(...batch);
        cursor = next;
      } while (cursor !== '0');
      return found;
    },
    close: () => new Promise(resolve => { socket.end(resolve); }),
  };
}
