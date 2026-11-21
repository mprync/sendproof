/**
 * Sendproof write guard for Redis (spec/data-stores.md, `guard` mode).
 *
 * `redisStore(client)` hooks an ioredis 5 or node-redis 5 client in place, in front of the path
 * every command takes to the socket, so it sees a command before any byte of it is written:
 *
 * - ioredis: the instance's `sendCommand`, plus every pipeline and `multi` it creates, whose queued
 *   commands are classified before the pipeline is written.
 * - node-redis: the instance's `sendCommand` (every typed command, script and raw call goes through
 *   it), `_executeMulti` and `_executePipeline` (classified before `MULTI` is queued), and the
 *   subscribe methods.
 *
 * Reads run normally. In a Preview the first write is refused with `PreviewWriteBlockedError` and
 * the Preview answers 409. Session commands (`AUTH`, `HELLO`, `SELECT`, `PING` …) are never guarded
 * or logged, so the password never reaches a capture. Every other command becomes a `Db` log entry
 * whose statement keeps the command name and key arguments only.
 *
 * Coverage: only hooked clients are covered. A client created later, a Redis cluster or pool
 * client, or ioredis with `enableAutoPipelining` is not; the last is refused at registration.
 */
import { getKeyIndexes } from '@ioredis/commands';
import { classifyRedis, currentCapture, guard, readSet, storeLabel } from '@sendproof/core';
import type { CaptureRecorder, DataStore, DataStoreDescription } from '@sendproof/core';

/** Options for {@link redisStore}. */
export interface RedisStoreOptions {
  /** Display label for discovery, such as `cache`. Never a URL or host name. */
  name?: string;
  /**
   * Commands the host states never write, such as a custom module read `MYMODULE.GET`. Exact
   * upper-case names (or `CONTAINER|SUB`), no wildcards. A wrongly listed write is not blocked.
   */
  treatAsRead?: string[];
}

/** A hooked Redis client, ready for `dataStores`. */
export interface RedisStore<Client> extends DataStore {
  readonly system: 'redis';
  /** The same client, now guarded. */
  readonly client: Client;
}

/** Shared per-store settings passed to the client-specific hooks. */
interface Settings {
  reads: ReadonlySet<string> | undefined;
}

type Arg = string | Buffer | number;
const hooked = Symbol.for('sendproof.redis.hooked');

/** Flatten nested argument arrays the way the clients do before sending. */
const flatten = (args: readonly unknown[]): Arg[] => args.flatMap(arg => Array.isArray(arg) ? flatten(arg) : [arg as Arg]);

/**
 * The `Db` statement and target of a command: the name, then each key argument as written and every
 * other argument as `?` (`SET session:42 ?`). Values never appear. Unknown commands show no keys.
 */
function describeCommand(operation: string, args: Arg[]): { statement: string; target?: string } {
  let keys: number[] = [];
  try {
    keys = getKeyIndexes(operation.toLowerCase(), args);
  } catch {
    // An unknown command: every argument is treated as a value.
  }
  const text = (arg: Arg) => Buffer.isBuffer(arg) ? arg.toString() : String(arg);
  const shown = new Set(keys);
  const target = keys.length ? text(args[keys[0]!]!) : undefined;
  return { statement: [operation, ...args.map((arg, index) => shown.has(index) ? text(arg) : '?')].join(' '), ...(target === undefined ? {} : { target }) };
}

/** Record one finished command on the capture that was current when it was sent. */
function record(capture: CaptureRecorder | undefined, operation: string, args: Arg[], namespace: string | undefined, started: number, error?: unknown) {
  if (!capture) return;
  const { statement, target } = describeCommand(operation, args);
  const code = error instanceof Error ? error.message.split(' ')[0] : undefined;
  capture.db({
    system: 'redis', operation, statement, ...(target === undefined ? {} : { target }),
    ...(namespace === undefined ? {} : { namespace }), ...(code ? { error: code } : {}),
    elapsedMs: performance.now() - started,
  });
}

