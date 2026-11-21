import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';
import { TypeOrmPreview } from '@sendproof/typeorm';
import { Capture } from '../core/dist/capture.js';
import { deadlockPreview } from './support/deadlock.mts';

/**
 * Real-database coverage for the TypeORM provider. SQLite always runs. PostgreSQL and MySQL run
 * when `BENCH_POSTGRES_URL` / `BENCH_MYSQL_URL` point at a server; each run creates and drops its
 * own database, so the servers can be shared and the URLs name any existing database.
 */
const Item = new EntitySchema({
  name: 'Item', tableName: 'items',
  columns: { id: { type: String, primary: true }, name: { type: String, name: 'display_name' }, quantity: { type: Number, default: 0 } },
});
// A composite primary key proves that keys come from Entity metadata rather than an assumed `id`.
const Line = new EntitySchema({
  name: 'Line', tableName: 'lines',
  columns: { orderId: { type: String, primary: true, name: 'order_id' }, lineNo: { type: Number, primary: true, name: 'line_no' }, sku: { type: String } },
});

const servers = { postgresql: process.env.BENCH_POSTGRES_URL, mysql: process.env.BENCH_MYSQL_URL };
const driverTypes = { sqlite: 'better-sqlite3', postgresql: 'postgres', mysql: 'mysql' };

/** Create a disposable database on a shared server and return its connection options. */
async function provision(dialect) {
  if (dialect === 'sqlite') return { options: { type: 'better-sqlite3', database: ':memory:' }, cleanup: async () => {} };
  const admin = await new DataSource({ type: driverTypes[dialect], url: servers[dialect] }).initialize();
  const name = 'tb_typeorm_' + randomBytes(6).toString('hex');
  const quote = dialect === 'mysql' ? '`' : '"';
  await admin.query(`CREATE DATABASE ${quote}${name}${quote}`);
  const url = new URL(servers[dialect]);
  url.pathname = '/' + name;
  return {
    options: { type: driverTypes[dialect], url: url.toString() },
    cleanup: async () => {
      await admin.query(`DROP DATABASE ${quote}${name}${quote}`);
      await admin.destroy();
    },
  };
}

/** A fresh schema and provider on the dialect's database for one test. */
async function harness(database, providerOptions, extra = {}) {
  const source = await new DataSource({ ...database.options, entities: [Item, Line], synchronize: true, dropSchema: true, ...extra }).initialize();
  const provider = new TypeOrmPreview(source, providerOptions);
  return { source, provider, items: manager => manager.getRepository(Item), lines: manager => manager.getRepository(Line) };
}

/** Run `operation` inside a Preview capture and return the response with what was recorded. */
async function previewed(provider, operation) {
  const capture = new Capture('preview', {}, false);
  const response = await capture.run(() => provider.preview(operation));
  return { response, ...capture.finish().capture };
}

const dialects = ['sqlite', 'postgresql', 'mysql'];

