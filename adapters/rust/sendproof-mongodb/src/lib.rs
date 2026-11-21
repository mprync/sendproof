//! MongoDB Preview and write guard for [Sendproof](https://github.com/mprync/sendproof)
//! (`spec/data-stores.md`, "MongoDB in Preview").
//!
//! On a replica set or sharded cluster a Preview runs every command in **one transaction that is
//! aborted after the handler** (`preview` mode), and reports the document changes. On a standalone
//! server MongoDB can't run transactions, so the store runs in `guard` mode like Redis: reads run and
//! the first write blocks the Preview.
//!
//! The `mongodb` crate has no ambient session and no pre-send hook, so the binding is a guarded handle:
//!
//! ```no_run
//! # async fn demo() -> mongodb::error::Result<()> {
//! use mongodb::{bson::doc, options::ClientOptions};
//! use sendproof_mongodb::MongoStore;
//!
//! let options = ClientOptions::parse("mongodb://localhost:27017/?replicaSet=rs0").await?;
//! // Installs command monitoring on the options, then connects. Register it:
//! // Config::builder("Inventory").data_store(store.clone())
//! let store = MongoStore::builder(options, "catalog").name("catalog").expect("a display label").build()?;
//!
//! // In a handler, take the `Mongo` extractor and use its collections like the driver's:
//! # let mongo = store.detached();
//! let documents = mongo.collection::<mongodb::bson::Document>("documents");
//! documents.insert_one(doc! { "_id": "a", "name": "Ann" }).await?;
//! # Ok(()) }
//! ```
//!
//! * `preview` mode: every call during a Preview carries the Preview's session. Nothing is ever
//!   committed; changes are read at the end (the `before` image at the transaction's own snapshot time, so
//!   a concurrent commit by another request is never reported) and the transaction is aborted. A
//!   Preview whose handler outlives [`MongoStoreBuilder::preview_timeout`] (50 seconds by default) is
//!   aborted and answers 500.
//! * `guard` mode (standalone server, or a server that can't be reached): reads run, the first write
//!   is refused before it is built, and the Preview answers 409.
//! * Commands MongoDB refuses inside a transaction (`$out`, `$merge`, an explicit `create`, `count`,
//!   `listCollections`, ...) are blocked before sending, with the reason.
//! * **The tripwire:** command monitoring watches every command the client sends. A write during a
//!   Preview without the Preview's `lsid` and `autocommit: false`, or any `commitTransaction` or
//!   `abortTransaction`, fails the Preview with 500: it can't be undone, so no rollback is claimed.
//!
//! # Coverage
//!
//! Only commands sent through the store's guarded handles, or its own client, are covered. A second
//! `Client`, one created inside a handler, or a raw socket is invisible to the tripwire, and its writes
//! are neither blocked nor rolled back. A [`Mongo`] handle moved into a task the handler spawns keeps
//! its Preview: its calls carry the Preview session and are captured. A write sent through
//! [`MongoStore::client`] from such a task carries no request scope: monitoring can't tell whose it
//! is, so every Preview open on the client answers 500. Use the handle in spawned tasks, and wrap
//! background work that writes in [`detached`](sendproof_core::detached).
//!
//! A Preview whose request is dropped before it finishes (the client disconnected) aborts its
//! transaction straight away.

mod classify;
mod engine;
mod handle;
mod monitor;
mod preview;
mod sanitize;
#[cfg(test)]
mod tests;

#[cfg(feature = "actix")]
mod actix_extractor;
#[cfg(feature = "axum")]
mod axum_extractor;

use std::{collections::HashSet, sync::Arc, time::Duration};

use mongodb::{Client, bson::Bson, error::Error, event::EventHandler, options::ClientOptions};
use sendproof_core::{
    BoxError, BoxFuture, ConfigError, DataStore, Enrollment, NotEnrolled, PreviewSession, StoreDescription, StoreMode, StoreScope,
    capture::Recorder,
    stores::{CaptureScope, exact_names, store_label},
};

