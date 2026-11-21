# sendproof-sqlx

The SQLx (0.9) data layer for Sendproof. It runs a preview inside a real transaction that is rolled back, and captures each row the handler changed, with before and after images and the row's key. It supports SQLite, PostgreSQL and MySQL.

| Feature | Backend | Provider | Handler type |
| --- | --- | --- | --- |
| `sqlite` (default) | SQLite | `SqliteProvider` | `Db` (= `Db<Sqlite>`) |
| `postgres` | PostgreSQL 13+ | `PgProvider` | `Db<Postgres>` |
| `mysql` | MySQL 8 (InnoDB) | `MySqlProvider` | `Db<MySql>` |

Each provider is an alias of `SqlxProvider<B>`. Enable only the backends you use, so the others are never compiled.

```rust
async fn create(db: Db<Postgres>, Json(item): Json<Item>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;                  // preview tx, observed conn, or pooled conn
    conn.query("INSERT INTO items (id, name) VALUES (:id, :name)")
        .bind("id", &item.id)
        .bind("name", &item.name)
        .execute()
        .await?;
    Ok(StatusCode::CREATED)
}

let provider = PgProvider::new(pool.clone()).database("inventory");
```

`Db` is an Axum extractor with the `axum` feature (`Pool<B>: FromRef<State>`) and an Actix Web extractor with the `actix` feature (`web::Data<Pool<B>>` in `app_data`). For another framework, use `Db::from_enrollment(pool, enrollment, required)`. `DbConn` dereferences to the backend's connection, so plain SQLx (`.execute(&mut *conn)`) keeps working.

## What every backend guarantees