for (const dialect of dialects) {
  const skip = dialect !== 'sqlite' && !servers[dialect] ? `BENCH_${dialect === 'mysql' ? 'MYSQL' : 'POSTGRES'}_URL is not set` : false;

  test(`TypeORM provider on ${dialect}`, { skip }, async suite => {
    const database = await provision(dialect);
    suite.after(() => database.cleanup());
    const sqlOf = logs => logs.filter(log => log.sql).map(log => log.sql);

    await suite.test('rolls back fixture-style insert, update and delete and reports each row by primary key', async () => {
      const { source, provider, items } = await harness(database);
      try {
        await provider.run(manager => items(manager).insert([{ id: 'keep', name: 'Keep' }, { id: 'gone', name: 'Gone' }]));
        const { changes, response } = await previewed(provider, () => provider.run(async manager => {
          await items(manager).insert({ id: 'new', name: 'New' });
          const updated = await items(manager).update({ id: 'keep' }, { name: 'Kept' });
          const deleted = await items(manager).delete({ id: 'gone' });
          return [updated.affected, deleted.affected];
        }));
        assert.deepEqual(response, [1, 1]);
        const summary = changes.map(({ operation, table, key }) => ({ operation, table, key }));
        assert.deepEqual(summary, [
          { operation: 'insert', table: 'items', key: { id: 'new' } },
          { operation: 'update', table: 'items', key: { id: 'keep' } },
          { operation: 'delete', table: 'items', key: { id: 'gone' } },
        ]);
        assert.equal(changes[0].before, null);
        assert.deepEqual(changes[0].after, { id: 'new', name: 'New', quantity: 0 });
        assert.equal(changes[1].before.name, 'Keep');
        assert.equal(changes[1].after.name, 'Kept');
        assert.deepEqual(changes[2].after, null);
        const persisted = await provider.run(manager => items(manager).find({ order: { id: 'ASC' } }));
        assert.deepEqual(persisted.map(({ id, name }) => [id, name]), [['gone', 'Gone'], ['keep', 'Keep']]);
      } finally {
        await source.destroy();
      }
    });

    await suite.test('completes concurrent Previews that insert the same new key', async () => {
      // On MySQL, InnoDB would abort all but one with a deadlock once the first rolled back, so previews take turns.
      const { source, provider, items } = await harness(database);
      try {
        const runs = await Promise.all(Array.from({ length: 6 }, () => previewed(provider, () => provider.run(async manager => {
          await items(manager).insert({ id: 'shared', name: 'Shared' });
          await new Promise(resolve => setTimeout(resolve, 50)); // let the others reach their insert and wait on this row
          return 'inserted';
        }))));
        for (const { response, changes } of runs) {
          assert.equal(response, 'inserted');
          assert.deepEqual(changes.map(change => change.key), [{ id: 'shared' }]);
        }
        assert.equal(await provider.run(manager => items(manager).count()), 0);
      } finally {
        await source.destroy();
      }
    });

    await suite.test('captures save and remove, and a composite primary key from metadata alone', async () => {
      const { source, provider, items, lines } = await harness(database);
      try {
        const { changes } = await previewed(provider, () => provider.run(async manager => {
          const saved = await items(manager).save({ id: 's1', name: 'Saved' });
          await items(manager).save({ ...saved, name: 'Renamed' });
          await items(manager).remove(saved);
          await lines(manager).insert({ orderId: 'o1', lineNo: 2, sku: 'bolt' });
          await lines(manager).update({ orderId: 'o1', lineNo: 2 }, { sku: 'nut' });
        }));
        assert.deepEqual(changes.map(change => [change.operation, change.table, change.key]), [
          ['insert', 'items', { id: 's1' }],
          ['update', 'items', { id: 's1' }],
          ['delete', 'items', { id: 's1' }],
          ['insert', 'lines', { orderId: 'o1', lineNo: 2 }],
          ['update', 'lines', { orderId: 'o1', lineNo: 2 }],
        ]);
        assert.equal(changes[4].before.sku, 'bolt');
        assert.equal(changes[4].after.sku, 'nut');
      } finally {
        await source.destroy();
      }
    });

    await suite.test('reports every row of a bulk write and flags tables above the tracking ceiling', async () => {
      const { source, provider, items } = await harness(database, { maxTrackedRows: 4 });
      try {
        await provider.run(manager => items(manager).insert([1, 2, 3].map(n => ({ id: 'b' + n, name: 'Bulk', quantity: n }))));
        const bulk = await previewed(provider, () => provider.run(manager =>
          items(manager).createQueryBuilder().update().set({ quantity: 9 }).where('quantity < :limit', { limit: 99 }).execute()));
        assert.deepEqual(bulk.changes.map(change => [change.operation, change.key.id, change.after.quantity]),
          [['update', 'b1', 9], ['update', 'b2', 9], ['update', 'b3', 9]]);
        assert.equal(bulk.changesTruncated, undefined);

        await provider.run(manager => items(manager).insert([{ id: 'b4', name: 'Bulk' }, { id: 'b5', name: 'Bulk' }]));
        const large = await previewed(provider, () => provider.run(manager => items(manager).update({ id: 'b1' }, { name: 'Over' })));
        assert.deepEqual(large.changes, []);
        assert.equal(large.changesTruncated, true);
        assert.equal(sqlOf(large.logs).filter(sql => /^UPDATE/i.test(sql.text)).length, 1, 'the write still appears as SQL');
      } finally {
        await source.destroy();
      }
    });

    await suite.test('reports raw SQL aimed at a mapped table and leaves unmapped tables to the SQL log', async () => {
      const { source, provider, items } = await harness(database);
      try {
        await source.query('CREATE TABLE audit (id VARCHAR(40) PRIMARY KEY)');
        await provider.run(manager => items(manager).insert({ id: 'r1', name: 'Raw' }));
        const marker = dialect === 'postgresql' ? '$1' : '?';
        const { changes, logs } = await previewed(provider, () => provider.run(async manager => {
          await manager.query(`UPDATE items SET quantity = ${marker} WHERE id = 'r1'`, [5]);
          await manager.query(`INSERT INTO audit (id) VALUES (${marker})`, ['entry']);
        }));
        assert.deepEqual(changes.map(change => [change.operation, change.key, change.after.quantity]), [['update', { id: 'r1' }, 5]]);
        assert.ok(sqlOf(logs).some(sql => /INSERT INTO audit/.test(sql.text)), 'the unmapped write is still logged');
        assert.deepEqual(await source.query('SELECT id FROM audit'), []);
      } finally {
        await source.destroy();
      }
    });

    await suite.test('rolls back nested transactions: committed and failed savepoints leave nothing behind', async () => {
      const { source, provider, items } = await harness(database);
      try {
        const { changes } = await previewed(provider, () => provider.run(async manager => {
          await items(manager).insert({ id: 'outer', name: 'Outer' });
          await manager.transaction(async inner => { await items(inner).insert({ id: 'inner-ok', name: 'Inner' }); });
          await assert.rejects(manager.transaction(async inner => {
            await items(inner).insert({ id: 'inner-fail', name: 'Inner' });
            throw new Error('inner failure');
          }), /inner failure/);
          assert.deepEqual((await items(manager).find({ order: { id: 'ASC' } })).map(item => item.id), ['inner-ok', 'outer']);
        }));
        // Changes record each statement in order, so the savepoint that was undone is still listed.
        assert.deepEqual(changes.map(change => change.key.id), ['outer', 'inner-ok', 'inner-fail']);
        assert.deepEqual(await provider.run(manager => items(manager).find()), []);
      } finally {
        await source.destroy();
      }
    });

    await suite.test('rolls back transactions the handler leaves open and keeps the connection usable', async () => {
      const { source, provider, items } = await harness(database, undefined, { sqlite: {}, postgresql: { extra: { max: 2 } }, mysql: { extra: { connectionLimit: 2 } } }[dialect]);
      try {
        for (let round = 0; round < 4; round++) {
          await previewed(provider, () => provider.run(async manager => {
            await manager.queryRunner.startTransaction();
            await manager.queryRunner.startTransaction();
            await items(manager).insert({ id: 'open-' + round, name: 'Open' });
          }));
        }
        const failing = await previewed(provider, () => provider.run(async manager => {
          await items(manager).insert({ id: 'thrown', name: 'Thrown' });
          throw new Error('handler failure');
        })).catch(error => error);
        assert.match(failing.message, /handler failure/);
        assert.deepEqual(await provider.run(manager => items(manager).find()), []);
        const completed = await Promise.race([
          provider.run(manager => items(manager).insert({ id: 'after', name: 'After' })).then(() => 'completed'),
          new Promise(resolve => setTimeout(resolve, 5000, 'stalled')),
        ]);
        assert.equal(completed, 'completed');
      } finally {
        await source.destroy();
      }
    });

    await suite.test('refuses to let the handler commit or end the Preview transaction, and nothing persists', async () => {
      const { source, provider, items } = await harness(database);
      try {
        let response = {};
        // Even though the handler swallows every refusal, the Preview is never confirmed.
        const failure = await previewed(provider, () => provider.run(async manager => {
          await items(manager).insert({ id: 'escaped', name: 'Must roll back' });
          const attempts = {};
          const attempt = async (name, run) => {
            try { await run(); attempts[name] = 'ran'; } catch (error) { attempts[name] = error.message; }
          };
          await attempt('commitTransaction', () => manager.queryRunner.commitTransaction());
          await attempt('raw COMMIT', () => manager.query('COMMIT'));
          await attempt('raw END after a comment', () => manager.query('/* done */ END'));
          // A nested unit of work still commits, as a released savepoint inside the Preview.
          await manager.transaction(nested => items(nested).insert({ id: 'nested', name: 'Nested' }));
          response = attempts;
          return attempts;
        })).catch(error => error);
        assert.match(failure.message, /not contained/);
        assert.equal(Object.keys(response).length, 3);
        for (const [name, message] of Object.entries(response)) assert.match(message, /Preview owns the transaction/, name);
        assert.deepEqual(await provider.run(manager => items(manager).find()), []);
      } finally {
        await source.destroy();
      }
    });

    await suite.test('refuses a handler rolling back or releasing the Preview transaction, so later writes stay inside it', async () => {
      const { source, provider, items } = await harness(database);
      try {
        const attempts = {};
        const failure = await previewed(provider, () => provider.run(async manager => {
          const attempt = async (name, run) => {
            try { await run(); attempts[name] = 'ran'; } catch (error) { attempts[name] = error.message; }
          };
          await attempt('rollbackTransaction', () => manager.queryRunner.rollbackTransaction());
          await attempt('release', () => manager.queryRunner.release());
          await items(manager).insert({ id: 'after-rollback', name: 'Must roll back' });
        })).catch(error => error);
        assert.match(failure.message, /not contained/);
        for (const [name, message] of Object.entries(attempts)) assert.match(message, /Preview owns the transaction/, name);
        assert.deepEqual(await provider.run(manager => items(manager).find()), []);
      } finally {
        await source.destroy();
      }
    });

    if (dialect === 'mysql') await suite.test('refuses CALL and DDL during a MySQL Preview and catches a declared procedure that commits', async () => {
      const { source, provider, items } = await harness(database);
      await source.query('DROP PROCEDURE IF EXISTS sendproof_commit_probe');
      await source.query('CREATE PROCEDURE sendproof_commit_probe() BEGIN COMMIT; END');
      const ids = async () => (await source.query('SELECT id FROM items ORDER BY id')).map(row => row.id);
      try {
        const refusals = {};
        const failure = await previewed(provider, () => provider.run(async manager => {
          await items(manager).insert({ id: 'called', name: 'Must roll back' });
          for (const statement of ['CALL sendproof_commit_probe()', 'CREATE TABLE escape_ddl (n INT)', 'RELEASE SAVEPOINT sendproof_preview']) {
            try { await manager.query(statement); refusals[statement] = 'ran'; } catch (error) { refusals[statement] = error.message; }
          }
        })).catch(error => error);
        assert.match(failure.message, /not contained/);
        for (const [statement, message] of Object.entries(refusals)) assert.match(message, /Preview owns the transaction/, statement);
        assert.deepEqual(await ids(), []);

        // Wrongly declared safe, the procedure commits; the savepoint set when the Preview started is then gone.
        const trusting = new TypeOrmPreview(source, { safeProcedures: ['sendproof_commit_probe'] });
        const declared = await previewed(trusting, () => trusting.run(async manager => {
          await items(manager).insert({ id: 'declared', name: 'Committed' });
          await manager.query('CALL sendproof_commit_probe()');
        })).catch(error => error);
        assert.match(declared.message, /savepoint set when the Preview started was gone/);
        trusting.dispose();
        assert.deepEqual(await ids(), ['declared']);

        // Under autocommit=0 MySQL opens a new transaction after the COMMIT, which only the start savepoint sees through.
        const manual = await new DataSource({ ...database.options, entities: [Item, Line], extra: { connectionLimit: 1 } }).initialize();
        await manual.query('SET autocommit = 0');
        const late = new TypeOrmPreview(manual, { safeProcedures: ['sendproof_commit_probe'] });
        try {
          const outcome = await previewed(late, () => late.run(async manager => {
            await items(manager).insert({ id: 'manual', name: 'Committed' });
            await manager.query('CALL sendproof_commit_probe()');
            await items(manager).insert({ id: 'after', name: 'In the implicit transaction' });
          })).catch(error => error);
          assert.match(outcome.message, /savepoint set when the Preview started was gone/);
        } finally {
          late.dispose();
          await manual.destroy();
        }
        assert.deepEqual(await ids(), ['declared', 'manual']);
      } finally {
        await source.query('DROP PROCEDURE IF EXISTS sendproof_commit_probe');
        await source.destroy();
      }
    });

    await suite.test('never confirms a Preview whose transaction was committed by a path the statement guard does not see', async () => {
      const { source, provider, items } = await harness(database);
      try {
        const failure = await previewed(provider, () => provider.run(async manager => {
          await items(manager).insert({ id: 'committed', name: 'Committed below the guard' });
          // The driver's own connection, below the query runner the guard wraps.
          const connection = manager.queryRunner.databaseConnection ?? manager.connection.driver.databaseConnection;
          if (typeof connection.exec === 'function') connection.exec('COMMIT'); // better-sqlite3
          else await new Promise((resolve, reject) => connection.query('COMMIT', error => error ? reject(error) : resolve()));
        })).catch(error => error);
        // SQLite then also fails TypeORM's own rollback, which withholds confirmation the same way.
        assert.match(String(failure?.message), /not contained|completed early|no transaction is active/);
        // On SQLite the failed rollback retires the provider until recovery, so clean up through the source.
        await source.query("DELETE FROM items WHERE id = 'committed'");
      } finally {
        await source.destroy();
      }
    });

    if (dialect === 'mysql') await suite.test('refuses every statement after a deadlock rolled the Preview back, so a retry never commits', async () => {
      const { source, provider, items } = await harness(database);
      try {
        const [{ d: name }] = await source.query('SELECT DATABASE() AS d');
        const outcome = await deadlockPreview({
          database: name, column: 'display_name',
          preview: work => provider.preview(() => provider.run(() => work())),
          update: id => provider.run(manager => items(manager).update({ id }, { name: 'Preview' })),
          insert: id => provider.run(manager => items(manager).insert({ id, name: 'Retry' })),
        });
        assert.ok(outcome.deadlock, 'the Preview was the deadlock victim');
        assert.match(String(outcome.retry?.message), /deadlock|rolled back/i);
        assert.match(String(outcome.previewError?.message), /not contained/);
        assert.equal(outcome.retried, 0);
      } finally {
        await source.destroy();
      }
    });

    await suite.test('work that outlives an early-settled Preview cannot write after the rollback', async () => {
      const { source, provider, items } = await harness(database);
      try {
        let late;
        // Models a response that settled early (size limit, client abort) while the handler kept running.
        const { response } = await previewed(provider, () => provider.run(async manager => {
          late = (async () => {
            await new Promise(resolve => setTimeout(resolve, 25));
            await items(manager).insert({ id: 'late', name: 'Late' });
          })();
          late.catch(() => {});
          return 'settled';
        }));
        assert.equal(response, 'settled');
        await assert.rejects(late, /request scope has ended/);
        assert.deepEqual(await provider.run(manager => items(manager).find()), []);
      } finally {
        await source.destroy();
      }
    });

    if (dialect !== 'sqlite') await suite.test('a write through another pooled connection during a Preview is refused', async () => {
      const { source, provider, items } = await harness(database);
      try {
        const failure = await previewed(provider, () => provider.run(async () => {
          await source.manager.find(Item);
          await source.getRepository(Item).insert({ id: 'pooled', name: 'Pooled' });
        })).catch(error => error);
        assert.match(failure.message, /not contained/);
        assert.deepEqual(await provider.run(manager => items(manager).find()), []);
      } finally {
        await source.destroy();
      }
    });

    await suite.test('an ordinary write made while a Preview is open commits independently', async () => {
      const { source, provider, items } = await harness(database);
      try {
        let open; const gate = new Promise(resolve => { open = resolve; });
        let entered; const inside = new Promise(resolve => { entered = resolve; });
        const preview = previewed(provider, () => provider.run(async manager => {
          await items(manager).insert({ id: 'previewed', name: 'Previewed' });
          entered();
          await gate;
        }));
        await inside;
        // On SQLite this queues behind the Preview's connection lease; on pooled drivers it runs at once.
        const ordinary = provider.run(manager => items(manager).insert({ id: 'ordinary', name: 'Ordinary' }));
        open();
        await Promise.all([preview, ordinary]);
        assert.deepEqual((await provider.run(manager => items(manager).find())).map(item => item.id), ['ordinary']);
      } finally {
        await source.destroy();
      }
    });

    await suite.test('keeps the application logger, redacts bindings and hides snapshot reads', async () => {
      const seen = [];
      const logger = {
        logQuery: text => seen.push(text), logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {},
      };
      const { source, provider, items } = await harness(database, undefined, { logger });
      try {
        seen.length = 0;
        const marker = dialect === 'postgresql' ? '$1::text' : '?';
        const { logs } = await previewed(provider, () => provider.run(async manager => {
          await provider.withParameterNames(['fixture_secret'], () => manager.query(`SELECT ${marker} AS value`, ['top-secret']));
          await items(manager).insert({ id: 'logged', name: 'Logged' });
        }));
        const statements = sqlOf(logs);
        const probe = statements.find(sql => /AS value/.test(sql.text));
        assert.deepEqual(probe.parameters, [{ name: 'fixture_secret', value: '[REDACTED]', dbType: 'string' }]);
        assert.ok(statements.every(sql => sql.parameters.every(parameter => parameter.value === '[REDACTED]')));
        assert.ok(!JSON.stringify(logs).includes('top-secret'));
        assert.equal(statements.filter(sql => /SELECT \* FROM/i.test(sql.text)).length, 0, 'snapshot reads stay out of the capture');
        assert.equal(seen.filter(text => /SELECT \* FROM/i.test(text)).length, 0, 'snapshot reads stay out of the application log');
        assert.ok(seen.some(text => /AS value/.test(text)) && seen.some(text => /INSERT INTO/.test(text)), 'application log still sees real statements');
      } finally {
        await source.destroy();
      }
    });

    // PostgreSQL aborts a transaction after any failed statement, so a failed snapshot read must not
    // be allowed to poison the handler's own writes.
    if (dialect === 'postgresql') await suite.test('a failed snapshot read leaves the handler\'s transaction usable and flags the capture', async () => {
      const { source } = await harness(database);
      const role = 'tb_writer_' + randomBytes(5).toString('hex');
      const url = new URL(database.options.url);
      url.username = role;
      url.password = 'writer';
      let writer;
      try {
        // The role may insert but not select, so every automatic SELECT snapshot fails with a permission error.
        await source.query(`CREATE ROLE ${role} LOGIN PASSWORD 'writer'`);
        await source.query(`GRANT INSERT ON lines TO ${role}`);
        writer = await new DataSource({ type: 'postgres', url: url.toString(), entities: [Line] }).initialize();
        const provider = new TypeOrmPreview(writer);
        const { logs, changes, changesTruncated } = await previewed(provider, () => provider.run(async manager => {
          await manager.query(`INSERT INTO lines (order_id, line_no, sku) VALUES ('o1', 1, 'bolt')`);
          await manager.query(`INSERT INTO lines (order_id, line_no, sku) VALUES ('o1', 2, 'nut')`);
        }));
        assert.deepEqual(changes, []);
        assert.equal(changesTruncated, true);
        assert.equal(sqlOf(logs).filter(sql => /^INSERT INTO lines/.test(sql.text)).length, 2);
        assert.ok(!sqlOf(logs).some(sql => /SAVEPOINT|SELECT \*/i.test(sql.text)), 'inspection statements stay hidden');
        assert.deepEqual(await source.query('SELECT * FROM lines'), []);
      } finally {
        await writer?.destroy();
        await source.query(`DROP OWNED BY ${role}`);
        await source.query(`DROP ROLE ${role}`);
        await source.destroy();
      }
    });

    await suite.test('a failed rollback invalidates the provider until the application recovers', async () => {
      const { source, provider } = await harness(database);
      const factory = source.createQueryRunner;
      try {
        source.createQueryRunner = mode => {
          const runner = factory.call(source, mode);
          runner.rollbackTransaction = async () => { throw new Error('rollback unavailable'); };
          return runner;
        };
        await assert.rejects(provider.preview(async () => 'ok'), /rollback unavailable/);
        await assert.rejects(provider.run(() => 'blocked'), /requires recovery/);
        await assert.rejects(provider.preview(async () => 'blocked'), /requires recovery/);
      } finally {
        await source.destroy().catch(() => {});
      }
    });
  });
}