pub use classify::{Classification, classify_mongo};
pub use engine::DEFAULT_PREVIEW_TIMEOUT;
pub use handle::{MongoCollection, MongoDatabase};
pub use preview::{STANDALONE_REASON, refused_reason};
pub use sanitize::sanitize_document;

#[cfg(feature = "actix")]
pub use actix_extractor::MongoRejection;
#[cfg(feature = "axum")]
pub use axum_extractor::NotEnrolledResponse;

use engine::{Engine, MongoSession};
use handle::Access;
use preview::{PreviewState, Shared};

/// The store id used in capabilities, `Db` entries, changes and the blocked response.
pub const SYSTEM: &str = "mongodb";

/// A BSON value as MongoDB Extended JSON v2 relaxed form (`{"$oid": ...}`, `{"$date": ...}`).
pub(crate) fn plain(value: &Bson) -> serde_json::Value {
    value.clone().into_relaxed_extjson()
}

/// The Preview states of the stores a request began on, kept in the request's enrollment so the
/// [`Mongo`] handle finds the state of its own store.
#[derive(Clone, Default)]
struct States(Vec<(usize, Arc<PreviewState>)>);

/// Builds a [`MongoStore`]. Start with [`MongoStore::builder`].
pub struct MongoStoreBuilder {
    options: ClientOptions,
    database: String,
    name: Option<String>,
    reads: HashSet<String>,
    timeout: Duration,
}

impl MongoStoreBuilder {
    /// The display label shown in capabilities, such as `catalog`. A label that looks like a URL, host
    /// or connection string is refused: discovery is visible to anyone who can open the workbench.
    pub fn name(mut self, label: &str) -> Result<Self, ConfigError> {
        self.name = Some(store_label(label)?);
        Ok(self)
    }

    /// Commands the host states never write, by exact name (compared case-insensitively, as MongoDB
    /// does). **This is the host's statement that the command never writes**: a command wrongly listed
    /// is not blocked in `guard` mode.
    pub fn treat_as_read<I, S>(mut self, names: I) -> Result<Self, ConfigError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.reads = exact_names(names, str::to_lowercase)?;
        Ok(self)
    }

    /// How long a Preview may hold its MongoDB transaction; 50 seconds by default, below the server's
    /// 60-second transaction lifetime. A Preview still running at the limit has its transaction aborted
    /// and answers 500 without confirmation.
    pub fn preview_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Installs command monitoring on the options and creates the client.
    ///
    /// The options must not already have a command event handler: the tripwire needs it. Hosts that
    /// want their own can read the same events from the tracing output instead.
    pub fn build(mut self) -> Result<MongoStore, Error> {
        if self.options.command_event_handler.is_some() {
            return Err(Error::custom(ConfigError(
                "the client options already have a command_event_handler; the Preview tripwire needs it".into(),
            )));
        }
        if self.timeout.is_zero() {
            return Err(Error::custom(ConfigError("the Preview timeout must be positive".into())));
        }
        let shared = Shared::new(self.reads);
        let monitor = shared.clone();
        // A synchronous callback runs in the task that sent the command, which is how the monitor finds
        // the request's Preview through its task-local capture.
        self.options.command_event_handler = Some(EventHandler::callback(move |event| monitor.handle(event)));
        let client = Client::with_options(self.options)?;
        Ok(MongoStore { engine: Engine::new(client, self.database, shared, self.timeout), name: self.name })
    }
}

/// A hooked MongoDB client, ready for [`ConfigBuilder::data_store`](sendproof_core::ConfigBuilder::data_store).
///
/// Cheap to clone. Keep one in application state so handlers can take the [`Mongo`] extractor.
#[derive(Clone)]
pub struct MongoStore {
    engine: Arc<Engine>,
    name: Option<String>,
}