/** Classify a command for the guard. Returns the kind; throws `PreviewWriteBlockedError` for a refused write. */
function check(settings: Settings, name: string, args: Arg[]): ReturnType<typeof classifyRedis> {
  const kind = classifyRedis(name, args, settings.reads);
  guard('redis', name.toUpperCase(), kind);
  return kind;
}

/** Watch a reply promise and log it, without changing how the caller sees it. */
function observe(promise: Promise<unknown>, operation: string, args: Arg[], namespace: string | undefined) {
  const capture = currentCapture();
  if (!capture) return;
  const started = performance.now();
  promise.then(() => record(capture, operation, args, namespace, started), error => record(capture, operation, args, namespace, started, error));
}

// ---- ioredis ----

/** The parts of an ioredis Command the hook reads. */
interface IoCommand {
  name: string;
  args: unknown[];
  promise: Promise<unknown>;
  reject(error: Error): void;
}

/** The parts of an ioredis client and pipeline the hook replaces. */
interface IoClient {
  options?: { enableAutoPipelining?: boolean; db?: number };
  sendCommand(command: IoCommand, stream?: { isPipeline?: boolean }): Promise<unknown>;
  pipeline(...args: unknown[]): IoPipeline;
  multi(...args: unknown[]): IoPipeline | Promise<unknown>;
  duplicate?(...args: unknown[]): IoClient;
}
interface IoPipeline {
  _queue: IoCommand[];
  sendCommand(command: IoCommand): IoPipeline;
  exec(callback?: (...args: unknown[]) => void): Promise<unknown>;
  execBuffer?(callback?: (...args: unknown[]) => void): Promise<unknown>;
}

function hookIoredis(client: IoClient, settings: Settings): void {
  if (client.options?.enableAutoPipelining) {
    throw new TypeError('redisStore cannot guard ioredis with enableAutoPipelining, which batches commands from different requests. Turn it off for the hooked client.');
  }
  const namespace = String(client.options?.db ?? 0);
  const send = client.sendCommand.bind(client);
  let inMulti = false;
  // Commands already checked. ioredis replays its offline queue through sendCommand after a
  // reconnect, outside the request that queued them: they were guarded when first sent, and a
  // second check would see them as writes with no request.
  const checked = new WeakSet<object>();

  // Direct sends: every command that is not part of a pipeline.
  client.sendCommand = function sendCommand(command, stream) {
    // Pipelined commands were classified when they were queued; see guardPipeline.
    if (stream?.isPipeline || checked.has(command)) return send(command, stream);
    checked.add(command);
    const args = flatten(command.args);
    let kind;
    try {
      kind = check(settings, command.name, args);
    } catch (error) {
      command.reject(error as Error);
      // A write queued after MULTI must never be followed by EXEC: discard the whole transaction.
      if (inMulti) {
        inMulti = false;
        void send(discard(command)).catch(() => {});
      }
      return command.promise;
    }
    const operation = command.name.toUpperCase();
    if (kind === 'transaction') {
      if (operation === 'MULTI') inMulti = true;
      if (operation === 'EXEC' || operation === 'DISCARD') inMulti = false;
    }
    const reply = send(command, stream);
    if (kind !== 'session' && kind !== 'transaction') observe(command.promise, operation, args, namespace);
    return reply;
  };

  const pipeline = client.pipeline.bind(client);
  client.pipeline = (...args: unknown[]) => guardPipeline(pipeline(...args), settings, namespace);
  const multi = client.multi.bind(client);
  client.multi = (...args: unknown[]) => {
    const result = multi(...args);
    // `multi({ pipeline: false })` sends MULTI directly; its commands then pass through sendCommand.
    return result && typeof (result as IoPipeline).exec === 'function' ? guardPipeline(result as IoPipeline, settings, namespace) : result;
  };
  if (typeof client.duplicate === 'function') {
    const duplicate = client.duplicate.bind(client);
    client.duplicate = (...args: unknown[]) => {
      const copy = duplicate(...args);
      hookIoredis(copy, settings);
      return copy;
    };
  }
}

