# sendproof-core

Framework-neutral core of the Sendproof protocol v1. Use it to write a framework adapter or a data-layer provider; applications normally depend on [`sendproof-axum`](../sendproof-axum).

* `Config`: explicit, **off-by-default** configuration (`environment`, `enable_in`, `path_base`, auth providers, preview operations, trace retention).
* `capture`: per-request recording of logs, effects and SQL. Host code calls `capture::record_email(..)` and friends; they return `true` when the effect must be **suppressed** (a preview) and `false` when the host should proceed.
* `SendproofLayer` (`tracing` feature, default): copies `tracing` events of the current request into the capture.
* `PreviewProvider` / `PreviewSession` / `Observation`: the contract for a data layer. A provider must enroll the *whole* operation in a rollback-only unit of work before the handler runs, report changes, and roll back. It must refuse to touch data when `PreviewRequired` is on the request but its own session is not (see `sendproof-sqlx`).
* `trace_store::TraceStore`: owner-scoped, bounded, expiring traces on `tokio::time` (testable with a paused clock).
* `Core` and `transport`: the framework-neutral half of an adapter. Classification of request paths, preview validation, the workbench responses, observed sends, and the rollback-and-envelope logic. An adapter only rewrites the URI, dispatches in-process, buffers the response and converts a `Reply`. See `sendproof-axum` and `sendproof-actix` (about 300 lines each).
* `Headers`: a framework-neutral header copy, so the core does not depend on any HTTP crate's version (Actix Web 4 uses `http` 0.2, Axum `http` 1).
* `protocol`: `Prefer` parsing, same-origin check, target validation, capabilities document, envelope building.
* `assets`: the workbench UI embedded by `build.rs` from `ui-assets/` (`scripts/pack-assets.sh`) or `SENDPROOF_UI_DIR`.

Limits match the .NET adapters (see `limits`). Capture never interrupts the application: oversized payloads are dropped and flagged `*Truncated`.