impl MongoStore {
    /// Starts a store over a client you have not created yet: the options get command monitoring, and
    /// `database` is the default database of [`Mongo::collection`].
    pub fn builder(options: ClientOptions, database: impl Into<String>) -> MongoStoreBuilder {
        MongoStoreBuilder { options, database: database.into(), name: None, reads: HashSet::new(), timeout: DEFAULT_PREVIEW_TIMEOUT }
    }

    /// The monitored client, for work outside any request such as creating indexes at startup. A write
    /// sent through it during a Preview is caught by the tripwire (and fails the Preview), not rolled back.
    pub fn client(&self) -> &Client {
        &self.engine.client
    }

    /// The handle for a request, from the request's enrollment. `required` says the request is a
    /// preview (the adapter inserted [`PreviewRequired`](sendproof_core::PreviewRequired)); a preview
    /// that the gate did not enroll fails, so an undeclared route can never write.
    pub fn from_enrollment(&self, enrollment: Option<&Enrollment>, required: bool) -> Result<Mongo, NotEnrolled> {
        let scope = StoreScope::from_enrollment(enrollment, required)?;
        let id = Arc::as_ptr(&self.engine) as usize;
        let state = enrollment
            .and_then(|enrollment| enrollment.0.get::<States>())
            .and_then(|states| states.0.iter().find(|(engine, _)| *engine == id))
            .map(|(_, state)| state.clone());
        Ok(Mongo { access: Access { engine: self.engine.clone(), scope, state } })
    }

    /// The handle outside any request scope: guards through the task-local capture, if one is active.
    /// With no Preview it is a plain pass-through. Useful in tests and background work.
    pub fn detached(&self) -> Mongo {
        Mongo { access: Access { engine: self.engine.clone(), scope: StoreScope::current(), state: None } }
    }
}

impl DataStore for MongoStore {
    fn describe(&self) -> BoxFuture<'_, StoreDescription> {
        Box::pin(async move {
            let detected = self.engine.detect().await;
            let mode = if detected.mode == preview::Mode::Preview { StoreMode::Preview } else { StoreMode::Guard };
            StoreDescription { system: SYSTEM.into(), name: self.name.clone(), mode, reason: detected.reason.map(str::to_owned) }
        })
    }

    /// Detects the topology and, on a replica set or mongos, starts the Preview's session and
    /// transaction. The Preview keeps the mode it starts in.
    fn begin_preview<'a>(
        &'a self,
        extensions: &'a mut http::Extensions,
    ) -> BoxFuture<'a, Result<Option<Box<dyn PreviewSession>>, BoxError>> {
        Box::pin(async move {
            let recorder: Arc<Recorder> =
                extensions.get::<CaptureScope>().map(|scope| scope.0.clone()).ok_or("the Preview has no capture scope")?;
            let state = self.engine.begin(&recorder).await?;
            let id = Arc::as_ptr(&self.engine) as usize;
            match extensions.get_mut::<States>() {
                Some(states) => states.0.push((id, state.clone())),
                None => {
                    extensions.insert(States(vec![(id, state.clone())]));
                }
            }
            // A `guard`-mode Preview also gets a session object, so its registration is released on close.
            Ok(Some(Box::new(MongoSession { engine: self.engine.clone(), state, changes: Default::default() }) as Box<dyn PreviewSession>))
        })
    }
}

/// The MongoDB handle of one request. Take it as a handler argument.
#[derive(Clone)]
pub struct Mongo {
    access: Access,
}

impl Mongo {
    /// A database of the hooked client.
    pub fn database(&self, name: &str) -> MongoDatabase {
        MongoDatabase { access: self.access.clone(), inner: self.access.engine.client.database(name) }
    }

    /// The store's default database.
    pub fn default_database(&self) -> MongoDatabase {
        self.database(&self.access.engine.database)
    }

    /// A collection of the default database, with the driver's document type `T`.
    pub fn collection<T: Send + Sync>(&self, name: &str) -> MongoCollection<T> {
        self.default_database().collection(name)
    }
}
