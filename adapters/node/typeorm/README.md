# @test-bench/typeorm

Wrap the TypeORM `DataSource` your application already owns. Preview runs participating handlers on an enrolled `EntityManager` inside a transaction that is always rolled back; Send leaves the ordinary manager in use.

```ts
import { TypeOrmPreview } from '@test-bench/typeorm';

const database = new TypeOrmPreview(dataSource);
const item = await database.run(manager => manager.getRepository(Item).findOneBy({ id }));
await database.run(manager => manager.getRepository(Item).update({ id }, { name: 'Bolt' }));
```

Pass `database` as the framework's preview provider and route application queries through `run`. Await each operation before returning the response. On SQLite drivers, which share one connection, `run` also lets an ordinary request wait for a Preview's connection lease; PostgreSQL and MySQL use pooled connections and do not queue.

## Row changes

Changes come from Entity metadata. The primary columns of the mapped table that a write targets identify the rows, so handlers pass no key lists. Before and after each `INSERT`, `UPDATE`, `DELETE` or `REPLACE` statement, the provider reads the target table and reports the rows whose primary-key tuple appeared, disappeared or changed. That covers `insert`, `update`, `delete`, `save`, `remove`, `softDelete`, query builder writes, bulk writes and raw SQL aimed at a mapped table, including composite primary keys. Values are keyed by entity property name.

Scope, stated plainly:

- **Bulk writes** report one change per affected row, up to the core capture limits.
- **Triggers and cascades** are row changes only when they write to the table the statement named. Writes to any other table, and any table without an Entity, appear in the SQL log and not as row changes.
- **Large tables:** a table above `maxTrackedRows` (default 5000, set with `new TypeOrmPreview(source, { maxTrackedRows })`) is not diffed. The capture is marked truncated and the write still appears as SQL.
- **Cost:** each write to a mapped table adds two bounded `SELECT *` reads, so a handler issuing many writes to one large table does proportionally more work.
- **Statement order:** changes record each statement in order. A row written inside a savepoint that the handler later rolls back is still listed, and the transaction as a whole is still rolled back.
- **Send** diffs around each statement without a transaction, so concurrent writers to the same table can appear in one request's changes.

`track(entity, keys, operation)` remains as a deprecated alias of `run`; the keys are ignored.

## Logging, pool and release

SQL capture wraps the application's logger and redacts positional bindings; every other logger method and every real query still reaches the application's logger. The provider's own snapshot reads are hidden from both. Use `withParameterNames` to label bindings for one awaited query. Preview creates its query runner through the source's pool, rolls back every transaction and savepoint the handler left open, and always releases the runner. A failed rollback or release marks the provider as needing recovery and rejects later work. On PostgreSQL, which aborts a transaction after any failed statement, each inspection read inside an enrolled transaction is fenced by a private savepoint, so a read that fails (for example a role without `SELECT`) marks the capture truncated and leaves the handler's own statements running. Call `dispose()` to restore the original logger and query runner factory; on SQLite it also unwraps the shared query runner, and a disposed provider never captures, so another bench on the same source cannot record a statement twice.

## Verification

Drivers exercised: `better-sqlite3`, `pg` (PostgreSQL) and `mysql2` (MySQL). Other TypeORM drivers are untested; SQL Server is not supported by the fixture. The package tests live in `adapters/node/tests/typeorm.test.mjs`. They run nine checks per database against real SQLite, PostgreSQL and MySQL, a PostgreSQL failed-inspection regression, plus six SQLite or provider-wide checks, and a strict declaration check in `typeorm-types.test.mjs`. Set `BENCH_POSTGRES_URL` and `BENCH_MYSQL_URL` to run the server databases; each run creates and drops its own database. The conformance fixture, `examples/fixture-typeorm.mjs`, honours `BENCH_DATABASE` (`sqlite`, `postgresql`, `mysql`) and `BENCH_DATABASE_URL` and creates its own table.
