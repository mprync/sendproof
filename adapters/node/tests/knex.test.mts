import { afterEach, before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import knex from 'knex';
import type { Knex } from 'knex';
import { KnexPreview } from '@sendproof/knex';
import { capturing, sqlEntries } from './support/capture.mts';
import { deadlockPreview } from './support/deadlock.mts';
import { resetSchema, targets } from './support/knex-databases.mts';
import type { TestDatabase } from './support/knex-databases.mts';

const transient = (code: string) => Object.assign(new Error('transient ' + code), { code });

for (const target of targets()) {
  describe('Knex provider on ' + target.name, () => {
    let opened: TestDatabase;
    let database: Knex;
    let provider: KnexPreview;
    const providers: KnexPreview[] = [];

    /** A provider over the database, fresh per test so retry and limit options never leak. */
    const provide = (options?: ConstructorParameters<typeof KnexPreview>[1]) => {
      const created = new KnexPreview(database, options);
      providers.push(created);
      return created;
    };
    const ids = async (table = 'items') => (await database(table).select('id').orderBy('id')).map(row => String(row.id));

    before(async () => {
      opened = await target.open();
      database = opened.database;
      await resetSchema(database);
    });
    afterEach(async () => {
      for (const created of providers.splice(0)) created.dispose();
      await resetSchema(database);
    });
    after(() => opened.cleanup());

    it('tracks inserts, updates and deletes from the builder alone, in statement order, and returns the normal results', async () => {
      provider = provide();
      await database('items').insert([{ id: 'keep', name: 'Before' }, { id: 'drop', name: 'Drop me' }]);
      const { result, captured } = await capturing(() => provider.preview(async () => {
        await provider.client('items').insert({ id: 'new', name: 'Created' });
        const updated = await provider.client('items').where({ id: 'keep' }).update({ name: 'After' });
        const deleted = await provider.client('items').where({ id: 'drop' }).delete();
        const seen = (await provider.client('items').select('id').orderBy('id')).map(row => String(row.id));
        return { updated, deleted, seen };
      }));
      assert.deepEqual(result, { updated: 1, deleted: 1, seen: ['keep', 'new'] });
      assert.deepEqual(await ids(), ['drop', 'keep']);
      assert.equal((await database('items').where({ id: 'keep' }).first()).name, 'Before');
      assert.deepEqual(captured.changes.map(change => [change.operation, change.key]),
        [['insert', { id: 'new' }], ['update', { id: 'keep' }], ['delete', { id: 'drop' }]]);
      assert.deepEqual(captured.changes[1]?.before, { id: 'keep', name: 'Before' });
      assert.deepEqual(captured.changes[1]?.after, { id: 'keep', name: 'After' });
      assert.equal(captured.changesTruncated, undefined);
    });

    it('completes concurrent Previews that insert the same new key', async () => {
      // On MySQL, InnoDB would abort all but one with a deadlock once the first rolled back, so previews take turns.
      provider = provide();
      const runs = await Promise.all(Array.from({ length: 6 }, () => capturing(() => provider.preview(async () => {
        await provider.client('items').insert({ id: 'shared', name: 'Shared' });
        await new Promise(resolve => setTimeout(resolve, 50)); // let the others reach their insert and wait on this row
        return 'inserted';
      }))));
      for (const { result, captured } of runs) {
        assert.equal(result, 'inserted');
        assert.deepEqual(captured.changes.map(change => change.key), [{ id: 'shared' }]);
      }
      assert.deepEqual(await ids(), []);
    });

    it('refuses to let the operation commit or end the Preview transaction, and nothing it wrote persists', async () => {
      provider = provide();
      let outcomes: Record<string, string> = {};
      // Even though the operation swallows every refusal, the Preview is never confirmed.
      await assert.rejects(provider.preview(async () => {
        await provider.client('items').insert({ id: 'escaped', name: 'Must roll back' });
        const attempts: Record<string, string> = {};
        const attempt = async (name: string, run: () => PromiseLike<unknown>) => {
          try { await run(); attempts[name] = 'ran'; } catch (error) { attempts[name] = (error as Error).message; }
        };
        await attempt('commit', () => (provider.client as Knex.Transaction).commit());
        await attempt('untracked commit', () => (provider.untracked as Knex.Transaction).commit());
        await attempt('raw COMMIT', () => provider.client.raw('COMMIT'));
        await attempt('raw END', () => provider.untracked.raw('/* finish */ END'));
        // A nested unit of work is still a savepoint inside the Preview.
        await provider.transaction(async trx => { await trx('items').insert({ id: 'nested', name: 'Nested' }); });
        outcomes = attempts;
        return attempts;
      }), /not contained/);
      assert.equal(Object.keys(outcomes).length, 4);
      for (const [name, message] of Object.entries(outcomes)) assert.match(message, /Preview owns the transaction/, name);
      assert.deepEqual(await ids(), []);
    });

    it('refuses a COMMIT inside a nested transaction and DDL from the schema builder during a Preview', async () => {
      provider = provide();
      const outcomes: Record<string, string> = {};
      const attempt = async (name: string, run: () => PromiseLike<unknown>) => {
        try { await run(); outcomes[name] = 'ran'; } catch (error) { outcomes[name] = (error as Error).message; }
      };
      await assert.rejects(provider.preview(async () => {
        await provider.client('items').insert({ id: 'escaped', name: 'Must roll back' });
        // A savepoint's own transaction object runs on the Preview connection, so its COMMIT would end the Preview too.
        await attempt('nested COMMIT', () => provider.transaction(trx => trx.raw('COMMIT')));
        if (provider.dialect === 'mysql') {
          await attempt('schema builder', () => provider.client.schema.createTable('escape_ddl', table => { table.integer('n'); }));
        }
      }), /not contained/);
      for (const [name, message] of Object.entries(outcomes)) assert.match(message, /Preview owns the transaction/, name);
      assert.deepEqual(await ids(), []);
      if (provider.dialect === 'mysql') assert.equal(await database.schema.hasTable('escape_ddl'), false);
    });

    if (target.name === 'MySQL') {
      it('refuses CALL during a MySQL Preview unless the procedure is declared safe, and catches a declared one that commits', async () => {
        await database.raw('DROP PROCEDURE IF EXISTS sendproof_commit_probe');
        await database.raw('CREATE PROCEDURE sendproof_commit_probe() BEGIN COMMIT; END');
        try {
          provider = provide();
          let refusal = '';
          await assert.rejects(provider.preview(async () => {
            await provider.client('items').insert({ id: 'called', name: 'Must roll back' });
            try { await provider.client.raw('CALL sendproof_commit_probe()'); } catch (error) { refusal = (error as Error).message; }
          }), /not contained/);
          assert.match(refusal, /Preview owns the transaction/);
          assert.deepEqual(await ids(), []);

          // A host that wrongly declares the procedure safe lets it run; the start-savepoint check still fails the Preview.
          const trusting = provide({ safeProcedures: ['sendproof_commit_probe'] });
          await assert.rejects(trusting.preview(async () => {
            await trusting.client('items').insert({ id: 'declared', name: 'Committed by the procedure' });
            await trusting.client.raw('CALL sendproof_commit_probe()');
          }), /savepoint set when the Preview started was gone/);
          await database('items').where({ id: 'declared' }).delete();

          // With autocommit=0, MySQL opens a new transaction after the procedure's COMMIT, so a savepoint set only at
          // the end would succeed; the one set when the Preview started is gone either way.
          const manual = knex({ ...database.client.config, pool: { min: 1, max: 1,
            afterCreate: (connection: { query: (sql: string, done: (error?: Error) => void) => void }, done: (error?: Error) => void) =>
              connection.query('SET autocommit = 0', done) } });
          try {
            const late = new KnexPreview(manual, { safeProcedures: ['sendproof_commit_probe'] });
            providers.push(late);
            await assert.rejects(late.preview(async () => {
              await late.client('items').insert({ id: 'manual', name: 'Committed by the procedure' });
              await late.client.raw('CALL sendproof_commit_probe()');
              await late.client('items').insert({ id: 'after', name: 'In the implicit transaction' });
            }), /savepoint set when the Preview started was gone/);
            assert.deepEqual(await ids(), ['manual']);
          } finally {
            await manual.destroy();
          }
        } finally {
          await database.raw('DROP PROCEDURE IF EXISTS sendproof_commit_probe');
        }
      });

      it('refuses every statement after a deadlock rolled the Preview back, so a retry never commits', async () => {
        provider = provide();
        const [[{ d: name }]] = await database.raw('SELECT DATABASE() AS d');
        const outcome = await deadlockPreview({
          database: name, column: 'name',
          preview: work => provider.preview(work),
          update: id => provider.client('items').where({ id }).update({ name: 'Preview' }),
          insert: id => provider.client('items').insert({ id, name: 'Retry' }),
        });
        assert.ok(outcome.deadlock, 'the Preview was the deadlock victim');
        assert.match(String((outcome.retry as Error)?.message), /deadlock|rolled back/i);
        assert.match(String((outcome.previewError as Error)?.message), /not contained/);
        assert.equal(outcome.retried, 0);
      });

      it('refuses a handler releasing or recreating the Preview savepoint', async () => {
        provider = provide();
        const outcomes: string[] = [];
        await assert.rejects(provider.preview(async () => {
          for (const sql of ['RELEASE SAVEPOINT sendproof_preview', 'SAVEPOINT sendproof_preview', 'ROLLBACK TO SAVEPOINT sendproof_preview']) {
            try { await provider.client.raw(sql); outcomes.push('ran'); } catch (error) { outcomes.push((error as Error).message); }
          }
        }), /not contained/);
        for (const message of outcomes) assert.match(message, /Preview owns the transaction/);
      });
    }

    it('derives the rows of conditional, aliased and counter updates from the builder, in key order', async () => {
      provider = provide();
      await database('items').insert(['a', 'b', 'c', 'd'].map(id => ({ id, name: 'old-' + id })));
      await database('lines').insert([{ order_id: 'o1', line_no: 1, qty: 1 }, { order_id: 'o1', line_no: 2, qty: 1 }]);
      const { captured } = await capturing(() => provider.preview(async () => {
        await provider.client('items').whereIn('id', ['c', 'a']).update({ name: 'in-list' });
        if (provider.dialect === 'mssql') await provider.client('items').where('name', 'old-d').update({ name: 'aliased' });
        else await provider.client('items as i').where('i.name', 'old-d').update({ name: 'aliased' });
        await provider.client('items').whereRaw('id = ?', ['b']).delete();
        await provider.client('items').where({ id: 'missing' }).update({ name: 'nothing' });
        await provider.client('lines').where({ order_id: 'o1' }).increment('qty', 2);
      }));
      assert.deepEqual(captured.changes.map(change => [change.table, change.operation, JSON.stringify(change.key)]), [
        ['items', 'update', '{"id":"a"}'], ['items', 'update', '{"id":"c"}'],
        ['items', 'update', '{"id":"d"}'], ['items', 'delete', '{"id":"b"}'],
        ['lines', 'update', '{"order_id":"o1","line_no":1}'], ['lines', 'update', '{"order_id":"o1","line_no":2}'],
      ]);
      assert.deepEqual(captured.changes.map(change => change.after?.['name'] ?? change.after?.['qty']),
        ['in-list', 'in-list', 'aliased', undefined, 3, 3]);
      assert.equal(captured.changesTruncated, undefined);
      assert.deepEqual((await database('items').select('name').orderBy('id')).map(row => row.name),
        ['old-a', 'old-b', 'old-c', 'old-d']);
    });

    it('tracks composite keys, and truncates for a table without a primary key unless told its key', async () => {
      provider = provide();
      const { captured } = await capturing(() => provider.preview(async () => {
        await provider.client('lines').insert({ order_id: 'o1', line_no: 1, qty: 1 });
        await provider.client('lines').where({ order_id: 'o1', line_no: 1 }).update({ qty: 5 });
      }));
      assert.deepEqual(captured.changes.map(change => [change.operation, change.key, change.after?.['qty']]),
        [['insert', { order_id: 'o1', line_no: 1 }, 1], ['update', { order_id: 'o1', line_no: 1 }, 5]]);

      const skipped = await capturing(() => provider.preview(() => provider.client('plain').insert({ a: 'x' })));
      assert.equal(skipped.captured.changesTruncated, true);
      assert.deepEqual(skipped.captured.changes, []);

      const explicit = await capturing(() => provider.preview(() => provider.track(
        { table: 'plain', keys: ['x'], primaryKey: ['a'] }, client => client('plain').insert({ a: 'x' }))));
      assert.deepEqual(explicit.captured.changes.map(change => [change.operation, change.key]), [['insert', { a: 'x' }]]);
      assert.deepEqual(await database('lines').select(), []);
    });

    it('derives inserted keys from the data, from upserts and from generated values, and truncates when it cannot', async () => {
      provider = provide();
      await database('items').insert({ id: 'existing', name: 'Old' });
      const supplied = await capturing(() => provider.preview(() => provider.client('items').insert([
        { id: 'z', name: 'Z' }, { id: 'y', name: 'Y' }])));
      assert.deepEqual(supplied.captured.changes.map(change => [change.operation, change.key]),
        [['insert', { id: 'z' }], ['insert', { id: 'y' }]]);

      if (provider.dialect !== 'mssql') {
        const upsert = await capturing(() => provider.preview(() => provider.client('items')
          .insert([{ id: 'existing', name: 'New' }, { id: 'fresh', name: 'Fresh' }]).onConflict('id').merge()));
        assert.deepEqual(upsert.captured.changes.map(change => [change.operation, change.key]),
          [['update', { id: 'existing' }], ['insert', { id: 'fresh' }]]);
      }

      const generated = await capturing(() => provider.preview(() => provider.client('serial').insert({ label: 'generated' })
        .returning('id')));
      assert.deepEqual(generated.captured.changes.map(change => [change.operation, change.after?.['label']]), [['insert', 'generated']]);

      if (provider.dialect === 'mysql' || provider.dialect === 'sqlite') {
        const withoutReturning = await capturing(() => provider.preview(() => provider.client('serial').insert({ label: 'by id' })));
        assert.deepEqual(withoutReturning.captured.changes.map(change => change.after?.['label']), ['by id']);
      }
      if (provider.dialect === 'postgresql' || provider.dialect === 'mssql') {
        const unknown = await capturing(() => provider.preview(() => provider.client('serial').insert({ label: 'unknown' })));
        assert.equal(unknown.captured.changesTruncated, true);
        assert.deepEqual(unknown.captured.changes, []);
      }
      assert.deepEqual(await ids(), ['existing']);
      assert.deepEqual(await database('serial').select(), []);
    });

    it('records raw SQL as SQL only and leaves its rows to explicit tracking', async () => {
      provider = provide();
      const { captured } = await capturing(() => provider.preview(async () => {
        await provider.client.raw("INSERT INTO items (id, name) VALUES ('raw', 'Raw')");
        await provider.track({ table: 'items', keys: ['raw2'] },
          client => client.raw("INSERT INTO items (id, name) VALUES ('raw2', 'Raw')"));
      }));
      assert.deepEqual(captured.changes.map(change => [change.operation, change.key]), [['insert', { id: 'raw2' }]]);
      assert.equal(sqlEntries(captured).filter(entry => /insert into items/i.test(entry.text)).length, 2);
      assert.deepEqual(await ids(), []);
    });

    it('rolls back when the operation fails and rejects scoped work after the preview ends', async () => {
      provider = provide();
      let escaped: Promise<unknown> | undefined;
      await assert.rejects(provider.preview(async () => {
        await provider.client('items').insert({ id: 'gone', name: 'x' });
        escaped = new Promise(resolve => setTimeout(resolve, 20)).then(() => provider.client('items').insert({ id: 'late', name: 'x' }))
          .then(() => 'ran', (error: unknown) => error);
        throw new Error('operation failed');
      }), /operation failed/);
      assert.deepEqual(await ids(), []);
      await assert.rejects(provider.preview(() => provider.preview(async () => 1)), /Nested Knex previews/);
      assert.match(String(await escaped), /preview transaction has ended/);

      let builder: ReturnType<Knex> | undefined;
      await provider.preview(async () => { builder = provider.client('items').insert({ id: 'late', name: 'x' }); });
      await assert.rejects(Promise.resolve(builder), /preview transaction has ended|already complete|transaction/i);
      assert.equal(provider.untracked, database);
      assert.deepEqual(await ids(), []);
    });

    it('commits a transaction on success, rolls it back on failure, and tracks its writes in Send', async () => {
      provider = provide();
      const { captured } = await capturing(() => provider.transaction(async client => {
        await client('items').insert({ id: 'one', name: 'One' });
        await provider.client('items').insert({ id: 'two', name: 'Two' });
        assert.equal(provider.depth, 1);
      }), { mode: 'send' });
      assert.deepEqual(captured.changes.map(change => [change.operation, change.key]), [['insert', { id: 'one' }], ['insert', { id: 'two' }]]);
      await assert.rejects(provider.transaction(async client => {
        await client('items').insert({ id: 'three', name: 'Three' });
        throw new Error('abort');
      }), /abort/);
      assert.deepEqual(await ids(), ['one', 'two']);
      assert.equal(provider.depth, 0);
    });

    it('nests scopes as retained savepoints, keeps only released changes, and discards them all on preview rollback', async () => {
      provider = provide();
      const depths: number[] = [];
      const { captured } = await capturing(() => provider.preview(async () => {
        depths.push(provider.depth);
        await provider.client('items').insert({ id: 'outer', name: 'x' });
        await provider.transaction(async client => {
          depths.push(provider.depth);
          await client('items').insert({ id: 'inner', name: 'x' });
          await provider.transaction(async deeper => {
            depths.push(provider.depth);
            await deeper('items').insert({ id: 'deepest', name: 'x' });
          });
        });
        await assert.rejects(provider.transaction(async client => {
          await client('items').insert({ id: 'rolled-back', name: 'x' });
          await client('items').insert({ id: 'outer', name: 'duplicate' });
        }));
        await provider.client('items').insert({ id: 'last', name: 'x' });
        assert.deepEqual((await provider.client('items').select('id').orderBy('id')).map(row => String(row.id)),
          ['deepest', 'inner', 'last', 'outer']);
      }));
      assert.deepEqual(depths, [1, 2, 3]);
      assert.deepEqual(captured.changes.map(change => (change.key as { id: string }).id), ['outer', 'inner', 'deepest', 'last']);
      assert.deepEqual(await ids(), []);
    });

    it('rolls a failed savepoint back alone, including a constraint violation, and keeps working', async () => {
      provider = provide();
      await provider.transaction(async client => {
        await client('items').insert({ id: 'before', name: 'x' });
        await assert.rejects(provider.transaction(async inner => {
          await inner('items').insert({ id: 'inner', name: 'x' });
          await inner('items').insert({ id: 'before', name: 'duplicate' });
        }));
        assert.deepEqual((await client('items').select('id')).map(row => String(row.id)), ['before']);
        await client('items').insert({ id: 'after', name: 'x' });
      });
      assert.deepEqual(await ids(), ['after', 'before']);
    });

    it('survives a failed explicit tracking read, or stops when the database ended the transaction', async () => {
      provider = provide();
      const preview = () => capturing(() => provider.preview(async () => {
        await provider.track({ table: 'serial', keys: ['not-a-number'] }, client => client('serial').insert({ label: 'x' }));
        return (await provider.client('serial').count({ total: '*' }))[0];
      }));
      if (provider.dialect === 'mssql') {
        // SQL Server rolls the transaction back on the failed read; the request must not go on outside it.
        await assert.rejects(preview());
      } else {
        assert.equal(Number(((await preview()).result as { total: unknown }).total), 1);
      }
      assert.deepEqual(await database('serial').select(), []);
    });

    it('retries deadlocks and serialization failures but not other errors', async () => {
      provider = provide({ retries: 2, retryDelayMs: 1 });
      let attempts = 0;
      await provider.transaction(async client => {
        attempts++;
        await client('items').insert({ id: 'retried', name: 'x' });
        if (attempts === 1) throw transient('40001');
      });
      assert.equal(attempts, 2);
      assert.deepEqual(await ids(), ['retried']);

      attempts = 0;
      await assert.rejects(provider.transaction(async () => { attempts++; throw transient('40P01'); }), /transient 40P01/);
      assert.equal(attempts, 3);

      attempts = 0;
      await assert.rejects(provider.transaction(async () => { attempts++; throw new Error('fatal'); }), /fatal/);
      assert.equal(attempts, 1);

      attempts = 0;
      await assert.rejects(provide({ retries: 0 }).transaction(async () => { attempts++; throw transient('ER_LOCK_DEADLOCK'); }));
      assert.equal(attempts, 1);
    });

    it('redacts every binding, labels named ones, and keeps tracking queries out of the SQL log', async () => {
      provider = provide();
      const { captured } = await capturing(() => provider.preview(async () => {
        await provider.client('items').insert({ id: 'A1', name: 'Bolt' });
        await provider.client('items').where({ id: 'A1' }).update({ name: 'Nut' });
        await provider.withParameterNames(['fixture_secret'], () =>
          provider.client.raw('SELECT :fixture_secret AS value', { fixture_secret: 'fixture-secret-value' }));
      }), { parameterValues: true });
      // Knex's own transaction control statements are recorded; the tracking reads are not.
      const entries = sqlEntries(captured).filter(entry => !/^\s*(begin|rollback|commit|savepoint|release|start transaction)/i.test(entry.text));
      assert.deepEqual(entries.map(entry => entry.text.split(' ')[0]?.toLowerCase()), ['insert', 'update', 'select']);
      assert.deepEqual(entries[0]?.parameters.map(parameter => parameter.value), ['[REDACTED]', '[REDACTED]']);
      assert.deepEqual(entries[2]?.parameters.map(parameter => [parameter.name, parameter.value]), [['fixture_secret', '[REDACTED]']]);
      assert.doesNotMatch(JSON.stringify(entries), /fixture-secret-value|Bolt|Nut/);
      assert.equal(captured.changes.length, 2);
    });

    it('limits tracked rows and honours the capture change cap without failing the mutation', async () => {
      provider = provide({ trackedKeyLimit: 2 });
      await database('items').insert(['a', 'b', 'c'].map(id => ({ id, name: 'old' })));
      const over = await capturing(() => provider.preview(async () => {
        const updated = await provider.client('items').update({ name: 'new' });
        return { updated, names: (await provider.client('items').select('name')).map(row => row.name) };
      }));
      assert.deepEqual(over.result, { updated: 3, names: ['new', 'new', 'new'] });
      assert.equal(over.captured.changesTruncated, true);
      assert.deepEqual(over.captured.changes, []);

      const capped = await capturing(() => provider.preview(async () => {
        await provider.client('items').where({ id: 'a' }).update({ name: 'one' });
        await provider.client('items').where({ id: 'b' }).update({ name: 'two' });
      }), { limits: { changes: 1 } });
      assert.equal(capped.captured.changes.length, 1);
      assert.equal(capped.captured.changesTruncated, true);
      assert.deepEqual((await database('items').select('name')).map(row => row.name), ['old', 'old', 'old']);
    });

    it('behaves as the plain client outside a capture', async () => {
      provider = provide();
      assert.deepEqual(await provider.client('items').insert({ id: 'plain', name: 'x' }).then(() => ids()), ['plain']);
      assert.equal(await provider.client('items').where({ id: 'plain' }).update({ name: 'y' }), 1);
      assert.equal(await provider.client('items').where({ id: 'plain' }).delete(), 1);
      assert.equal(await provider.client('items').where({ id: 'plain' }).first(), undefined);
    });

    it('reports its dialect and rejects invalid options', () => {
      provider = provide();
      const expected = { SQLite: 'sqlite', PostgreSQL: 'postgresql', MySQL: 'mysql', 'SQL Server': 'mssql' } as const;
      assert.equal(provider.dialect, expected[target.name as keyof typeof expected]);
      assert.throws(() => new KnexPreview(database, { retries: -1 }), /retries must be a non-negative integer/);
      assert.throws(() => new KnexPreview(database, { trackedKeyLimit: 1.5 }), RangeError);
    });
  });
}

describe('Knex provider rollback confirmation', () => {
  /** The transaction client the statement guard wraps; these fakes never send a statement. */
  const fakeTransactionClient = () => ({ query: async () => undefined, stream: async () => undefined });

  it('treats a rollback that completes without acknowledgment as unconfirmed and removes its listener', async () => {
    const client = new EventEmitter() as EventEmitter & { transaction: () => Promise<unknown> };
    client.transaction = async () => {
      let rejectCompletion!: () => void;
      const executionPromise = new Promise<never>((_resolve, reject) => { rejectCompletion = reject; });
      return { executionPromise, client: fakeTransactionClient(), isCompleted: () => false, async rollback() { rejectCompletion(); } };
    };
    const provider = new KnexPreview(client as unknown as Knex);
    await assert.rejects(provider.preview(async () => 'response'), /did not acknowledge the rollback/);
    provider.dispose();
    assert.equal(client.listenerCount('query'), 0);
  });

  it('refuses to report a preview whose transaction the operation already completed', async () => {
    const client = new EventEmitter() as EventEmitter & { transaction: () => Promise<unknown> };
    client.transaction = async () => ({
      executionPromise: Promise.resolve(), client: fakeTransactionClient(), isCompleted: () => true, async rollback() { throw new Error('unreachable'); },
    });
    const provider = new KnexPreview(client as unknown as Knex);
    await assert.rejects(provider.preview(async () => 'response'), /completed the Knex transaction/);
    provider.dispose();
  });
});
