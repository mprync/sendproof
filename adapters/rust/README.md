# Sendproof for Rust

Sendproof adds an API workbench to your service and lets you run any *declared* operation three ways: a normal **Send**, an **Observed Send** that commits and returns a trace, and a **Preview** that runs the real handler inside a transaction that is rolled back and reports what would have happened (row changes with before/after images, suppressed effects, logs, SQL).

| Crate | Purpose |
| --- | --- |
| [`sendproof-core`](sendproof-core) | Framework-neutral protocol: capture, limits, redaction, trace store, discovery, embedded UI. |
| [`sendproof-axum`](sendproof-axum) | Axum integration: workbench mount, in-process preview dispatch, gate, observed send. |
| [`sendproof-actix`](sendproof-actix) | Actix Web integration: the same transport on Actix middleware, plus the gate. |
| [`sendproof-sqlx`](sendproof-sqlx) | SQLx data layer for SQLite, PostgreSQL and MySQL: transaction rollback, ordered row capture, statement capture with redaction. |
| [`sendproof-redis`](sendproof-redis), [`sendproof-dynamodb`](sendproof-dynamodb), [`sendproof-mongodb`](sendproof-mongodb) | Data stores: a Redis write guard, a DynamoDB write guard (AWS SDK interceptor) and MongoDB Preview (a transaction that is aborted) with a write guard. See [data-stores.md](data-stores.md). |
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

## Preview sessions

Both framework adapters advertise `previewSessions` automatically when Sendproof is enabled and every registered rollback-capable store supports held transactions. Gate the routes that journeys use, including GET routes, so each request joins the held transaction after authorization. A GET may run in a session unless marked with `preview_unavailable`. Write operations still need `preview_operation`.

Open a session with `POST /sendproof/_api/sessions` and pass its ID as `Sendproof-Session` on Preview requests. Signed-in callers need an identity resolver that returns a stable `subject`. Sessions take one request at a time, stay in one process, and expire after five minutes idle or thirty minutes total. The limits are four sessions per owner and sixteen per application. Call `bench.shutdown_sessions().await` after graceful server shutdown and before closing database pools to await rollback.

## Journey file discovery

Register a paired Arazzo 1.1 document and Sendproof expectations document with `ConfigBuilder::journey_file`:

```rust
Config::builder("Inventory")
    .path_base("/tenant") // omit when the API is mounted at the root
    .open_api_url("/openapi.json")
    .journey_file(
        "inventory",
        include_bytes!("../Journeys/inventory.arazzo.json").to_vec(),
        include_bytes!("../Journeys/inventory.expect.json").to_vec(),
    )
    .build()?;
```

The name is the route stem, without a suffix. Capabilities use the Arazzo `info.title` as the display name, falling back to the route stem. Each root-relative source URL is prefixed with the configured mount; distinct URLs and absolute URLs are preserved. The Arazzo document must contain an OpenAPI `sourceDescriptions` entry. The paired documents are advertised in capabilities and served from `/sendproof/journeys/{name}.arazzo.json` and `/sendproof/journeys/{name}.expect.json`. Unregistered names and suffixes return no document. The conformance fixture references `/openapi.json` in its Arazzo file and includes a minimal expectations pair in `examples/rust-conformance-common/Journeys/`.

## Safety model

* **Off by default.** Nothing is served unless the configured environment is in `enable_in`. When disabled, `/sendproof/**` and previews answer as if absent and ordinary routes are untouched.
* **Explicit opt-in per operation.** Declare operations with `preview_operation`. A session can also Preview GET routes that are gated and available. The outer transport and matched-route gate check eligibility, and the data layer refuses to run an unenrolled Preview.
* **Real authorization.** The rewritten request goes through your router and middleware in-process; the gate runs after your auth layers. A `workbench_policy` gates previews too, not only the workbench and observed sends.
* **Gate every route.** A route the gate does not wrap answers a preview with `409` and logs a warning; effects recorded through `sendproof_core::capture` are suppressed even there, but anything else such a handler does is real.
* **No commit escapes a preview.** Statements that would end the transaction are refused before they are sent, whether through named queries or plain SQLx on the handler's connection, which is never handed out raw (see `sendproof-sqlx`).
* **Real rollback, independently checked.** SQL runs in a real transaction that is rolled back; the envelope is returned only after the rollback succeeds. A failed rollback, panic, oversized response (>1 MiB), or an unauthorized/unknown target never yields a confirmed result.
* **Observed Send** needs an authenticated identity with a stable `subject`; traces are owner-only, kept 5 minutes by default (`trace_retention`), 8 per owner and 32 per host.
* Capture is bounded (500 logs, 100 effects, 200 changes) and SQL parameter values follow redaction rules (`password`, `token`, `api_key`, ... are `[REDACTED]`; values are only shown when `include_sql_parameter_values` is on, which defaults to `Development`). The same rules hide secret-named columns in change snapshots and secret-named fields of captured `tracing` events.

## Build and test

```sh
adapters/rust/scripts/pack-assets.sh        # packs the shared UI (needs Node) into sendproof-core/ui-assets
cargo test --locked --manifest-path adapters/rust/Cargo.toml --workspace --all-features
cargo build --locked --manifest-path adapters/rust/Cargo.toml -p rust-conformance -p rust-conformance-actix
node tests/conformance/run.mjs rust-axum rust-actix
BENCH_POSTGRES_URL=postgresql://… BENCH_MYSQL_URL=mysql://… BENCH_MARIADB_URL=mysql://… \
  node tests/conformance/run.mjs rust-axum-postgresql rust-actix-postgresql rust-axum-mysql rust-actix-mysql \
    rust-axum-mariadb rust-actix-mariadb
```

The workspace suite uses the PostgreSQL and MySQL URLs when set and skips live store tests when their service is unavailable. The HTTP runner starts the built fixtures and provisions its own disposable databases. The SQLite conformance bindings also exercise the stores listed in the manifest. Set `BENCH_STORES` to a comma-separated subset when running against fewer services.

`build.rs` embeds the packed UI. Without it the crate still builds and the workbench answers `503`. The UI source is never copied into this tree. Requires Rust 1.94+.
