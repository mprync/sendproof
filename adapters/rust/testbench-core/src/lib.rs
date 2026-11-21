//! Framework-neutral core of the Test Bench protocol (v1).
//!
//! Test Bench lets an interactive workbench call an API three ways: a normal *Send*,
//! an *Observed Send* that commits and returns a trace, and a *Preview* that runs the real
//! handler inside a transaction that is rolled back and reports what would have happened.
//!
//! This crate has no web framework dependency. It holds:
//!
//! * [`Config`] and [`Identity`]: explicit, off-by-default configuration;
//! * [`capture`]: per-request capture of logs, effects, SQL and timing;
//! * [`provider`]: the contract a data layer implements to enroll an operation in a rollback;
//! * [`trace_store`]: short-lived, owner-scoped storage of observed-send traces;
//! * [`protocol`]: preferences, origin checks, discovery documents and envelopes;
//! * [`assets`]: the workbench UI, embedded at build time from the shared packed bundle.
//!
//! Use it through a framework adapter such as `testbench-axum`.

pub mod assets;
pub mod capture;
pub mod config;
pub mod headers;
pub mod limits;
pub mod model;
pub mod protocol;
pub mod provider;
pub mod redact;
pub mod trace_store;
pub mod transport;

#[cfg(feature = "tracing")]
mod layer;

#[cfg(feature = "tracing")]
pub use layer::TestBenchLayer;

pub use config::{Config, ConfigBuilder, ConfigError, Identity, Operation};
pub use headers::Headers;
pub use provider::{BoxError, BoxFuture, Changes, Observation, PreviewProvider, PreviewRequired, PreviewSession};
pub use transport::{Core, Enrollment, Failure, Inner, ObservedSend, Ordinary, PreviewState, Reply, Route};
