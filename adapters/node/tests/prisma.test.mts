/**
 * Prisma provider units: rollback acknowledgment with scripted driver adapters, statement
 * classification, model metadata and the generator protocol. Database behaviour lives in
 * prisma-databases.test.mts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlDriverAdapterFactory, SqlQuery } from '@prisma/driver-adapter-utils';
import {
  PrismaPreview, controlsTransaction, endsTransaction, fromDmmf, mayWrite, normalizeModels, splitStatements,
} from '@sendproof/prisma';
import type { DmmfModel, PrismaModelMetadata } from '@sendproof/prisma';
import { capturing } from './support/capture.mts';

const query = (sql: string): SqlQuery => ({ sql, args: [], argTypes: [] });
const empty = { columnTypes: [], columnNames: [], rows: [] };

interface Script {
  provider?: 'sqlite' | 'postgres' | 'mysql';
  phantom?: boolean;
  /** Fail the physical ROLLBACK statement. */
  failRollback?: boolean;
  /** Release the transaction without sending ROLLBACK, as a faulty client would. */
  skipRollbackStatement?: boolean;
  /** Fail the release of the Preview savepoint, as when a commit below the adapter erased it. */
  committedBelowGuard?: boolean;
}

/**
 * A scripted driver adapter and a client that drives it the way Prisma's transaction manager
 * does: start, run the callback, then ROLLBACK (unless the adapter uses phantom queries) and
 * release through rollback().
 */
function scripted(script: Script = {}) {
  const executed: string[] = [];
  const queryable = {
    provider: script.provider ?? 'sqlite',
    adapterName: 'scripted',
    async queryRaw(sql: SqlQuery) { executed.push(sql.sql); return empty; },
    async executeRaw(sql: SqlQuery) {
      if (script.failRollback && sql.sql === 'ROLLBACK') throw new Error('rollback failed');
      if (script.committedBelowGuard && sql.sql === 'RELEASE SAVEPOINT sendproof_preview') throw new Error('SAVEPOINT sendproof_preview does not exist');
      executed.push(sql.sql);
      return 0;
    },
  };
  const factory = {
    provider: queryable.provider,
    adapterName: 'scripted',
    async connect() {
      return {
        ...queryable,
        async executeScript() {},
        async dispose() {},
        async startTransaction() {
          executed.push('BEGIN');
          return { ...queryable, options: { usePhantomQuery: script.phantom ?? false },
            async commit() { executed.push('commit()'); },
            async rollback() { executed.push(script.phantom ? 'ROLLBACK (phantom)' : 'rollback()'); } };
        },
      };
    },
  } as unknown as SqlDriverAdapterFactory;
  const provider = new PrismaPreview(factory);
  let connection: Awaited<ReturnType<SqlDriverAdapterFactory['connect']>> | undefined;
  const root = async () => (connection ??= await provider.adapter.connect());
  const client = {
    root,
    async $transaction<T>(operation: (client: unknown) => Promise<T>) {
      const transaction = await (await root()).startTransaction();
      try {
        const result = await operation(transaction);
        await transaction.executeRaw(query('COMMIT'));
        await transaction.commit();
        return result;
      } catch (error) {
        if (transaction.options.usePhantomQuery) await transaction.rollback();
        else {
          try {
            if (!script.skipRollbackStatement) await transaction.executeRaw(query('ROLLBACK'));
          } finally {
            await transaction.rollback();
          }
        }
        throw error;
      }
    },
  };
  provider.attach(client);
  return { provider, client, executed };
}

