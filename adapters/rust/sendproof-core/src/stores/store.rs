//! The contract between the protocol and one data store.

use std::sync::Arc;

use http::Extensions;

use crate::provider::{BoxError, BoxFuture, Changes, HeldPreview, HeldStepError, OpenSessionError, PreviewSession};

/// How a Preview treats a store (`spec/data-stores.md` "Store modes").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreMode {
    /// Writes run inside a transaction that the binding aborts after the handler.
    Preview,
    /// Reads run; the first write blocks the Preview.
    Guard,
}

impl StoreMode {
    /// The value used in capabilities.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preview => "preview",
            Self::Guard => "guard",
        }
    }
}

/// One entry of capabilities `dataStores`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreDescription {
    /// The store id: `mongodb`, `redis`, `dynamodb`.
    pub system: String,
    /// A host-chosen display label. Never a connection string, host, user or password.
    pub name: Option<String>,
    pub mode: StoreMode,
    /// Why a store runs in `guard` mode when it could not run in `preview` mode.
    pub reason: Option<String>,
}

/// A data store hooked by the host and registered with
/// [`ConfigBuilder::data_store`](crate::ConfigBuilder::data_store).
pub trait DataStore: Send + Sync + 'static {
    /// The entry shown in capabilities. May talk to the store (MongoDB asks for its topology).
    fn describe(&self) -> BoxFuture<'_, StoreDescription>;

    /// Whether the rollback mode can hold a transaction across requests.
    fn supports_held_preview(&self) -> bool {
        false
    }

    /// Begins a held transaction. A guard-only store has none.
    fn begin_held_preview(&self) -> BoxFuture<'_, Result<Option<Box<dyn HeldPreview>>, OpenSessionError>> {
        Box::pin(async { Ok(None) })
    }

    /// Begins a Preview on this store. A `preview`-mode store starts its transaction, puts whatever
    /// its handle needs to reach it into `extensions`, and returns the session that captures changes
    /// and aborts after the handler. A guard-only store returns `Ok(None)`.
    ///
    /// An error answers the Preview with 500. A store whose server can't be reached should fall back
    /// to `guard` mode instead.
    fn begin_preview<'a>(&'a self, extensions: &'a mut Extensions) -> BoxFuture<'a, Result<Option<Box<dyn PreviewSession>>, BoxError>> {
        let _ = extensions;
        Box::pin(async { Ok(None) })
    }
}

/// A guard store still enrolls each request so its existing tripwire also blocks unattributed writes.
pub(crate) struct HeldGuard {
    store: Arc<dyn DataStore>,
    step: Option<Box<dyn PreviewSession>>,
}

impl HeldGuard {
    pub(crate) fn new(store: Arc<dyn DataStore>) -> Self {
        Self { store, step: None }
    }

    async fn close_step(&mut self) -> Result<Changes, BoxError> {
        let Some(mut step) = self.step.take() else { return Ok(Changes::default()) };
        let rolled_back = step.rollback().await;
        let changes = step.changes();
        let closed = step.close().await;
        rolled_back.and(closed)?;
        Ok(changes)
    }
}

impl HeldPreview for HeldGuard {
    fn begin_step<'a>(&'a mut self, _step: u32, extensions: &'a mut Extensions) -> BoxFuture<'a, Result<(), BoxError>> {
        Box::pin(async move {
            self.step = self.store.begin_preview(extensions).await?;
            Ok(())
        })
    }

    fn keep_step(&mut self) -> BoxFuture<'_, Result<Changes, HeldStepError>> {
        Box::pin(async { self.close_step().await.map_err(HeldStepError::Broken) })
    }

    fn rewind(&mut self, _step: u32) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async { self.close_step().await.map(drop) })
    }

    fn end(mut self: Box<Self>) -> BoxFuture<'static, Result<(), BoxError>> {
        Box::pin(async move { self.close_step().await.map(drop) })
    }
}
