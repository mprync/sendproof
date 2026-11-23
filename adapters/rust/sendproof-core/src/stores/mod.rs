//! Data stores other than the SQL database: the write guard and the shared rules of
//! `spec/data-stores.md`.
//!
//! * [`tables`]: the shared classification tables, generated from `spec/data-stores/`.
//! * [`classify`]: pure classifiers for Redis commands and DynamoDB actions. (The MongoDB classifier
//!   lives in `sendproof-mongodb`, because it reads ordered BSON documents.)
//! * [`cql`] and [`search`]: pure classifiers for Cassandra statements and for Elasticsearch and
//!   OpenSearch requests (batch two), with the sanitizers their `Db` entries use.
//! * [`open`]: the Previews open on a store, which a write no request sent fails.
//! * [`guard`]: [`StoreScope`], the single decision point every store hook calls before it sends a
//!   command, and the errors it returns.
//! * [`attribution`]: whether a store write belongs to a request, and [`detached`] for work that
//!   belongs to none.
//! * [`DataStore`]: what a store hook registers with the protocol.

pub mod attribution;
pub mod classify;
pub mod cql;
pub mod guard;
pub mod open;
pub mod search;
mod store;
pub mod tables;

pub use attribution::{detached, is_attributed};
pub use classify::{CommandKind, classify_dynamo, classify_redis, partiql_verb};
pub use cql::{Classified, classify_cql, classify_cql_message, cql_target, sanitize_cql};
pub use guard::{
    CaptureScope, NotEnrolled, PreviewFault, PreviewWriteBlocked, StoreScope, exact_names, store_label, store_name, write_reason,
};
pub use open::OpenPreviews;
pub use search::{classify_search, sanitize_search_body, search_needs_body, search_target};
pub(crate) use store::HeldGuard;
pub use store::{DataStore, StoreDescription, StoreMode};
