# sendproof-activerecord

ActiveRecord preview provider for [Sendproof](../README.md).

```ruby
config.sendproof.use Sendproof::ActiveRecord::Provider.new                      # default connection
config.sendproof.use Sendproof::ActiveRecord::Provider.new(
  database: "inventory_dev",                                                     # display label only
  connection_classes: [ApplicationRecord, AnalyticsRecord]                       # every database the handler writes
)
```

## How a preview works

1. Before the request is dispatched, a **non-joinable transaction** begins on each listed connection's leased connection. The handler's own `transaction` blocks become savepoints; they cannot commit it.
2. Model callbacks (`after_create`, `after_update`, `after_destroy`) record `insert` / `update` / `delete` with the real primary key (composite keys included) and before/after snapshots. A change rolled back by the handler's own savepoint is removed.
3. `sql.active_record` notifications become SQL log entries. Values are shown only when `include_sql_parameter_values` allows it, and any statement or parameter whose name contains a secret word (`password`, `token`, `api_key`, `hash`, …) is `[REDACTED]`.
4. After the handler returns, the session rolls back, verifies that the transaction is rolled back (a handler that committed it makes the preview fail instead of confirming), and releases the connection state.

## Coverage

Rollback covers every statement on the enrolled connections. The **diff** covers what model callbacks see. `update_all`, `delete_all`, `insert_all`, `touch`, raw SQL and database triggers still roll back, are never synthesized into before/after rows, and cause a `Warning` log ("N write statement(s) bypassed model callbacks"). `after_commit` callbacks run at each inner transaction boundary (Rails treats a non-joinable parent like a transactional test), so send their side effects through `Sendproof.deliver`. Databases the provider does not list, other threads, caches, files and external services are not enrolled.

Tested with ActiveRecord 8.0.5.2 on SQLite and, through Trilogy, MySQL 8.4. `rowsAffected` is omitted because `sql.active_record` does not report affected rows for writes.

## Transaction control and MySQL

- A handler statement that would end or escape the Preview transaction (`COMMIT`, `END`, `ROLLBACK` without `TO`, `BEGIN`, `SET autocommit` anywhere in a `SET`, the provider's `sendproof_preview` savepoint, and on MySQL and MariaDB the statements that commit implicitly, SQL-level `PREPARE` and `EXECUTE` (and MariaDB's `EXECUTE IMMEDIATE`), executable comments containing any of these, and `CALL`) is refused before it reaches the database, and the Preview answers 500 without confirmation. `SAVEPOINT` stays allowed. Statements sent on `connection.raw_connection` are not covered.
- **Stored procedures (MySQL and MariaDB).** A procedure can `COMMIT`, so `CALL` is refused unless you declare the procedure safe by exact name (optionally `schema.name`; case-insensitive like MySQL; no wildcards). The binding trusts the list: a listed procedure that commits makes the Preview's writes durable, and the backstop below then answers 500.

  ```ruby
  config.sendproof.use Sendproof::ActiveRecord::Provider.new(safe_procedures: %w[refresh_totals reports.rebuild_cache])
  ```

- **Backstop (MySQL and MariaDB).** The Preview opens its transaction at once with `SAVEPOINT sendproof_preview` and, before rolling back, rolls back to it. Any commit, explicit or implicit, erases every savepoint (and with autocommit off MySQL then opens a new transaction by itself, so only a savepoint made at the start proves anything), so a Preview whose transaction was committed anyway, for example on `raw_connection`, answers 500 without confirmation. The writes before that commit are durable; the check only stops the Preview from claiming otherwise.
- **Deadlocks (MySQL and MariaDB).** A deadlock (1213), or a lock wait timeout (1205) with `innodb_rollback_on_timeout` on, rolls back the whole Preview transaction, and Rails runs MySQL with autocommit on outside `BEGIN`, so a retry would commit for real. The handler still gets the original error (`ActiveRecord::Deadlocked`), but every later statement in that Preview is refused before it is sent, and the Preview answers 500 without confirmation.
- On MySQL and MariaDB, one Preview runs at a time in each process: InnoDB deadlocks (1213) when three or more Previews insert the same new key and the first rolls back. Pass `serialize_previews: true` or `false` to override. See [data stores](../data-stores.md#mysql-previews-take-turns).
- Without prepared statements (MySQL), Active Record inlines parameter values into the SQL text, so a statement that names a secret, or any statement when parameter values are hidden, is logged with every literal replaced by `?`.
- `Provider.new(system: "mariadb")` names the SQL system for discovery; by default it comes from the adapter (`sqlite`, `postgresql`, `mysql`, `mssql`).
