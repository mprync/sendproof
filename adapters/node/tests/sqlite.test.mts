import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteDatabase } from '@test-bench/sqlite';
import type { SQLiteOptions } from '@test-bench/sqlite';
import { capturing, sqlEntries } from './support/capture.mts';

const schema = 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)';
const tracked = (...ids: string[]) => ({ table: 'items', keys: ids.map(id => ({ id })) });

function open(options: SQLiteOptions = {}): SQLiteDatabase {
  return new SQLiteDatabase(':memory:', { schema, ...options });
}

const insert = (database: SQLiteDatabase, id: string, name = 'Item') =>
  database.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id, name }, tracked(id));
const names = async (database: SQLiteDatabase) =>
  (await database.all('SELECT id FROM items ORDER BY id')).map(row => row['id']);

test('statement guards accept only reads for get/all and only data mutations for write', async () => {
  const database = open();
  await assert.rejects(database.get('DELETE FROM items'), /get accepts a SELECT/);
  await assert.rejects(database.all('DROP TABLE items'), /all accepts a SELECT/);
  await assert.rejects(database.write('SELECT 1'), /write accepts an INSERT/);
  await assert.rejects(database.queryRows('DROP TABLE items', [], 'run'), /SELECT or data mutation/);
  await insert(database, 'A1', 'Bolt');
  assert.deepEqual({ ...await database.get('SELECT * FROM items WHERE id = :id', { id: 'A1' }) }, { id: 'A1', name: 'Bolt' });
  await database.close();
});

test('preview rolls back writes and records tracked row changes with before and after snapshots', async () => {
  const database = open();
  await insert(database, 'keep', 'Before');
  const { result, captured } = await capturing(() => database.preview(async () => {
    await insert(database, 'new', 'Created');
    await database.write('UPDATE items SET name = :name WHERE id = :id', { id: 'keep', name: 'After' }, tracked('keep'));
    return 'response';
  }));
  assert.equal(result, 'response');
  assert.deepEqual(await names(database), ['keep']);
  assert.equal((await database.get('SELECT name FROM items WHERE id = :id', { id: 'keep' }))?.['name'], 'Before');
  assert.deepEqual(captured.changes.map(change => [change.operation, (change.key as { id: string }).id]), [['insert', 'new'], ['update', 'keep']]);
  assert.deepEqual(captured.changes[1]?.before, { id: 'keep', name: 'Before' });
  assert.deepEqual(captured.changes[1]?.after, { id: 'keep', name: 'After' });
  await database.close();
});

test('preview rolls back when the operation throws and rejects writes from an expired scope', async () => {
  const database = open();
  let escaped: Promise<unknown> | undefined;
  await assert.rejects(database.preview(async () => {
    await insert(database, 'gone');
    escaped = new Promise(resolve => setTimeout(resolve, 5)).then(() => insert(database, 'late'));
    throw new Error('operation failed');
  }), /operation failed/);
  await assert.rejects(escaped!, /preview transaction has ended/);
  assert.deepEqual(await names(database), []);
  await assert.rejects(database.preview(() => database.preview(async () => 1)), /Nested SQLite previews/);
  await database.close();
});

test('transaction commits on success and rolls back everything on failure', async () => {
  const database = open();
  await database.transaction(async () => {
    await insert(database, 'one');
    await insert(database, 'two');
  });
  await assert.rejects(database.transaction(async () => {
    await insert(database, 'three');
    throw new Error('abort');
  }), /abort/);
  assert.deepEqual(await names(database), ['one', 'two']);
  assert.equal(database.depth, 0);
  await database.close();
});

test('nested scopes are retained savepoints that a preview rollback still discards', async () => {
  const database = open();
  const depths: number[] = [];
  await database.preview(async () => {
    depths.push(database.depth);
    await database.transaction(async () => {
      depths.push(database.depth);
      await insert(database, 'inner');
      await database.transaction(async () => {
        depths.push(database.depth);
        await insert(database, 'deepest');
      });
    });
    // A released savepoint stays part of the preview transaction and is visible to later reads.
    assert.deepEqual(await names(database), ['deepest', 'inner']);
  });
  assert.deepEqual(depths, [1, 2, 3]);
  assert.deepEqual(await names(database), []);
  await database.close();
});

test('a failed savepoint rolls back alone and leaves the enclosing transaction usable', async () => {
  const database = open();
  await database.transaction(async () => {
    await insert(database, 'before');
    await assert.rejects(database.transaction(async () => {
      await insert(database, 'inner');
      throw new Error('inner failed');
    }), /inner failed/);
    assert.deepEqual(await names(database), ['before']);
    await insert(database, 'after');
  });
  assert.deepEqual(await names(database), ['after', 'before']);
  await database.close();
});

