import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle as betterSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as mysqlDrizzle } from 'drizzle-orm/mysql2';
import { drizzlePreview } from '@sendproof/drizzle';
import { SQLiteDatabase } from '@sendproof/sqlite';
import { capturing, sqlEntries } from './support/capture.mts';
import { targets } from './support/drizzle-databases.mts';
import type { Client, Opened, Tables } from './support/drizzle-databases.mts';

/** Match an error or the driver error Drizzle keeps as its cause. */
const failure = (pattern: RegExp) => (error: Error) =>
  pattern.test(error.message + ' ' + String((error.cause as Error | undefined)?.message));

for (const target of targets()) {
  describe('Drizzle provider on ' + target.name, () => {
    let opened: Opened;
    let client: Client;
    let t: Tables;
    const server = target.dialect !== 'sqlite' && target.name !== 'PGlite';
    /** Runs a raw statement on the client in the way the dialect's Drizzle client offers. */
    const raw = (query: ReturnType<typeof sql>) => target.dialect === 'sqlite'
      ? (client as unknown as { all(query: unknown): Promise<unknown> }).all(query)
      : client.execute(query);

    before(async () => {
      opened = await target.open();
      client = opened.client;
      t = opened.tables;
    });
    afterEach(() => opened.reset());
    after(() => opened.cleanup());

    it('rolls back a Preview and captures each change by the primary key in the table definition', async () => {
      await client.insert(t.items).values({ id: 'kept', name: 'Before' });
      const { result, captured } = await capturing(() => opened.provider.preview(async () => {
        await client.insert(t.items).values({ id: 'new', name: 'Created' });
        await client.update(t.items).set({ name: 'Renamed' }).where(eq(t.items.id, 'kept'));
        await client.delete(t.items).where(eq(t.items.id, 'new'));
        return (await client.select().from(t.items)).map(row => row.name);
      }));
      assert.deepEqual(result, ['Renamed']);
      assert.deepEqual(captured.changes, [
        { operation: 'insert', table: 'items', key: { id: 'new' }, before: null, after: { id: 'new', name: 'Created' } },
        { operation: 'update', table: 'items', key: { id: 'kept' }, before: { id: 'kept', name: 'Before' }, after: { id: 'kept', name: 'Renamed' } },
        { operation: 'delete', table: 'items', key: { id: 'new' }, before: { id: 'new', name: 'Created' }, after: null },
      ]);
      assert.equal(captured.changesTruncated, undefined);
      assert.deepEqual(await opened.ids(), ['kept']);
      assert.deepEqual(await client.select({ name: t.items.name }).from(t.items), [{ name: 'Before' }]);
    });

    it('commits an observed Send and captures its changes without caller-supplied keys', async () => {
      const { captured } = await capturing(async () => {
        await client.insert(t.items).values([{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }]);
        await client.update(t.items).set({ name: 'Both' });
      }, { mode: 'send' });
      assert.deepEqual(captured.changes.map(change => [change.operation, change.key]), [
        ['insert', { id: 'a' }], ['insert', { id: 'b' }], ['update', { id: 'a' }], ['update', { id: 'b' }],
      ]);
      assert.deepEqual(await opened.ids(), ['a', 'b']);
    });

    it('captures keys the database generates, keeping the statement result unchanged', async () => {
      const { result, captured } = await capturing(() => opened.provider.preview(async () => {
        const plain = await client.insert(t.counters).values([{ label: 'one' }, { label: 'two' }]);
        const returned = target.dialect === 'mysql'
          ? await (client.insert(t.counters).values({ label: 'three' }) as unknown as { $returningId(): Promise<unknown> }).$returningId()
          : await client.insert(t.counters).values({ label: 'three' }).returning({ label: t.counters.label });
        return { plain, returned };
      }));
      assert.deepEqual(captured.changes, [1, 2, 3].map((id, index) => ({
        operation: 'insert', table: 'counters', key: { id }, before: null, after: { id, label: ['one', 'two', 'three'][index] },
      })));
      assert.deepEqual(result.returned, target.dialect === 'mysql' ? [{ id: 3 }] : [{ label: 'three' }]);
      if (target.dialect === 'postgresql') {
        // The key columns were read through RETURNING; the driver's own result keeps its count and no rows.
        const plain = result.plain as unknown as { length?: number; rows?: unknown[]; rowCount?: number; affectedRows?: number; count?: number };
        assert.equal(Array.isArray(plain) ? plain.length : plain.rows?.length, 0);
        assert.equal(plain.rowCount ?? plain.affectedRows ?? plain.count, 2);
      }
      assert.deepEqual(await opened.ids('counters'), []);
    });

    if (target.dialect === 'mysql') {
      it('reads the auto-increment step from the current transaction connection', async () => {
        for (const step of [3, 5]) {
          const { result, captured } = await capturing(() => opened.provider.preview(async () => {
            await raw(sql.raw('SET SESSION auto_increment_increment = ' + step));
            try {
              await client.insert(t.counters).values([{ label: 'one' }, { label: 'two' }]);
              return await client.select({ id: t.counters.id }).from(t.counters).orderBy(t.counters.id);
            } finally {
              await raw(sql`SET SESSION auto_increment_increment = 1`);
            }
          }));
          assert.equal(Number(result[1]?.id) - Number(result[0]?.id), step);
          assert.deepEqual(captured.changes.map(change => change.key), result);
          assert.deepEqual(await opened.ids('counters'), []);
        }
      });
    }

    it('captures client-generated $defaultFn keys and composite primary keys', async () => {
      const { result, captured } = await capturing(() => opened.provider.preview(async () => {
        await client.insert(t.tokens).values({ label: 'generated' });
        await client.insert(t.pairs).values({ a: 1, b: 2, value: 'first' });
        await client.update(t.pairs).set({ value: 'second' }).where(and(eq(t.pairs.a, 1), eq(t.pairs.b, 2)));
        return client.select().from(t.tokens);
      }));
      assert.equal(result.length, 1);
      assert.deepEqual(captured.changes, [
        { operation: 'insert', table: 'tokens', key: { id: result[0]!.id }, before: null, after: { id: result[0]!.id, label: 'generated' } },
        { operation: 'insert', table: 'pairs', key: { a: 1, b: 2 }, before: null, after: { a: 1, b: 2, value: 'first' } },
        { operation: 'update', table: 'pairs', key: { a: 1, b: 2 }, before: { a: 1, b: 2, value: 'first' }, after: { a: 1, b: 2, value: 'second' } },
      ]);
    });

    it('captures an upsert as an update of the existing row and an insert of the new one', async () => {
      await client.insert(t.items).values({ id: 'u', name: 'Before' });
      const rows = [{ id: 'u', name: 'Upserted' }, { id: 'v', name: 'Upserted' }];
      const { captured } = await capturing(() => opened.provider.preview(async () => {
        const insert = client.insert(t.items).values(rows) as unknown as {
          onConflictDoUpdate(config: unknown): Promise<unknown>;
          onDuplicateKeyUpdate(config: unknown): Promise<unknown>;
        };
        await (target.dialect === 'mysql'
          ? insert.onDuplicateKeyUpdate({ set: { name: 'Upserted' } })
          : insert.onConflictDoUpdate({ target: t.items.id, set: { name: 'Upserted' } }));
      }));
      assert.deepEqual(captured.changes, [
        { operation: 'update', table: 'items', key: { id: 'u' }, before: { id: 'u', name: 'Before' }, after: { id: 'u', name: 'Upserted' } },
        { operation: 'insert', table: 'items', key: { id: 'v' }, before: null, after: { id: 'v', name: 'Upserted' } },
      ]);
      assert.deepEqual(await opened.ids(), ['u']);
    });

    it('nests client.transaction() as savepoints and drops changes a failed savepoint undid', async () => {
      const { result, captured } = await capturing(() => opened.provider.preview(async () => {
        await client.transaction(async tx => {
          await tx.insert(t.items).values({ id: 'outer', name: 'Outer' });
          await assert.rejects(tx.transaction(async inner => {
            await inner.insert(t.items).values({ id: 'undone', name: 'Undone' });
            throw new Error('inner failed');
          }), /inner failed/);
          // The application client follows the innermost transaction of the calling context.
          await tx.transaction(async () => { await client.insert(t.items).values({ id: 'kept', name: 'Kept' }); });
        });
        return (await client.select({ id: t.items.id }).from(t.items).orderBy(t.items.id)).map(row => row.id);
      }));
      assert.deepEqual(result, ['kept', 'outer']);
      assert.deepEqual(captured.changes.map(change => change.key), [{ id: 'outer' }, { id: 'kept' }]);
      assert.deepEqual(await opened.ids(), []);

      await client.transaction(async tx => { await tx.insert(t.items).values({ id: 'committed', name: 'Committed' }); });
      await assert.rejects(client.transaction(async tx => {
        await tx.insert(t.items).values({ id: 'aborted', name: 'Aborted' });
        throw new Error('abort');
      }), /abort/);
      assert.deepEqual(await opened.ids(), ['committed']);
    });

    it('keeps an ordinary request outside a concurrent Preview transaction', async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const previewing = opened.provider.preview(async () => {
        await client.insert(t.items).values({ id: 'previewed', name: 'Preview' });
        await gate;
      });
      await delay(20);
      const ordinary = client.insert(t.items).values({ id: 'ordinary', name: 'Ordinary' }).then(() => 'committed');
      if (server) {
        // A server database gives the ordinary request its own connection: it commits before Preview ends.
        assert.equal(await Promise.race([ordinary, delay(3000).then(() => 'blocked')]), 'committed');
        assert.deepEqual(await opened.ids(), ['ordinary']);
      }
      release();
      await previewing;
      assert.equal(await ordinary, 'committed');
      assert.deepEqual(await opened.ids(), ['ordinary']);
    });

    it('completes concurrent Previews that insert the same new key', async () => {
      // On MySQL, InnoDB would abort all but one with a deadlock once the first rolled back, so previews take turns.
      const runs = await Promise.all(Array.from({ length: 6 }, () => capturing(() => opened.provider.preview(async () => {
        await client.insert(t.items).values({ id: 'shared', name: 'Shared' });
        await delay(50); // let the other previews reach their insert and wait on this row
        return 'inserted';
      }))));
      for (const { result, captured } of runs) {
        assert.equal(result, 'inserted');
        assert.deepEqual(captured.changes.map(change => change.key), [{ id: 'shared' }]);
      }
      assert.deepEqual(await opened.ids(), []);
    });

    it('refuses statements after the transaction ends and statements that would end a Preview', async () => {
      let late!: Promise<unknown>;
      await opened.provider.preview(async () => {
        late = delay(30).then(() => client.select().from(t.items));
        late.catch(() => {});
      });
      await assert.rejects(late, failure(/has ended/));

      await assert.rejects(opened.provider.preview(async () => {
        await client.insert(t.items).values({ id: 'guarded', name: 'Guarded' });
        await raw(sql`commit`);
      }), failure(target.dialect === 'sqlite' ? /SELECT or data mutation/ : /Preview owns the transaction/));
      if (target.dialect === 'mysql') {
        await assert.rejects(opened.provider.preview(() => raw(sql`create table implicit_commit (id int)`)), /Preview owns the transaction/);
        await assert.rejects(opened.provider.preview(() => raw(sql.raw('/*!COMMIT*/'))), /Preview owns the transaction/);
      }
      if (target.dialect !== 'sqlite') {
        // A refused COMMIT that the operation swallows still fails the Preview: it is never confirmed.
        await assert.rejects(opened.provider.preview(async () => {
          await client.insert(t.items).values({ id: 'swallowed', name: 'Swallowed' });
          await raw(sql`commit`).catch(() => {});
          return 'looks fine';
        }), /not contained/);
      }
      await assert.rejects(opened.provider.preview(() => opened.provider.preview(async () => 'nested')), /Nested/);
      assert.deepEqual(await opened.ids(), []);
    });

    if (target.dialect === 'mysql') {
      it('refuses CALL and the Preview savepoint during a MySQL Preview, and catches a declared procedure that commits', async () => {
        await raw(sql.raw('DROP PROCEDURE IF EXISTS sendproof_commit_probe'));
        await raw(sql.raw('CREATE PROCEDURE sendproof_commit_probe() BEGIN COMMIT; END'));
        try {
          const refusals: string[] = [];
          await assert.rejects(opened.provider.preview(async () => {
            await client.insert(t.items).values({ id: 'called', name: 'Must roll back' });
            for (const statement of ['CALL sendproof_commit_probe()', 'RELEASE SAVEPOINT sendproof_preview']) {
              try { await raw(sql.raw(statement)); refusals.push('ran'); } catch (error) { refusals.push((error as Error).message); }
            }
          }), /not contained/);
          for (const message of refusals) assert.match(message, /Preview owns the transaction/);
          assert.deepEqual(await opened.ids(), []);

          // Wrongly declared safe, the procedure commits; the savepoint set when the Preview started is then gone.
          const trusting = opened.provide({ safeProcedures: ['sendproof_commit_probe'] });
          await assert.rejects(trusting.preview(async () => {
            await trusting.client.insert(t.items).values({ id: 'declared', name: 'Committed' });
            await trusting.client.execute(sql.raw('CALL sendproof_commit_probe()'));
          }), /savepoint set when the Preview started was gone/);
          assert.deepEqual(await opened.ids(), ['declared']);

          // Under autocommit=0 MySQL opens a new transaction after the COMMIT, which only the start savepoint sees through.
          const manual = await opened.manualCommit!({ safeProcedures: ['sendproof_commit_probe'] });
          try {
            await assert.rejects(manual.provider.preview(async () => {
              await manual.provider.client.insert(t.items).values({ id: 'manual', name: 'Committed' });
              await manual.provider.client.execute(sql.raw('CALL sendproof_commit_probe()'));
              await manual.provider.client.insert(t.items).values({ id: 'after', name: 'In the implicit transaction' });
            }), /savepoint set when the Preview started was gone/);
          } finally {
            await manual.close();
          }
          assert.deepEqual(await opened.ids(), ['declared', 'manual']);
        } finally {
          await raw(sql.raw('DROP PROCEDURE IF EXISTS sendproof_commit_probe'));
        }
      });
    }

    it('marks changes truncated for unidentifiable rows, prepared mutations and the row limit', async () => {
      await client.insert(t.items).values([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]);
      const limited = opened.provide({ trackedRowLimit: 2 });
      const cases: [string, () => Promise<unknown>][] = [
        ['row limit', () => limited.client.update(t.items).set({ name: 'All' })],
        ['no primary key', () => limited.client.insert(t.notes).values({ body: 'unkeyed' })],
        ['prepared', () => (limited.client.delete(t.items).where(eq(t.items.id, sql.placeholder('id')))
          .prepare('tb_prepared_delete') as unknown as { execute(values: unknown): Promise<unknown> }).execute({ id: 'a' })],
      ];
      for (const [name, mutate] of cases) {
        const { captured } = await capturing(() => limited.preview(mutate));
        assert.equal(captured.changesTruncated, true, name);
        assert.deepEqual(captured.changes, [], name);
      }
      const { captured } = await capturing(() => limited.preview(() => limited.client.delete(t.items).where(eq(t.items.id, 'b'))));
      assert.deepEqual(captured.changes.map(change => [change.operation, change.key]), [['delete', { id: 'b' }]]);
      assert.deepEqual(await opened.ids(), ['a', 'b', 'c']);
    });

    it('logs statements with redacted positional parameters and names only where labelled', async () => {
      const { captured } = await capturing(() => opened.provider.preview(async () => {
        await opened.provider.withParameterNames(['fixture_secret', 'label'],
          () => raw(sql`select ${'fixture-secret-value'} as hidden, ${'shown'} as label`));
        await client.insert(t.items).values({ id: 'logged', name: 'Logged' });
      }), { parameterValues: true });
      const entries = sqlEntries(captured);
      const insert = entries.find(entry => /^insert into/i.test(entry.text));
      assert.equal(insert?.rowsAffected, 1);
      assert.deepEqual(insert?.parameters?.map(parameter => parameter.value), ['[REDACTED]', '[REDACTED]']);
      // Snapshot reads and transaction control are the provider's own and stay out of the log.
      assert.equal(entries.length, 2);
      if (target.dialect === 'sqlite') return;
      assert.deepEqual(entries[0]?.parameters?.map(({ name, value }) => [name, value]),
        [['fixture_secret', '[REDACTED]'], ['label', 'shown']]);
    });

    // Needs a server session the test can end; postgres 3.4.7 crashes in a socket callback when it is ended.
    if (server && target.name !== 'PostgreSQL (postgres)') {
      it('leaves Preview unconfirmed when the database cannot confirm the rollback', async () => {
        const fragile = await opened.disposable!();
        await assert.rejects(fragile.provider.preview(async () => {
          await fragile.provider.client.insert(t.items).values({ id: 'lost', name: 'Lost' });
          await fragile.provider.client.execute(sql.raw(opened.killSession!)).catch(() => {});
          return 'handled';
        }));
        await fragile.close();
        assert.deepEqual(await opened.ids(), []);
      });
    }
  });
}

