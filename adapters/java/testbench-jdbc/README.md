# testbench-jdbc

Framework-neutral JDBC integration for frameworks without an ambient transaction (Ktor, Javalin, Micronaut without
`@Transactional`, plain servlets). It works with any JDBC access layer: plain JDBC, Exposed, jOOQ, JDBI.

## Use it

```kotlin
val dataSource = PreviewDataSource(hikari) { environmentIsDevelopment }   // give THIS to your data access code
val provider = JdbcPreviewProvider(dataSource) { "inventory_dev" }        // non-secret label, never a URL
```

During a preview every borrower of `dataSource` on the request receives the preview's **one connection**, with
auto-commit off. `commit()` and `close()` on it do nothing; the preview rolls back and then releases the real
connection. Outside a preview `PreviewDataSource` behaves like the pool.

The request must run with its `JdbcScope` current. Web adapters do this for you. A coroutine framework must carry the
thread-local across thread hops, for example `JdbcScope.holder().asContextElement(scope)`.

## What is captured

- **SQL**: every statement with duration, rows affected and bound values (hidden unless `showValues` is true; values
  of secret-named columns or in secret-named statements are always `[REDACTED]`). Parameter names are inferred from
  the SQL.
- **Row changes**: JDBC has no change events, so single-row statements in these shapes are reported with before/after
  values by reading the row on the same connection: `insert into t (a, b) values (?, ?)`,
  `update t set a = ? where k = ?`, `delete from t where k = ?` (each `WHERE` term `column = ?`, joined by `AND`).
  Keys use the table's primary key. Expressions, subqueries, bulk predicates, batches and `Statement`
  literals are logged as SQL but are **not** row changes, and triggers are not observed.

## Limits

- Only connections borrowed through the `PreviewDataSource` are enrolled. Writes through any other connection persist.
- If application code calls `rollback()` on the shared connection (for example after catching an error), the whole
  preview transaction is rolled back at that point; captured changes made before it are still reported.