test('concurrent savepoints from one scope and concurrent leases run in order', async () => {
  const database = open();
  const order: string[] = [];
  await database.transaction(async () => {
    await Promise.all(['a', 'b', 'c'].map(id => database.transaction(async () => {
      order.push('start:' + id);
      await new Promise(resolve => setTimeout(resolve, 2));
      await insert(database, id);
      order.push('end:' + id);
    })));
  });
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  await Promise.all(['x', 'y', 'z'].map(id => database.transaction(() => insert(database, id))));
  assert.deepEqual(await names(database), ['a', 'b', 'c', 'x', 'y', 'z']);
  await database.close();
});

test('an outermost transaction retries lock contention and then gives up', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-sqlite-'));
  const filename = join(directory, 'contention.db');
  const holder = new DatabaseSync(filename);
  holder.exec(schema);
  const database = new SQLiteDatabase(filename, { retries: 5, retryDelayMs: 10 });
  try {
    holder.exec('BEGIN IMMEDIATE');
    let attempts = 0;
    const pending = database.transaction(async () => { attempts++; await insert(database, 'retried'); });
    await new Promise(resolve => setTimeout(resolve, 25));
    holder.exec('ROLLBACK');
    await pending;
    assert.equal(attempts, 1);
    assert.deepEqual(await names(database), ['retried']);

    const impatient = new SQLiteDatabase(filename, { retries: 1, retryDelayMs: 1 });
    holder.exec('BEGIN IMMEDIATE');
    await assert.rejects(impatient.preview(async () => 'never runs'), /database is locked/);
    holder.exec('ROLLBACK');
    await impatient.close();
  } finally {
    await database.close();
    holder.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQL capture redacts positional bindings, secret names and, by default, named values', async () => {
  const database = open();
  const { captured } = await capturing(async () => {
    await database.get('SELECT :fixture_secret AS value, :city AS city', { fixture_secret: 'fixture-secret-value', city: 'Dublin' });
    await database.queryRows('SELECT ? AS value', ['positional-value'], 'values');
  });
  const [named, positional] = sqlEntries(captured);
  assert.deepEqual(named?.parameters.map(parameter => [parameter.name, parameter.value]),
    [['fixture_secret', '[REDACTED]'], ['city', '[REDACTED]']]);
  assert.deepEqual(positional?.parameters.map(parameter => [parameter.name, parameter.value]), [['$1', '[REDACTED]']]);
  assert.doesNotMatch(JSON.stringify(captured), /fixture-secret-value|positional-value|Dublin/);

  const shown = await capturing(() => database.get('SELECT :fixture_secret AS value, :city AS city',
    { fixture_secret: 'fixture-secret-value', city: 'Dublin' }), { parameterValues: true });
  assert.deepEqual(sqlEntries(shown.captured)[0]?.parameters.map(parameter => parameter.value), ['[REDACTED]', 'Dublin']);
  await database.close();
});

test('tracking limits truncate captured changes without failing the write', async () => {
  const database = open({ trackedKeyLimit: 2 });
  const ids = ['a', 'b', 'c'];
  const over = await capturing(() => database.preview(async () => {
    await database.write('INSERT INTO items (id, name) VALUES (:a, :n), (:b, :n), (:c, :n)',
      { a: 'a', b: 'b', c: 'c', n: 'x' }, tracked(...ids));
    return (await names(database)).length;
  }));
  assert.equal(over.result, 3);
  assert.equal(over.captured.changesTruncated, true);
  assert.deepEqual(over.captured.changes, []);

  const capped = await capturing(() => database.preview(async () => {
    await insert(database, 'a');
    await insert(database, 'b');
    await insert(database, 'c');
  }), { limits: { changes: 2 } });
  assert.equal(capped.captured.changes.length, 2);
  assert.equal(capped.captured.changesTruncated, true);
  assert.deepEqual(await names(database), []);

  const unreadable = await capturing(() => database.write('INSERT INTO items (id, name) VALUES (:id, :name)',
    { id: 'z', name: 'z' }, { table: 'items', keys: [{ 'bad name': 'z' }] }));
  assert.equal(unreadable.captured.changesTruncated, true);
  assert.equal(unreadable.result.changes, 1);
  await database.close();
});

test('the constructor validates its options and closes the connection when the schema fails', () => {
  assert.throws(() => open({ retries: -1 }), /retries must be a non-negative integer/);
  assert.throws(() => open({ busyTimeoutMs: 1.5 }), RangeError);
  assert.throws(() => new SQLiteDatabase(':memory:', { schema: 'CREATE TABLE broken (' }), /incomplete input|syntax error/);
});
