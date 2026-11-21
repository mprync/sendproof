//! Axum integration for [Test Bench](https://github.com/test-bench/test-bench).
//!
//! Test Bench serves an interactive workbench for your OpenAPI document under `/bench/`
//! and can run any *declared* operation three ways:
//!
//! * **Send**: the real request, nothing special.
//! * **Observed Send**: the real request plus `Prefer: trace`; it commits normally and the
//!   response carries `X-TestBench-Trace`, naming a trace of changes, effects, logs and timing.
//! * **Preview**: the request is rewritten to `/bench/_preview/...`, dispatched in-process
//!   through your real router and middleware, run inside a transaction that is rolled back,
//!   and reported as a confirmed envelope.
//!
//! It is **off by default**: nothing is served unless the configured environment is listed in
//! [`ConfigBuilder::enable_in`](testbench_core::ConfigBuilder::enable_in).
//!
//! # Wiring
//!
//! ```no_run
//! use axum::{Router, routing::post};
//! use testbench_axum::{Config, TestBench, TestBenchRouterExt};
//!
//! # async fn create_item() {}
//! let bench = TestBench::new(
//!     Config::builder("Inventory")
//!         .environment("Development")
//!         .enable_in(["Development"])
//!         .preview_operation("POST", "/items")
//!         .build()
//!         .unwrap(),
//! );
//!
//! let api = Router::new()
//!     .route("/items", post(create_item))
//!     // Innermost: after this, add authentication and authorization layers with `route_layer`.
//!     .bench_gate(&bench);
//! let app: Router = bench.wrap(api);
//! ```
//!
//! # Layer order matters
//!
//! The gate enrolls the request in the preview *after* it has been authorized. Add
//! [`bench_gate`](TestBenchRouterExt::bench_gate) **first** and your authentication and
//! authorization `route_layer`s **after** it, so they wrap it. Authorization performed in
//! handler extractors is not enough: a preview that is rejected there would already have
//! begun its transaction and could not be told apart from an application error.

mod gate;
mod service;

pub use gate::TestBenchRouterExt;
pub use service::TestBench;
pub use testbench_core::{Config, ConfigBuilder, ConfigError, Identity, TestBenchLayer};
