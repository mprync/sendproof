# sendproof-sqlalchemy

Rollback previews, SQL capture and ORM change capture for [Sendproof](../../spec/README.md)
applications that use SQLAlchemy 2.x.

```python
from sendproof_sqlalchemy import SQLAlchemyPreview

provider = SQLAlchemyPreview(engine, database="inventory_dev")   # Engine or AsyncEngine
```

Pass the provider to a framework adapter, for example `Sendproof(app, provider=provider, ...)`.
Install `sendproof-sqlalchemy[asyncio]` for `AsyncEngine` support (needs `greenlet`).
`database` is a public label; never put a connection string in it.

## What a preview guarantees

While a preview runs, every `Session` and `Connection` of the request that uses a registered
engine shares **one** database connection. A hook on the engine's `raw_connection()` provides it
only inside a preview; other requests are untouched. On that connection:

- `commit` releases an internal `SAVEPOINT`, so the writes stay visible to the rest of the request
  (commit-then-`refresh`, a second `Session` in a dependency, and so on) but are never durable.
- `rollback` rolls back to that savepoint, so a handler that commits and then fails behaves as it
  would for real.
- At the end the adapter performs a real rollback and confirms it. If the database refuses, the
  adapter withholds the success envelope and the connection is invalidated rather than reused.

An independent read after the preview, from a separate request or connection, finds the data
unchanged.

## Change capture

Inserts, updates and deletes flushed through the ORM `Session` become changes with the table, the
primary key and before/after column snapshots (keys use column names). Observed Send records the
same changes while committing normally.

## Coverage notes

Read these before advertising an operation for Preview.

- **Not captured:** Core DML (`session.execute(update(...))`), ORM bulk operations, raw SQL,
  database triggers and cascades performed by the database. Their SQL appears in the logs and
  they are still rolled back, but no rows are shown. Rows are never synthesized.
- **One connection per engine:** statements that run concurrently inside a single preview share a
  connection and its locks. With SQLite, two previews at once block each other until the first
  rolls back; PostgreSQL and MySQL do not.
- **Verified dialects:** SQLite, PostgreSQL and MySQL. The ANSI savepoint path also permits
  MariaDB and Oracle, which have yet to be exercised by the conformance matrix. Other dialects
  make Preview unavailable.
- **Refused:** engines or connections in `AUTOCOMMIT` mode, because the driver commits each
  statement itself.
- **Transaction-control SQL is refused before it is sent:** `COMMIT`, `ROLLBACK` (but not
  `ROLLBACK TO SAVEPOINT`), `BEGIN`, `SET autocommit` in any form, `XA`, and the internal
  `sendproof_preview` savepoint. On MySQL and MariaDB also every implicitly committing statement
  (DDL other than `TEMPORARY` tables, `LOCK`/`UNLOCK TABLES`, `GRANT`, `REVOKE`, `ANALYZE`,
  `CHECK`, `OPTIMIZE`, `REPAIR` and `CACHE INDEX` on tables, `SET PASSWORD`, replication control),
  SQL-level `PREPARE` and `EXECUTE` (and MariaDB's `EXECUTE IMMEDIATE`), executable comments (`/*! ... */`) that contain any
  of these, and `CALL`. The Preview then answers 500 and rolls back.
- **Stored procedures (MySQL and MariaDB):** a procedure can `COMMIT`, so `CALL` is refused unless
  you declare the procedure safe by exact name:

  ```python
  SQLAlchemyPreview(engine, safe_procedures=["refresh_totals", "reports.rebuild_cache"])
  ```

  Names are exact (a schema-qualified call needs the qualified name) and, like MySQL,
  case-insensitive; wildcards are rejected. This is your statement that the procedure never
  commits: the binding trusts it.
- **Backstop (MySQL and MariaDB):** the Preview opens its transaction with
  `SAVEPOINT sendproof_preview` and, before rolling back, checks that savepoint still exists. Any
  commit erases it, so if something committed anyway (a declared procedure that does commit, a
  driver call around the engine), the Preview answers 500 without confirmation, whatever the
  handler returned. The writes made before that commit are durable; the check only stops the
  Preview from claiming otherwise.
- **Deadlocks (MySQL and MariaDB):** a deadlock (1213), or a lock wait timeout (1205) with
  `innodb_rollback_on_timeout` on, rolls back the whole Preview transaction. The handler still gets
  the original error, but every later statement in that Preview is refused before it is sent (a
  retry would run outside the transaction, and with autocommit on commit for real), and the
  Preview answers 500 without confirmation. The lock wait timeout case shares the deadlock code
  path and is covered by unit tests only, because `innodb_rollback_on_timeout` can be set only at
  server startup.
- **Outside the database:** caches, files, other services, other engines you did not register and
  work queued after the response are not rolled back. Sequences may advance.
- **Connections the application holds across requests** are not enrolled.
- Other engines you registered are enrolled separately but are not coordinated, as with any
  non-distributed transaction.

## Redaction

SQL parameter values are shown only in the Development environment (override with the adapter's
`include_sql_parameter_values`). A parameter whose name contains a secret word (`password`, `secret`,
`token`, `hash`, `salt`, `credential`, `apikey`, or `key` after `api`, `private`, `secret`,
`access`, `signing`, `encryption`, `client`) shows `[REDACTED]`. If the statement itself mentions
such a word, every value in it is hidden.
