# testbench-core

Framework-neutral core of the Test Bench Python adapters. Install a framework package such as
`testbench-fastapi` rather than using this directly. Use it to:

- record effects from application code, and
- write an adapter for another framework or a data layer for another database library.

## Recording effects

Call these at the point where your application delivers an email, publishes a message or calls
another service. Each returns `True` when the request is a rollback preview and you must **skip**
the delivery. During an Observed Send they record the intent as `delivered: true` and return
`False`, so you still deliver.

```python
from testbench_core import record_email

if not record_email("Welcome", sender, [to], [], "Welcome", "Hello!"):
    mailer.send(...)
```

`record_http`, `record_job`, `record_message` and `record_effect` follow the conventional data
shapes in the protocol. Ordinary `logging` records from loggers that propagate to the root logger
are captured too (set the logger level to `INFO` or lower to see them).

## Capture limits

Logs 500, effects 100, changes 200, log properties 32, SQL parameters 64. Anything beyond a limit is
dropped and flagged with `logsTruncated`, `effectsTruncated` or `changesTruncated`. Unserializable
effect data is replaced by `null` and flagged. SQL parameters named like secrets show `[REDACTED]`,
and parameter values are hidden outside Development unless you opt in.

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
[FastAPI adapter](../fastapi/src/testbench_fastapi/middleware.py) is a complete example.