test('SQLite trigger side effects on another table are SQL only, never row changes', async () => {
  const source = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Item], synchronize: true }).initialize();
  const provider = new TypeOrmPreview(source);
  try {
    await source.query('CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT)');
    await source.query('CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN INSERT INTO audit (item) VALUES (NEW.id); END');
    const { changes, logs } = await previewed(provider, () => provider.run(manager =>
      manager.getRepository(Item).insert({ id: 't1', name: 'Triggered' })));
    assert.deepEqual(changes.map(change => [change.table, change.key]), [['items', { id: 't1' }]]);
    assert.ok(logs.length > 0);
    assert.deepEqual(await source.query('SELECT * FROM audit'), []);
  } finally {
    await source.destroy();
  }
});

test('ordinary requests with an active capture report their committed row changes', async () => {
  const source = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Item], synchronize: true }).initialize();
  const provider = new TypeOrmPreview(source);
  try {
    const capture = new Capture('send', {}, false);
    await capture.run(() => provider.run(manager => manager.getRepository(Item).insert({ id: 'sent', name: 'Sent' })));
    const { capture: recorded } = capture.finish();
    assert.deepEqual(recorded.changes.map(change => [change.operation, change.key]), [['insert', { id: 'sent' }]]);
    assert.equal((await provider.run(manager => manager.getRepository(Item).findOneBy({ id: 'sent' }))).name, 'Sent');
  } finally {
    await source.destroy();
  }
});