/** A DISCARD command built with the same Command class as `like`. */
function discard(like: IoCommand): IoCommand {
  const Command = like.constructor as new (name: string, args: unknown[]) => IoCommand;
  return new Command('discard', []);
}

/**
 * Guard an ioredis pipeline or `multi`. Each command is classified as it is queued; a refused write
 * is not queued, and `exec` then rejects without writing anything, so no command of the pipeline
 * (and no `EXEC`) reaches Redis. Commands queued by the constructor are checked at `exec`.
 */
function guardPipeline(pipeline: IoPipeline, settings: Settings, namespace: string): IoPipeline {
  let refusal: Error | undefined;
  const capture = currentCapture();
  const queue = pipeline.sendCommand.bind(pipeline);
  const checked = new WeakSet<IoCommand>();
  pipeline.sendCommand = function sendCommand(command) {
    if (refusal) return pipeline;
    try {
      check(settings, command.name, flatten(command.args));
    } catch (error) {
      refusal = error as Error;
      return pipeline;
    }
    checked.add(command);
    return queue(command);
  };
  for (const method of ['exec', 'execBuffer'] as const) {
    const run = pipeline[method]?.bind(pipeline);
    if (!run) continue;
    pipeline[method] = function exec(callback) {
      for (const command of pipeline._queue) {
        if (refusal) break;
        if (checked.has(command)) continue;
        try {
          check(settings, command.name, flatten(command.args));
        } catch (error) {
          refusal = error as Error;
        }
      }
      if (refusal) {
        const rejected = Promise.reject(refusal);
        if (typeof callback === 'function') rejected.catch(error => callback(error));
        return rejected;
      }
      const started = performance.now();
      const result = run(callback);
      for (const command of pipeline._queue) {
        const args = flatten(command.args);
        const kind = classifyRedis(command.name, args, settings.reads);
        if (kind === 'session' || kind === 'transaction') continue;
        const operation = command.name.toUpperCase();
        command.promise.then(() => record(capture ?? currentCapture(), operation, args, namespace, started),
          error => record(capture ?? currentCapture(), operation, args, namespace, started, error));
      }
      return result;
    };
  }
  return pipeline;
}

// ---- node-redis ----

/** The parts of a node-redis 5 client the hook replaces. */
interface NodeClient {
  options?: { database?: number };
  sendCommand(args: Arg[], options?: unknown): Promise<unknown>;
  _executeMulti(commands: { args: Arg[] }[], selectedDB?: number): Promise<unknown>;
  _executePipeline(commands: { args: Arg[] }[], selectedDB?: number): Promise<unknown>;
  duplicate?(...args: unknown[]): NodeClient;
  createPool?(...args: unknown[]): unknown;
  _self?: unknown;
  [method: string]: unknown;
}

const subscribeMethods = ['SUBSCRIBE', 'subscribe', 'PSUBSCRIBE', 'pSubscribe', 'SSUBSCRIBE', 'sSubscribe'];

