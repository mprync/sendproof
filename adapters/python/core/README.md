# sendproof-core

Framework-neutral core of the Sendproof Python adapters. Install a framework package such as
`sendproof-fastapi` rather than using this directly. Use it to:

- record effects from application code, and
- write an adapter for another framework or a data layer for another database library.

## Recording effects

Call these at the point where your application delivers an email, publishes a message or calls
another service. Each returns `True` when the request is a rollback preview and you must **skip**
the delivery. During an Observed Send they record the intent as `delivered: true` and return
`False`, so you still deliver.

```python
from sendproof_core import record_email

if not record_email("Welcome", sender, [to], [], "Welcome", "Hello!"):
    mailer.send(...)
```

`record_http`, `record_job`, `record_message` and `record_effect` follow the conventional data
shapes in the protocol. Ordinary `logging` records from loggers that propagate to the root logger
are captured too (set the logger level to `INFO` or lower to see them).

## Data stores

`sendproof_core.stores` holds the write guard and the MongoDB, Redis and DynamoDB hooks that the
framework packages accept as `data_stores`. Each hook imports its client library on first use, so
the core still needs none of them. See [Data stores in the Python binding](../data-stores.md).

## Capture limits

Logs 500, effects 100, changes 200, log properties 32, SQL parameters 64. Anything beyond a limit is
dropped and flagged with `logsTruncated`, `effectsTruncated` or `changesTruncated`. Unserializable
effect data is replaced by `null` and flagged. SQL parameters named like secrets show `[REDACTED]`,
and parameter values are hidden outside Development unless you opt in.

## Redaction

A name is secret when one of its words is `password`, `passwd`, `pwd`, `secret`, `token`, `hash`,
`salt`, `credential(s)` or `apikey`, when `key` follows `api`, `private`, `secret`, `access`,
`signing`, `encryption` or `client`, or when `key`, `data`, `id` or `token` follows `session`.
Secret-named SQL parameters, every value of a statement that names a secret (for example any
statement on Django's `django_session` table), and secret-named columns in change snapshots
(`key`, `before`, `after`) always show `[REDACTED]`. Records from the `sqlalchemy.engine` and
`django.db.backends` loggers are not captured, because they print bound values; the providers
record each statement themselves with redaction applied.

## Commit guard

While a preview runs, providers refuse SQL that would end its transaction (`COMMIT`, `END`,
`ROLLBACK` without `TO`, `SET autocommit`, the provider's own savepoint, and DDL that MySQL,
MariaDB and Oracle commit implicitly) and refuse switching the connection to autocommit. The
statement raises `PreviewRollbackError` before it reaches the database and the preview answers an
unconfirmed 500 (`sendproof_core.txguard`).

## Writing a data-layer provider

Subclass `PreviewProvider`. `begin(scope)` must be cheap and synchronous, store its state in
`scope.extensions`, and return a `PreviewSession` whose `rollback()` raises
`PreviewRollbackError` when it cannot confirm the rollback and whose `close()` releases everything,
partially acquired resources included. Raise `PreviewUnavailable` from `begin` when the
operation cannot be enrolled, for example when a connection autocommits. Never fabricate
before/after rows: report only what you observed.

## Writing a framework adapter

Use `Workbench` for discovery, assets, traces and envelopes, `protocol` for the request
rules, `Capture`/`RequestScope` for per-request state, and `TraceStore` for traces. The
[FastAPI adapter](../fastapi/src/sendproof_fastapi/middleware.py) is a complete example.
