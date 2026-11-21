//! Data stores other than the SQL database: the write guard and the shared rules of
//! `spec/data-stores.md`.
//!
//! * [`tables`]: the shared classification tables, generated from `spec/data-stores/`.
//! * [`classify`]: pure classifiers for Redis commands and DynamoDB actions. (The MongoDB classifier
//!   lives in `sendproof-mongodb`, because it reads ordered BSON documents.)
//! * [`guard`]: [`StoreScope`], the single decision point every store hook calls before it sends a
//!   command, and the errors it returns.
//! * [`attribution`]: whether a store write belongs to a request, and [`detached`] for work that
//!   belongs to none.
//! * [`DataStore`]: what a store hook registers with the protocol.

pub mod attribution;
pub mod classify;
pub mod guard;
mod store;
pub mod tables;

pub use attribution::{detached, is_attributed};
pub use classify::{CommandKind, classify_dynamo, classify_redis, partiql_verb};
pub use guard::{
    CaptureScope, NotEnrolled, PreviewFault, PreviewWriteBlocked, StoreScope, exact_names, store_label, store_name, write_reason,
};
pub use store::{DataStore, StoreDescription, StoreMode};