test('the provider rejects nested previews, ended scopes and invalid options', async () => {
  const source = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Item], synchronize: true }).initialize();
  const provider = new TypeOrmPreview(source);
  try {
    assert.throws(() => new TypeOrmPreview(source, { maxTrackedRows: 0 }), /positive integer/);
    await provider.preview(async () => {
      await assert.rejects(provider.preview(async () => 'nested'), /Nested TypeORM previews/);
    });
    let late;
    await provider.preview(async () => {
      late = new Promise(resolve => setTimeout(resolve, 20)).then(() => provider.run(() => 'too late'));
    });
    await assert.rejects(late, /request scope has ended/);
  } finally {
    await source.destroy();
  }
});

test('dispose restores the application logger and query runner factory', async () => {
  const source = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Item], synchronize: true }).initialize();
  const logger = source.logger;
  const provider = new TypeOrmPreview(source);
  try {
    assert.notEqual(source.logger, logger);
    assert.notEqual(source.createQueryRunner, DataSource.prototype.createQueryRunner);
    provider.dispose();
    assert.equal(source.logger, logger);
    assert.equal(source.createQueryRunner, DataSource.prototype.createQueryRunner);
    const capture = new Capture('send', {}, false);
    await capture.run(() => source.getRepository(Item).insert({ id: 'plain', name: 'Plain' }));
    assert.deepEqual(capture.finish().capture.changes, [], 'a disposed provider records nothing');
  } finally {
    await source.destroy();
  }
});

