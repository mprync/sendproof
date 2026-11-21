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