* **Rollback**: `begin_preview` starts a transaction on a pooled connection and hands it to the handler through request extensions. After the handler, the transaction is rolled back. The envelope is returned only once the rollback succeeds.
* **The handler cannot commit the preview**:
  * A named query (`conn.query`) that would end the transaction is refused before it runs, with `DbError::Query`: `COMMIT`, `END`, `ROLLBACK` (but not `ROLLBACK TO`), `BEGIN`/`START`, and PostgreSQL two-phase commit. On MySQL every statement that commits implicitly is refused too: only reads, DML, `SET` (except `autocommit`), savepoints and temporary tables run; DDL, `LOCK TABLES`, `PREPARE`/`EXECUTE` (including MariaDB's `EXECUTE IMMEDIATE`) and `CALL` (a procedure may commit) do not, and MariaDB's `SET STATEMENT ... FOR` is judged by its inner statement. The text is read as the server reads it (`#` and `-- ` comments, executable `/*! */` comments, PostgreSQL's nested comments and `E''` strings) under both readings of a backslash, and refused when either finds a refused statement. A refused statement fails the preview with `500` even when the handler catches the error. Observed sends run these statements normally.
  * Declare MySQL procedures that never commit with `SqlxProvider::new(pool).safe_procedure("name")` (exact `name` or `schema.name`, no wildcards); a preview may `CALL` those. **Warning:** a declared procedure that does commit keeps the handler's writes; the preview still fails.
  * After a MySQL deadlock (1213) or lock wait timeout (1205) the database has rolled the preview transaction back, so every later named query of that preview is refused (the handler still gets the original error) and the preview answers `500`.
  * Raw SQLx statements on SQLite cannot commit either: a commit hook turns every commit on the preview's connection into a rollback. On PostgreSQL a deferred constraint trigger makes a raw `COMMIT` fail and roll everything back.
  * **MySQL limit**: a *raw* SQLx statement that commits (explicitly or implicitly, such as DDL) cannot be stopped, and the writes before it become permanent. Run handler SQL through `conn.query` on MySQL. The same holds on PostgreSQL for a raw `ROLLBACK` followed by raw writes.
  * As a last check, a savepoint (`sendproof_preview`) is taken when the preview begins and rolled back to just before the final rollback. If the transaction ended anyway, that savepoint is gone, and the preview answers `500` without claiming a rollback; this also holds under MySQL `autocommit=0`, where a new transaction opens after a commit. A named query may not set, release or roll back to that savepoint.
* **Nested transactions**: `conn.begin()` returns a `DbTransaction` (a savepoint inside the preview). Its `query`, `commit` and `rollback` work as you would expect. Rolling it back, or dropping it uncommitted, also removes its changes from the capture.
* **Ordered changes**: changes are reported in the order they happened, capped at 200. Past the cap, or whenever the backend knows rows are missing from the list, the envelope sets `changesTruncated`.
* **Secret columns in changes**: in `before`, `after` and `key`, the values of secret-named columns (`password_hash`, `api_key`, `refresh_token`, …, by the same whole-word rules) are shown as `[REDACTED]`.
* **SQL capture and redaction**: `conn.query("... :name ...").bind("name", v)` reports each statement once, with its parameter names, values, duration and rows affected. Values are shown only when `include_sql_parameter_values` is on, and are always `[REDACTED]` when the parameter name or the statement looks secret (`password`, `token`, `api_key`, …). The provider's own bookkeeping statements never appear in the capture.
* **Safety**: a preview or observed request that reaches `Db` without being enrolled fails with `DbError::NotEnrolled` before anything runs.
* **Disposal**: every capture is removed when its request ends, including when the handler fails. A connection that could not be cleaned is closed rather than returned to the pool.

## How each backend captures rows

**SQLite.** SQLite's pre-update hook records every insert, update and delete, including rows written by triggers and bulk statements. `sqlite3_trace_v2` reports every statement, including raw SQLx ones. The hook also sees changes that a raw `ROLLBACK TO` later undoes; `DbTransaction::rollback` removes them.

**PostgreSQL.** When a capture begins, every table in the connection's `search_path` gets an `AFTER INSERT OR UPDATE OR DELETE` row trigger, created only on tables the connection holds `TRIGGER` privilege on. The trigger calls a session-temporary plpgsql function that writes `to_jsonb(OLD)` and `to_jsonb(NEW)` into a temporary, sequenced audit table. It covers raw SQLx statements, user triggers, bulk statements and cascades, and a rolled-back savepoint drops its own audit rows. The triggers fire only in the session holding the capture's random token (`current_setting('sendproof.capture')`), so other sessions are never captured.

* *Preview*: the triggers are created inside the preview transaction, so the rollback removes them and nothing is ever committed. Creating them takes `SHARE ROW EXCLUSIVE` locks (waiting at most 5 s), so other writers to those tables, and other previews, wait until the preview ends.
* *Observed Send*: the handler must commit as usual, so the triggers are committed in a short transaction before it runs and dropped afterwards. Concurrent writers are neither blocked nor captured (verified by a test). Leftovers are inert, because no other session has the token. They are dropped with the session, and the next capture also removes triggers whose session has ended.
* In a preview, each named statement runs inside its own savepoint. A failing statement, such as a unique violation the handler handles, then does not abort the whole preview, just as it would not in autocommit.
* The capture flags as incomplete any write to a table without a capture trigger: tables outside `search_path`, tables without `TRIGGER` privilege, or tables created during the request. It finds these through `pg_stat_xact_user_tables` (previews only).
* Raw SQLx statements are logged without parameters by `SendproofLayer` (`sqlx::query` events). `TRUNCATE` is not reported as row changes.

**MySQL.** DDL commits implicitly in MySQL, so triggers cannot be added inside a transaction. Rows are therefore captured per statement, for single-table writes run through `DbConn::query` or `DbTransaction::query`:

1. the rows the statement will touch are read with `SELECT JSON_OBJECT(...) ... FOR UPDATE`, which locks them;
2. the statement runs;
3. the rows are read again by primary key.

Recognized statements are `INSERT`/`REPLACE … VALUES` (including `IGNORE`, `ON DUPLICATE KEY UPDATE` and auto-increment keys), and single-table `UPDATE` and `DELETE` with `WHERE`/`ORDER BY`/`LIMIT`. Outside a transaction (an observed send in autocommit), the three steps run in a transaction of their own, so a concurrent writer cannot slip in between the reads.

* **Not captured on MySQL**: rows written by MySQL triggers or foreign-key actions; multi-table statements; `INSERT … SELECT`; and raw SQLx statements. The envelope sets `changesTruncated` when any of them may have written rows:
  * a recognized write fires a trigger for its event on that table (`information_schema.TRIGGERS`);
  * a recognized write fires a foreign-key action that writes child rows (`CASCADE`, `SET NULL` or `SET DEFAULT` in `information_schema.REFERENTIAL_CONSTRAINTS`). For an `UPDATE`, this counts only when it assigns a referenced column;
  * a raw SQLx statement changes rows (counted from `sqlx::query` events, so `SendproofLayer` must be installed);
  * a recognized statement affects more rows than were read.

  Trigger and foreign-key metadata is read once per table per request.
* Generated keys follow `LAST_INSERT_ID()` in steps of `@@session.auto_increment_increment`, read again for each insert, because the session may change it mid-request.
* A `REPLACE` that hits an existing row is reported as a delete followed by an insert, as SQLite does. An upsert that changes a row is reported as an update.
* Tables need a primary key for their rows to be captured.

## Limits

* One connection per request: acquire it once. A second `acquire` returns `DbError::Busy`.
* Tasks spawned from the handler share neither the enrolled connection nor the capture.
* A `SqlValue::Null` is bound as a text null. On PostgreSQL, compare it with `IS NULL`, or cast it (`:value::int`) when the column is not text.
* SQLite's trace callback uses a small amount of `unsafe` FFI (`src/sqlite/trace.rs`).

## Tests

`cargo test -p sendproof-sqlx --all-features` runs 51 tests:

* 22 unit tests: placeholder rewriting per dialect, MySQL statement recognition, key handling, side-effect rules, the change log;
* 8 SQLite end-to-end tests (`tests/preview.rs`);
* 21 server tests (`tests/servers.rs`): 10 against PostgreSQL and 11 against MySQL, run through a real Axum router.

The server tests run only when `BENCH_POSTGRES_URL` or `BENCH_MYSQL_URL` points at a server where the tests may create schemas or databases. Each test drops its own afterwards. Without the variables they print `skipped` and pass, so count them only when the variables are set. They cover:

* ordered insert/update/delete with before/after images;
* bulk statements;
* nested transactions (rolled back, dropped and committed);
* a handled failed statement inside a preview;
* a `COMMIT` or implicit commit inside a preview, which must not be confirmed (and, on SQLite and PostgreSQL, must not persist), and a named one, which is refused before it runs;
* an observed send with a concurrent writer on another connection;
* two overlapping observed sends;
* connections reused across many requests;
* a panicking observed handler;
* PostgreSQL trigger capture and trigger cleanup;
* MySQL upserts, replaces and generated keys (including a session `auto_increment_increment` changed mid-request);
* the MySQL incomplete flag for raw writes, trigger writes and `ON DELETE CASCADE`, and no flag when no trigger or foreign-key action applies.