describe('Prisma rollback acknowledgment', () => {
  it('confirms a Preview after the physical ROLLBACK and the driver release', async () => {
    const { provider, executed } = scripted();
    assert.equal(await provider.preview(async () => 'result'), 'result');
    // Every provider sets the Preview savepoint first and releases it before the rollback (the commit backstop).
    assert.deepEqual(executed, ['BEGIN', 'SAVEPOINT sendproof_preview', 'RELEASE SAVEPOINT sendproof_preview', 'ROLLBACK', 'rollback()']);
  });

  it('never confirms a Preview whose transaction was committed by a path the statement guard does not see', async () => {
    // The driver lost the start savepoint: something committed the transaction below the adapter Sendproof wraps.
    for (const provider of ['sqlite', 'postgres', 'mysql'] as const) {
      const scripted_ = scripted({ provider, committedBelowGuard: true });
      await assert.rejects(scripted_.provider.preview(async () => 'result'), /not contained/, provider);
    }
  });

  it('confirms phantom-query adapters through their rollback method', async () => {
    const { provider, executed } = scripted({ provider: 'mysql', phantom: true });
    assert.equal(await provider.preview(async () => 'result'), 'result');
    // On MySQL the Preview savepoint is set first and released before the rollback (the commit backstop).
    assert.deepEqual(executed, ['BEGIN', 'SAVEPOINT sendproof_preview', 'RELEASE SAVEPOINT sendproof_preview', 'ROLLBACK (phantom)']);
  });

  it('leaves a release without ROLLBACK unconfirmed and retires the client', async () => {
    const { provider } = scripted({ skipRollbackStatement: true });
    await assert.rejects(provider.preview(async () => 'result'), /did not acknowledge rollback/);
    await assert.rejects(provider.run(() => 'poisoned connection'), /unavailable/);
  });

  it('leaves a failed ROLLBACK unconfirmed even though the callback error is reported', async () => {
    const { provider } = scripted({ failRollback: true });
    await assert.rejects(provider.preview(async () => { throw new Error('handler'); }), /did not acknowledge rollback/);
  });

  it('withholds confirmation when the request commits inside the Preview transaction', async () => {
    const { provider } = scripted({ provider: 'postgres' });
    await assert.rejects(provider.preview(() => provider.run(async transaction =>
      (transaction as { executeRaw(q: SqlQuery): Promise<number> }).executeRaw(query('COMMIT')))), /not contained/);
    // Containment failures do not retire a pooled client; the next Preview still runs.
    assert.equal(await provider.preview(async () => 'next'), 'next');
  });

  it('allows reads but not writes on other pooled connections during a Preview', async () => {
    const { provider, client } = scripted({ provider: 'postgres' });
    const connection = await client.root();
    assert.equal(await provider.preview(async () => { await connection.queryRaw(query('SELECT 1')); return 'read'; }), 'read');
    await assert.rejects(provider.preview(() => connection.executeRaw(query("UPDATE items SET name = 'x'"))), /outside the Preview/);
    await assert.rejects(provider.preview(async () => {
      const separate = await connection.startTransaction();
      await separate.executeRaw(query('BEGIN'));
      await separate.executeRaw(query("INSERT INTO items VALUES ('a', 'b')"));
    }), /separate transaction/);
  });

  it('serializes SQLite leases and rejects nested Previews', async () => {
    const { provider } = scripted();
    const order: string[] = [];
    let release!: () => void;
    const first = provider.preview(() => new Promise<void>(resolve => { order.push('preview'); release = resolve; }));
    const second = provider.run(() => { order.push('run'); });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['preview']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['preview', 'run']);
    await assert.rejects(provider.preview(() => provider.preview(async () => 'inner')), /Nested Prisma previews/);
  });
});

describe('Prisma provider options', () => {
  const factory = { provider: 'sqlite', adapterName: 'none', async connect() { throw new Error('unused'); } } as unknown as SqlDriverAdapterFactory;
  const models: PrismaModelMetadata = { version: 1, models: { Item: { table: 'items', key: ['id'], columns: { id: 'id' }, relations: [] } } };

  it('validates options, the attached client and its ownership', () => {
    assert.throws(() => new PrismaPreview(factory, { maxTrackedRows: 0 }), /maxTrackedRows/);
    assert.throws(() => new PrismaPreview(factory).client, /Attach a Prisma client/);
    assert.throws(() => new PrismaPreview(factory, { models }).attach({ $transaction: async () => undefined as never }),
      /\$extends/);
    const provider = new PrismaPreview(factory);
    provider.attach({ $transaction: async () => undefined as never });
    assert.throws(() => provider.attach({ $transaction: async () => undefined as never }), /owns one Prisma client/);
  });

  it('records explicitly tracked rows and keeps automatic capture out of them', async () => {
    let extension: { query: { $allModels: { $allOperations(input: object): Promise<unknown> } } } | undefined;
    const rows = new Map<string, object>();
    const client = {
      $transaction: async () => undefined as never,
      $extends(value: typeof extension) { extension = value; return client; },
    };
    const provider = new PrismaPreview(factory, { models });
    provider.attach(client);
    const write = () => extension!.query.$allModels.$allOperations({
      model: 'Unknown', operation: 'create', args: {}, query: async () => { rows.set('a', { id: 'a' }); return {}; },
    });
    const { captured } = await capturing(() => provider.track({
      table: 'items', key: { id: 'a' }, lookup: () => rows.get('a') ?? null,
    }, write), { mode: 'send' });
    assert.deepEqual(captured.changes, [{ operation: 'insert', table: 'items', key: { id: 'a' }, before: null, after: { id: 'a' } }]);
    assert.notEqual(captured.changesTruncated, true, 'the manual write was not also routed through automatic capture');
    const unknown = await capturing(() => provider.run(write), { mode: 'send' });
    assert.equal(unknown.captured.changesTruncated, true, 'writes to models without metadata are marked incomplete');
  });
});

