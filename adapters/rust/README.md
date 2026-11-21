# Sendproof for Rust

Sendproof adds an API workbench to your service and lets you run any *declared* operation three ways: a normal **Send**, an **Observed Send** that commits and returns a trace, and a **Preview** that runs the real handler inside a transaction that is rolled back and reports what would have happened (row changes with before/after images, suppressed effects, logs, SQL).

| Crate | Purpose |
| --- | --- |
| [`sendproof-core`](sendproof-core) | Framework-neutral protocol: capture, limits, redaction, trace store, discovery, embedded UI. |
| [`sendproof-axum`](sendproof-axum) | Axum integration: workbench mount, in-process preview dispatch, gate, observed send. |
| [`sendproof-actix`](sendproof-actix) | Actix Web integration: the same transport on Actix middleware, plus the gate. |
| [`sendproof-sqlx`](sendproof-sqlx) | SQLx data layer for SQLite, PostgreSQL and MySQL: transaction rollback, ordered row capture, statement capture with redaction. |
| [`../../examples/rust-conformance`](../../examples/rust-conformance), [`-actix`](../../examples/rust-conformance-actix), [`-common`](../../examples/rust-conformance-common) | The shared conformance fixtures (Axum and Actix + SQLx on SQLite, PostgreSQL or MySQL, chosen by `BENCH_DATABASE`). |

Status: `0.1.0-alpha.1`. Tested: Axum 0.8 and Actix Web 4.20 with SQLx 0.9 on SQLite, PostgreSQL 17 and MySQL 8. Each backend captures rows differently, and MySQL captures less; see [`sendproof-sqlx`](sendproof-sqlx/README.md). Not implemented: Diesel and SeaORM.

## Quick start

```rust
use axum::{Json, Router, routing::post};
use sendproof_axum::{Config, Identity, Sendproof, SendproofRouterExt};
use sendproof_sqlx::{Db, DbError, SqliteProvider};

let bench = Sendproof::new(
    Config::builder("Inventory")
        .environment("Development")
        .enable_in(["Development"]) // off unless listed
        .preview_operation("POST", "/items")
        .provider(SqliteProvider::new(pool.clone()).database("inventory.db"))
        .identity(|headers| async move { /* resolve the signed-in user */ None::<Identity> })
        .build()?,
);

let api = Router::new()
    .route("/items", post(create_item)) // handlers take `db: Db`
    .bench_gate(&bench)                  // 1. gate first ...
    .route_layer(auth_layer)             // 2. ... then authentication/authorization around it
    .with_state(state);
let app = bench.wrap(api);               // serve this router
```

Open `http://localhost:3000/sendproof/`.

## Safety model

* **Off by default.** Nothing is served unless the configured environment is in `enable_in`. When disabled, `/sendproof/**` and previews answer as if absent and ordinary routes are untouched.
* **Explicit opt-in per operation.** Only operations declared with `preview_operation` can run in a preview, and each is checked three times: before dispatch, by the gate on the matched route, and by the data layer, which refuses to run an unenrolled preview.
* **Real authorization.** The rewritten request goes through your router and middleware in-process; the gate runs after your auth layers. A `workbench_policy` gates previews too, not only the workbench and observed sends.
* **Gate every route.** A route the gate does not wrap answers a preview with `409` and logs a warning; effects recorded through `sendproof_core::capture` are suppressed even there, but anything else such a handler does is real.
* **No commit escapes a preview.** Named queries that would end the transaction are refused, and SQLite and PostgreSQL also refuse raw commits (see `sendproof-sqlx`).
* **Real rollback, independently checked.** SQL runs in a real transaction that is rolled back; the envelope is returned only after the rollback succeeds. A failed rollback, panic, oversized response (>1 MiB), or an unauthorized/unknown target never yields a confirmed result.
* **Observed Send** needs an authenticated identity with a stable `subject`; traces are owner-only, kept 5 minutes by default (`trace_retention`), 8 per owner and 32 per host.
* Capture is bounded (500 logs, 100 effects, 200 changes) and SQL parameter values follow redaction rules (`password`, `token`, `api_key`, ... are `[REDACTED]`; values are only shown when `include_sql_parameter_values` is on, which defaults to `Development`). The same rules hide secret-named columns in change snapshots and secret-named fields of captured `tracing` events.

## Build and test

```sh
adapters/rust/scripts/pack-assets.sh        # packs the shared UI (needs Node) into sendproof-core/ui-assets
cargo test --locked --manifest-path adapters/rust/Cargo.toml --workspace --all-features
node tests/conformance/run.mjs rust-axum rust-actix                         # SQLite, from the repository root
BENCH_POSTGRES_URL=postgresql://… BENCH_MYSQL_URL=mysql://… \
  node tests/conformance/run.mjs rust-axum-postgresql rust-actix-postgresql rust-axum-mysql rust-actix-mysql
```

With `BENCH_POSTGRES_URL` and `BENCH_MYSQL_URL` set to a disposable server, the workspace runs 82 tests:

| Crate | Tests |
| --- | --- |
| `sendproof-core` | 21 unit, 1 doc |
| `sendproof-sqlx` | 22 unit, 8 SQLite, 10 PostgreSQL, 11 MySQL |
| `sendproof-actix` | 7, 1 doc |
| `sendproof-axum` | 1 doc |

Without the server variables, the 21 server tests are skipped and pass anyway. Build the fixtures before running the HTTP conformance suite (`cargo build -p rust-conformance -p rust-conformance-actix`), because the runner starts the binaries as they are.

`build.rs` embeds the packed UI. Without it the crate still builds and the workbench answers `503`. The UI source is never copied into this tree. Requires Rust 1.94+.
