# testbench-activerecord

ActiveRecord preview provider for [Test Bench](../README.md).

```ruby
config.test_bench.use TestBench::ActiveRecord::Provider.new                      # default connection
config.test_bench.use TestBench::ActiveRecord::Provider.new(
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

Rollback covers every statement on the enrolled connections. The **diff** covers what model callbacks see. `update_all`, `delete_all`, `insert_all`, `touch`, raw SQL and database triggers still roll back, are never synthesized into before/after rows, and cause a `Warning` log ("N write statement(s) bypassed model callbacks"). `after_commit` callbacks run at each inner transaction boundary (Rails treats a non-joinable parent like a transactional test), so send their side effects through `TestBench.deliver`. Databases the provider does not list, other threads, caches, files and external services are not enrolled.

Tested with ActiveRecord 8.0.5.2 on SQLite. `rowsAffected` is omitted because `sql.active_record` does not report affected rows for writes.
