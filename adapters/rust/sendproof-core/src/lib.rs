//! Framework-neutral core of the Sendproof protocol (v1).
//!
//! Sendproof lets an interactive workbench call an API three ways: a normal *Send*,
//! an *Observed Send* that commits and returns a trace, and a *Preview* that runs the real
//! handler inside a transaction that is rolled back and reports what would have happened.
//!
//! This crate has no web framework dependency. It holds:
//!
//! * [`Config`] and [`Identity`]: explicit, off-by-default configuration;
//! * [`capture`]: per-request capture of logs, effects, SQL and timing;
//! * [`provider`]: the contract a data layer implements to enroll an operation in a rollback;
//! * [`stores`]: the write guard and shared classification for data stores other than SQL (MongoDB,
//!   Redis, DynamoDB), which the `sendproof-mongodb`, `sendproof-redis` and `sendproof-dynamodb` crates hook;
//! * [`trace_store`]: short-lived, owner-scoped storage of observed-send traces;
//! * [`protocol`]: preferences, origin checks, discovery documents and envelopes;
//! * [`assets`]: the workbench UI, embedded at build time from the shared packed bundle.
//!
//! Use it through a framework adapter such as `sendproof-axum`.

pub mod assets;
pub mod capture;
pub mod config;
pub mod headers;
pub mod limits;
pub mod model;
pub mod protocol;
pub mod provider;
pub mod redact;
pub mod stores;
pub mod trace_store;
pub mod transport;

#[cfg(feature = "tracing")]
mod layer;

#[cfg(feature = "tracing")]
pub use layer::SendproofLayer;

pub use capture::{Blocked, DbEntry};
pub use config::{Config, ConfigBuilder, ConfigError, Identity, Operation, UnavailableOperation};
pub use headers::Headers;
pub use provider::{BoxError, BoxFuture, Changes, Observation, PreviewProvider, PreviewRequired, PreviewSession};
pub use stores::{CaptureScope, CommandKind, DataStore, NotEnrolled, PreviewFault, PreviewWriteBlocked, StoreDescription, StoreMode, StoreScope};
pub use transport::{Core, Enrollment, Failure, Inner, ObservedSend, Ordinary, PreviewState, Reply, Route};