describe('Prisma statement classification', () => {
  it('splits statements outside quotes, comments and, on PostgreSQL, dollar quoting', () => {
    assert.deepEqual(splitStatements("SELECT 'a;b'; -- c;\nUPDATE t SET x = $$;$$ /* ; */; COMMIT", 'postgres'),
      ["SELECT 'a;b'", 'UPDATE t SET x = $$;$$', 'COMMIT']);
    assert.deepEqual(splitStatements('SELECT $1, $2', 'postgres'), ['SELECT $1, $2']);
    // Other servers have no dollar quoting, so the separator inside counts.
    assert.deepEqual(splitStatements('UPDATE t SET x = $$;$$', 'mysql'), ['UPDATE t SET x = $$', '$$']);
  });

  it('recognises statements that end a transaction, per dialect', () => {
    for (const sql of ['COMMIT', 'commit work', 'END', 'BEGIN', 'START TRANSACTION', 'ROLLBACK', 'SET autocommit = 1',
      'PREPARE TRANSACTION \'x\'', 'SELECT 1; COMMIT', '/* hidden */ COMMIT']) {
      assert.ok(endsTransaction(sql, 'postgres'), sql);
    }
    for (const sql of ['SAVEPOINT a', 'ROLLBACK TO SAVEPOINT a', 'ROLLBACK TO a', 'RELEASE SAVEPOINT a', 'CREATE TABLE t (id int)']) {
      assert.ok(!endsTransaction(sql, 'postgres'), sql);
    }
    assert.ok(endsTransaction('CREATE TABLE t (id int)', 'mysql'));
    assert.ok(endsTransaction('TRUNCATE items', 'mysql'));
    assert.ok(!endsTransaction('CREATE TEMPORARY TABLE t (id int)', 'mysql'));
    assert.ok(!endsTransaction('INSERT INTO items VALUES (1)', 'mysql'));
  });

  it('separates reads from writes and pure transaction control', () => {
    for (const sql of ['SELECT 1', 'show tables', 'EXPLAIN SELECT 1', 'PRAGMA table_info(x)']) assert.ok(!mayWrite(sql), sql);
    for (const sql of ['INSERT INTO t VALUES (1)', 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
      'SELECT * INTO copy FROM t', 'SELECT nextval(\'s\')', 'SELECT 1; DELETE FROM t']) assert.ok(mayWrite(sql), sql);
    assert.ok(controlsTransaction('BEGIN'));
    assert.ok(controlsTransaction('RELEASE SAVEPOINT a; COMMIT'));
    assert.ok(!controlsTransaction('COMMIT; DELETE FROM t'));
  });
});

describe('Prisma model metadata', () => {
  const dmmf: DmmfModel[] = [
    { name: 'Item', dbName: 'items', fields: [
      { name: 'id', kind: 'scalar', isId: true }, { name: 'label', kind: 'scalar', dbName: 'item_label' },
      { name: 'status', kind: 'enum' }, { name: 'notes', kind: 'object' },
    ] },
    { name: 'Entry', schema: 'ledger', fields: [{ name: 'book', kind: 'scalar' }, { name: 'line', kind: 'scalar' }],
      primaryKey: { fields: ['book', 'line'] } },
    { name: 'Tag', fields: [{ name: 'slug', kind: 'scalar' }], uniqueFields: [['slug']] },
  ];

  it('derives keys, columns, tables and relations from DMMF', () => {
    assert.deepEqual(fromDmmf(dmmf).models, {
      Item: { table: 'items', key: ['id'], columns: { id: 'id', label: 'item_label', status: 'status' }, relations: ['notes'] },
      Entry: { table: 'ledger.Entry', key: ['book', 'line'], columns: { book: 'book', line: 'line' }, relations: [] },
      Tag: { table: 'Tag', key: ['slug'], columns: { slug: 'slug' }, relations: [] },
    });
    assert.deepEqual(normalizeModels({ datamodel: { models: dmmf } }), fromDmmf(dmmf));
  });

  it('rejects models without a key and malformed generated metadata', () => {
    assert.throws(() => fromDmmf([{ name: 'Log', fields: [{ name: 'at', kind: 'scalar' }] }]), /no primary key/);
    assert.throws(() => normalizeModels({ version: 2 } as never), /Unsupported/);
    assert.throws(() => normalizeModels({ version: 1, models: { A: { table: 'a', key: ['id'], columns: {}, relations: [] } } }),
      /no usable key/);
  });
});

describe('sendproof-prisma-generator', () => {
  it('answers getManifest and generate over Prisma\'s stdio JSON-RPC protocol', async () => {
    const output = await mkdtemp(join(tmpdir(), 'sendproof-prisma-generator-'));
    try {
      const script = fileURLToPath(import.meta.resolve('@sendproof/prisma/generator'));
      const child = spawn(process.execPath, [script], { env: { ...process.env, PRISMA_GENERATOR_INVOCATION: 'true' } });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const exited = new Promise(resolve => child.on('exit', resolve));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getManifest', params: {} }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'generate', params: {
        generator: { output: { value: output } },
        dmmf: { datamodel: { models: [{ name: 'Item', dbName: 'items', fields: [{ name: 'id', kind: 'scalar', isId: true }] }] } },
      } }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'unknown' }) + '\n');
      child.stdin.end();
      assert.equal(await exited, 0);
      const responses = stderr.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(responses.find(response => response.id === 1).result.manifest.prettyName, 'Sendproof model keys');
      assert.equal(responses.find(response => response.id === 2).result, null);
      assert.equal(responses.find(response => response.id === 3).error.code, -32601);
      const { models } = await import(join(output, 'index.js')) as { models: PrismaModelMetadata };
      assert.deepEqual(models.models.Item, { table: 'items', key: ['id'], columns: { id: 'id' }, relations: [] });
      assert.match(await readFile(join(output, 'index.d.ts'), 'utf8'), /PrismaModelMetadata/);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
