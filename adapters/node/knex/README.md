# @sendproof/knex

Use the Knex pool your application already owns. Pass a `KnexPreview` instance as the framework's preview provider and build queries from its `client`. Inserts, updates and deletes made through that client are captured with before and after rows, and nobody has to say which rows they touch. The package is strict TypeScript with generated declarations, verified against real SQLite, PostgreSQL, MySQL and SQL Server.

```ts
import { KnexPreview } from '@sendproof/knex';

const database = new KnexPreview(knex);

await database.client('items').insert({ id, name: 'Bolt' });
await database.client('items').where({ id }).update({ name: 'Nut' });
await database.client('items').whereIn('id', ids).delete();
```

`database.client` is the request's Knex client: the preview or `transaction()` connection, or the pool otherwise. Outside a capture it behaves exactly like Knex.

## How rows are found

The provider reads each table's primary key from the database catalog once and caches it. It never parses SQL.

- **Update and delete.** The builder's own conditions are reused as a `SELECT` of the table's rows, so `where`, `whereIn`, `whereRaw`, subqueries, aliases (`'items as i'`) and `increment()` all work. Inside a transaction the rows are locked (`FOR UPDATE` or the dialect's equivalent) so the rows read are the rows changed. Rows are listed in primary key order.
- **Insert.** Keys come from the data when it supplies every key column, including each row of a multi-row insert and `onConflict().merge()` upserts (an existing row is recorded as an update). For generated keys, use `.returning('id')` on PostgreSQL, SQLite and SQL Server. MySQL and SQLite report the identifier of a single inserted row on their own.
- **Whatever it cannot know** marks the captured changes as truncated and the statement still runs: an insert with generated keys and no `returning`, an insert from a subquery, a table without a primary key, a multi-row statement above `trackedKeyLimit` (default 500), and `truncate()`.

Raw SQL (`client.raw(...)`) is recorded in the SQL log but not as row changes. Name its rows yourself with the explicit form, which is also kept for compatibility:

```ts
await database.track({ table: 'items', keys: [id] }, client => client.raw('UPDATE items SET name = ? WHERE id = ?', ['Nut', id]));
```

`keys` take a bare value for a single-column key or an object for a composite key. `insertedKeys` names keys known only after the write, and `primaryKey` overrides the catalog for a view.

Builders created through `database.client` are tracked, including after chaining and `clone()`. A builder made from the raw pool (`database.untracked`) is not. Tracked statements in one transaction run one at a time so each sees its own before and after. When concurrent writers change the same rows outside a transaction, the snapshots can include their changes.

Tracking reads are not recorded as application SQL. On PostgreSQL they run in their own savepoint so a failed read cannot abort the preview. If SQL Server ends the transaction because a tracking read failed, the request stops with that error rather than continue outside its transaction.

## Transactions

Preview selects a request-local Knex transaction and confirms rollback after Knex acknowledges completion. Send uses the pool normally. `transaction(callback)` gives the application the same shape: it commits at the outermost level, and nested calls become retained savepoints. A released savepoint keeps its writes and its captured changes in the enclosing transaction, so a preview rollback still discards the writes. A failed savepoint rolls back alone and its changes are dropped from the capture. `database.depth` reports nesting. During Preview the operation cannot end the transaction: `commit()`, `rollback()` and any SQL that commits, rolls back or (on MySQL) commits implicitly are refused before sending, whether it comes from `raw`, the schema builder or a nested `transaction()`, and a Preview with a refused statement fails even if the operation catches the error. On MySQL and MariaDB `CALL` is refused too, because a stored procedure can commit; declare procedures that never commit with `new KnexPreview(knex, { safeProcedures: ['name', 'schema.name'] })` (exact names, no wildcards). **Warning:** a declared procedure that does commit keeps the handler's writes. After a MySQL deadlock or lock wait timeout, or a SQL Server deadlock victim error, the database has rolled the Preview transaction back: the handler gets the error, every later statement of that Preview is refused, and the Preview fails. As a backstop, every Preview sets the savepoint `sendproof_preview` when it starts and rolls back to it before rolling back (on SQL Server, `SAVE TRANSACTION` and `ROLLBACK TRANSACTION`); any commit, even one sent through the driver directly, erases it, so a missing savepoint fails the Preview. On SQL Server, `SET IMPLICIT_TRANSACTIONS OFF` is allowed and `ON` is refused. Use the provider's `client` for every query in a previewed operation; the root Knex instance is not enrolled. Set `retries` and `retryDelayMs` to run an outermost transaction again after a deadlock, serialization failure or lock timeout (PostgreSQL `40001`/`40P01`, MySQL 1213/1205, SQL Server 1205, SQLite busy). The callback runs again, so it must be safe to repeat.

## Redaction

Knex exposes positional SQL bindings. Their values are always recorded as `[REDACTED]`. For a specific awaited query, use `withParameterNames` to label the parameters.

## Preview sessions

Preview sessions hold one Knex transaction across requests on `better-sqlite3`, PostgreSQL, MySQL, MariaDB and SQL Server. Writes stay visible to later steps and roll back on rewind or session close. SQLite takes a write lock when the session opens. MySQL and MariaDB hold the provider's Preview turn until the session closes. SQL Server uses `CURRENT_TRANSACTION_ID()` to verify the held transaction because it cannot release savepoints.

## Dialects and tests

SQLite (`better-sqlite3`), PostgreSQL (`pg`), MySQL and MariaDB (`mysql2`) and SQL Server (`tedious`). `tests/knex.test.mts` runs 15 provider tests per database plus 2 rollback confirmation tests: 17 on SQLite alone and 62 with all four databases. Set `BENCH_POSTGRES_URL`, `BENCH_MYSQL_URL` or `BENCH_SQLSERVER_URL` to a server and each run creates and drops its own database. With the SQLite suite's 11 tests, the two packages pass 73 tests.
