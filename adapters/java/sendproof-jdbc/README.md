# sendproof-jdbc

Framework-neutral JDBC integration for frameworks without an ambient transaction (Ktor, Javalin, Micronaut without
`@Transactional`, plain servlets). It works with any JDBC access layer: plain JDBC, Exposed, jOOQ, JDBI.

## Use it

```kotlin
val dataSource = PreviewDataSource(hikari) { environmentIsDevelopment }   // give THIS to your data access code
val provider = JdbcPreviewProvider(dataSource) { "inventory_dev" }        // non-secret label, never a URL
```

During a preview every borrower of `dataSource` on the request receives the preview's **one connection**, with
auto-commit off. `commit()` and `close()` on it do nothing; the preview rolls back and then releases the real
connection. Outside a preview `PreviewDataSource` behaves like the pool. `PreviewDataSource(hikari)` without a
`showValues` supplier hides every bound value.

Anything that would end the preview's transaction is refused and the preview is answered with a 500 instead of a
confirmation: `COMMIT`, `ROLLBACK` (but not `ROLLBACK TO SAVEPOINT`), `BEGIN`/`START TRANSACTION`, `SET AUTOCOMMIT`,
DDL (which H2, MySQL and Oracle commit implicitly), a `commit()`, `close()` or `setAutoCommit(true)` that reaches the
connection through `Statement.getConnection()`, and `unwrap` to the driver's connection.

### MySQL and MariaDB

On MySQL and MariaDB the preview also refuses, before sending:

- the rest of MySQL's [implicit-commit list](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html):
  `LOCK TABLE(S)`, `ANALYZE`, `OPTIMIZE`, `REPAIR`, `CHECK`, `FLUSH`, `RESET`, `LOAD`, `CACHE INDEX`, `SET PASSWORD`,
  plugin and replication statements, and every spelling of `SET autocommit` (`SET @@session.autocommit`, a later
  assignment in a list);
- SQL-level `PREPARE` and `EXECUTE` (including MariaDB's `EXECUTE IMMEDIATE`), which can run any of these from a
  string;
- `CALL`, because a stored procedure can commit, including the JDBC escape `{call p(?)}`;
- `SAVEPOINT`, `RELEASE SAVEPOINT` and `ROLLBACK TO` of `sendproof_preview`, and the JDBC `setSavepoint`,
  `releaseSavepoint` and `rollback(Savepoint)` calls naming it (see the backstop below).

The check reads SQL as MySQL does: the body of a `/*! ... */` or `/*M! ... */` comment is SQL, `#` starts a comment,
`--` starts one only before whitespace, and strings are read with and without backslash escapes.

Declare procedures that never commit by exact name to let a preview call them:

```kotlin
val provider = JdbcPreviewProvider(dataSource) { "inventory_dev" }.safeProcedures("audit_touch", "reports.refresh_totals")
```

> **Warning:** `safeProcedures` is your statement that the procedures never commit. Sendproof trusts it: a listed
> procedure that commits persists the preview's writes. Names match exactly (case-insensitively), with no wildcards.

### Savepoint backstop (every database)

On every database the preview makes savepoint `sendproof_preview` as soon as its transaction opens (`SAVE TRANSACTION`
on SQL Server), on the pool's connection so it never shows in the SQL log, and rolls back to it before the final
rollback. Any commit erases every savepoint, so a missing savepoint means something committed the preview's writes by
a route the checks above couldn't see (the driver's own connection, a trigger), and the preview answers 500 without
confirmation. A check made only at the end can't see a commit: MySQL has no `@@in_transaction`, and with auto-commit
off MySQL and SQL Server (`IMPLICIT_TRANSACTIONS`) open a new transaction after a commit, so even `@@TRANCOUNT` looks
open. Rolling back to the savepoint, rather than releasing it, also works in a PostgreSQL transaction a handled error
left aborted. A handler's own `rollback()` lets nothing escape; the savepoint is made again. Statements and JDBC
savepoint calls naming `sendproof_preview` are refused on every database.

### Deadlocks and aborted transactions

A MySQL or MariaDB deadlock (1213) or lock wait timeout (1205), a SQL Server deadlock victim (1205), or any SQL
Server error that leaves `@@TRANCOUNT` at 0 (as under `XACT_ABORT ON`) rolls the whole preview transaction back, so a
retry would run outside it. Once the preview sees one, it refuses every further statement before sending, and the
preview answers 500 without confirmation; the handler still gets the database's original error. MySQL's 1205 counts
whether or not `innodb_rollback_on_timeout` is on.

The request must run with its `JdbcScope` current. Web adapters do this for you. A coroutine framework must carry the
thread-local across thread hops, for example `JdbcScope.holder().asContextElement(scope)`.

## What is captured

- **SQL**: every statement with duration, rows affected and bound values (hidden unless `showValues` is true; values
  of secret-named columns or in secret-named statements are always `[REDACTED]`). Parameter names are inferred from
  the SQL.
- **Row changes** hide secret-named columns (`password_hash`, `api_key`, `refreshToken`) as `[REDACTED]` in the
  key, before and after values, and every value of a secret-named table (`api_tokens`).
- **Row changes**: JDBC has no change events, so single-row statements in these shapes are reported with before/after
  values by reading the row on the same connection: `insert into t (a, b) values (?, ?)`,
  `update t set a = ? where k = ?`, `delete from t where k = ?` (each `WHERE` term `column = ?`, joined by `AND`).
  Keys use the table's primary key. Expressions, subqueries, bulk predicates, batches and `Statement`
  literals are logged as SQL but are **not** row changes, and triggers are not observed.

## Limits

- Only connections borrowed through the `PreviewDataSource` are enrolled. Writes through any other connection persist.
- If application code calls `rollback()` on the shared connection (for example after catching an error), the whole
  preview transaction is rolled back at that point; captured changes made before it are still reported.
