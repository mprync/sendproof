//! The contract between the protocol and a data layer.
//!
//! A provider decides whether a whole operation can be enrolled in one rollback-only unit
//! of work *before* the handler runs, hands the handler a way to reach it, reports the
//! row changes, and rolls back. Only advertise operations a provider can fully enroll.

use std::{future::Future, pin::Pin};

use http::Extensions;

use crate::model::Change;

/// A boxed, sendable future.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The error type of provider operations.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Row changes collected by a session or observation.
#[derive(Debug, Default, Clone)]
pub struct Changes {
    pub changes: Vec<Change>,
    /// `true` when the provider dropped changes of its own accord.
    pub truncated: bool,
}

/// Registers one data layer with the protocol.
pub trait PreviewProvider: Send + Sync + 'static {
    /// A display label for the database. Never a connection string, host, credential or path.
    fn database(&self) -> Option<String> {
        None
    }

    /// The SQL provider id, such as `sqlite`, `postgresql` or `mysql`, so the workbench shows that
    /// provider's mark instead of guessing from the database name.
    fn system(&self) -> Option<&'static str> {
        None
    }

    /// Whether previews can run right now. When `false`, no operations are advertised.
    fn is_available(&self) -> bool {
        true
    }

    /// Begins a rollback-only session on the connection the handler will use.
    ///
    /// Insert whatever the handler needs to reach the session into `extensions`
    /// (the request's extensions). On failure release every partially acquired resource.
    fn begin_preview<'a>(&'a self, extensions: &'a mut Extensions) -> BoxFuture<'a, Result<Box<dyn PreviewSession>, BoxError>>;

    /// Begins observing a normal send that will commit. Returns `None` when this
    /// provider cannot observe changes.
    fn begin_observation<'a>(&'a self, extensions: &'a mut Extensions) -> BoxFuture<'a, Result<Option<Box<dyn Observation>>, BoxError>> {
        let _ = extensions;
        Box::pin(async { Ok(None) })
    }
}

/// A rollback-only unit of work that holds the handler's changes.
pub trait PreviewSession: Send {
    /// Rolls the unit of work back. An error means rollback is unconfirmed and no result is returned.
    fn rollback(&mut self) -> BoxFuture<'_, Result<(), BoxError>>;

    /// The row changes the handler made. Called after a successful rollback.
    fn changes(&mut self) -> Changes;

    /// Releases the session. Called on every path, including after failures.
    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), BoxError>>;
}

/// Observes the changes of a send that commits normally.
pub trait Observation: Send {
    /// Collects what the provider needs before [`Observation::changes`] is called, such as reading
    /// an audit table and removing capture triggers. Called once after the handler finished and the
    /// capture stopped recording. An error means the changes are incomplete.
    fn complete(&mut self) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async { Ok(()) })
    }

    /// The row changes the handler committed.
    fn changes(&mut self) -> Changes;

    /// Releases the observation.
    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), BoxError>>;
}

/// A request extension that the protocol adapter inserts into every preview and observed-send
/// request, **before** the provider has enrolled it.
///
/// A data layer must refuse to touch the database when this marker is present but its own
/// session (installed by [`PreviewProvider::begin_preview`] or `begin_observation`) is not.
/// That guard keeps a route that was not enrolled from committing during a preview.
#[derive(Debug, Clone, Copy)]
pub struct PreviewRequired {
    /// `true` for a rollback preview, `false` for an observed send.
    pub rollback: bool,
}