describe('Drizzle provider configuration', () => {
  it('validates the row limit and the database it is given', async () => {
    const database = new SQLiteDatabase(':memory:', { schema: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)' });
    assert.throws(() => drizzlePreview(database, { trackedRowLimit: -1 }), RangeError);
    assert.throws(() => drizzlePreview(database, { trackedRowLimit: 1.5 }), RangeError);
    const native = new Database(':memory:');
    assert.throws(() => drizzlePreview(betterSqlite(native) as never), /For SQLite, pass a @sendproof\/sqlite SQLiteDatabase/);
    native.close();
    assert.throws(() => drizzlePreview({} as never), /accepts a Drizzle PostgreSQL or MySQL database/);
    const connection = { query: async () => [[]], execute: async () => [[]] };
    assert.throws(() => drizzlePreview(mysqlDrizzle(connection as never, { mode: 'default' })), /mysql2 pool/);
    await database.close();
  });

  it('keeps the earlier track() and SQLite constructor callable, now with automatic keys', async () => {
    const { sqliteTable, text } = await import('drizzle-orm/sqlite-core');
    const items = sqliteTable('items', { id: text('id').primaryKey(), name: text('name').notNull() });
    const database = new SQLiteDatabase(':memory:', { schema: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)' });
    const provider = drizzlePreview(database, { schema: { items } });
    const { result, captured } = await capturing(() => provider.preview(() =>
      provider.track({ table: 'items', keys: [] }, () => provider.client.insert(items).values({ id: 'legacy', name: 'Legacy' }).returning())));
    assert.deepEqual(result, [{ id: 'legacy', name: 'Legacy' }]);
    assert.deepEqual(captured.changes.map(change => change.key), [{ id: 'legacy' }]);
    assert.equal(await provider.client.query.items.findFirst(), undefined);
    await database.close();
  });
});