test('dispose unwraps the shared SQLite query runner so another bench cannot capture twice', async () => {
  const source = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Item], synchronize: true }).initialize();
  const first = new TypeOrmPreview(source);
  const runner = source.driver.queryRunner;
  try {
    await first.run(manager => manager.getRepository(Item).insert({ id: 'one', name: 'One' }));
    assert.ok(Object.hasOwn(runner, 'query'), 'the singleton runner is instrumented while the provider is active');
    first.dispose();
    first.dispose();
    assert.equal(Object.hasOwn(runner, 'query'), false, 'dispose removes the instrumented query');

    const second = new TypeOrmPreview(source);
    const capture = new Capture('send', {}, false);
    await capture.run(() => second.run(manager => manager.getRepository(Item).insert({ id: 'two', name: 'Two' })));
    const recorded = capture.finish().capture;
    assert.deepEqual(recorded.changes.map(change => change.key), [{ id: 'two' }]);
    assert.equal(recorded.logs.filter(log => log.sql && /^INSERT INTO/.test(log.sql.text)).length, 1);
  } finally {
    await source.destroy();
  }
});

test('a disposed provider stays inert when another provider already wrapped the shared runner', async () => {
  const source = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Item], synchronize: true }).initialize();
  const first = new TypeOrmPreview(source);
  try {
    await first.run(manager => manager.getRepository(Item).insert({ id: 'one', name: 'One' }));
    const second = new TypeOrmPreview(source);
    await second.run(manager => manager.getRepository(Item).insert({ id: 'two', name: 'Two' }));
    first.dispose();
    const capture = new Capture('send', {}, false);
    await capture.run(() => second.run(manager => manager.getRepository(Item).insert({ id: 'three', name: 'Three' })));
    assert.deepEqual(capture.finish().capture.changes.map(change => change.key), [{ id: 'three' }]);
  } finally {
    await source.destroy();
  }
});