function hookNodeRedis(facade: NodeClient, settings: Settings): void {
  // createClient() returns an object that inherits from the real client (`_self`), and every
  // command dispatches through `_self`, so the hooks go there.
  const client = (facade._self as NodeClient | undefined) ?? facade;
  const namespace = String(client.options?.database ?? 0);
  const send = client.sendCommand.bind(client);
  client.sendCommand = function sendCommand(args, options) {
    const flat = flatten(args);
    const [name = '', ...rest] = flat;
    let kind;
    try {
      kind = check(settings, String(name), rest);
    } catch (error) {
      return Promise.reject(error);
    }
    const reply = send(args, options);
    if (kind !== 'session' && kind !== 'transaction') observe(reply, String(name).toUpperCase(), rest, namespace);
    return reply;
  };
  // MULTI … EXEC and pipelines are queued together at exec(): classify every command first, so a
  // refused write means nothing, not even MULTI, is queued.
  for (const method of ['_executeMulti', '_executePipeline'] as const) {
    const run = client[method].bind(client);
    client[method] = async function execute(commands, selectedDB) {
      for (const { args } of commands) {
        const [name = '', ...rest] = flatten(args);
        check(settings, String(name), rest);
      }
      const capture = currentCapture();
      const started = performance.now();
      const log = (error?: unknown) => {
        for (const { args } of commands) {
          const [name = '', ...rest] = flatten(args);
          const kind = classifyRedis(String(name), rest, settings.reads);
          if (kind !== 'session' && kind !== 'transaction') record(capture, String(name).toUpperCase(), rest, namespace, started, error);
        }
      };
      try {
        const result = await run(commands, selectedDB);
        log();
        return result;
      } catch (error) {
        log(error);
        throw error;
      }
    };
  }
  // Subscribing bypasses sendCommand. A delivered message can't be recalled, so these are writes.
  for (const method of subscribeMethods) {
    const run = client[method];
    if (typeof run !== 'function') continue;
    client[method] = function subscribe(this: unknown, ...args: unknown[]) {
      guard('redis', method.toUpperCase(), 'write');
      return (run as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  if (typeof client.duplicate === 'function') {
    const duplicate = client.duplicate.bind(client);
    client.duplicate = (...args: unknown[]) => {
      const copy = duplicate(...args);
      hookNodeRedis(copy, settings);
      return copy;
    };
  }
  // `withTypeMapping()`, `withCommandOptions()` and friends inherit from `_self`, so they are
  // already hooked. A pool made from the client opens clients of its own: hook those too.
  if (typeof client.createPool === 'function') {
    const createPool = client.createPool.bind(client);
    client.createPool = (...args: unknown[]) => guardPool(createPool(...args) as NodePool, settings);
  }
}

/** The part of a node-redis `RedisClientPool` the hook uses: every command, MULTI and pipeline runs through `execute`. */
interface NodePool { _self?: NodePool; execute<T>(task: (client: NodeClient) => T): Promise<T> }

/** Hook each client a pool hands to a task, once, before the task sends anything. */
function guardPool(pool: NodePool, settings: Settings): NodePool {
  const self = pool._self ?? pool;
  const execute = self.execute.bind(self);
  const members = new WeakSet<object>();
  self.execute = <T>(task: (client: NodeClient) => T) => execute(member => {
    const inner = (member._self as object | undefined) ?? member;
    if (!members.has(inner)) {
      members.add(inner);
      hookNodeRedis(member, settings);
    }
    return task(member);
  });
  return pool;
}

/**
 * Hook a Redis client in place and return the store for `dataStores`. Accepts an ioredis 5 client
 * (`new Redis(url)`) or a node-redis 5 client (`createClient({ url })`), before or after it connects.
 * Hooking the same client twice is refused, so its commands are never logged twice.
 */
export function redisStore<Client extends object>(client: Client, options: RedisStoreOptions = {}): RedisStore<Client> {
  const name = storeLabel(options.name);
  const settings: Settings = { reads: readSet(options.treatAsRead, item => item.toUpperCase()) };
  const target = client as Record<PropertyKey, unknown>;
  if (target[hooked]) throw new TypeError('This Redis client is already hooked by redisStore.');
  if (typeof target._executeMulti === 'function' && typeof target.sendCommand === 'function') {
    hookNodeRedis(client as unknown as NodeClient, settings);
  } else if (typeof target.pipeline === 'function' && typeof target.sendCommand === 'function') {
    hookIoredis(client as unknown as IoClient, settings);
  } else {
    throw new TypeError('redisStore takes an ioredis 5 or node-redis 5 client.');
  }
  Object.defineProperty(client, hooked, { value: true });
  const description: DataStoreDescription = { system: 'redis', ...(name === undefined ? {} : { name }), mode: 'guard' };
  return { system: 'redis', client, describe: async () => ({ ...description }) };
}
