//! The preview provider, generic over the database backend.

use std::sync::Arc;

use http::Extensions;
use sqlx::Pool;
use sendproof_core::{BoxError, BoxFuture, Changes, Observation, PreviewProvider, PreviewSession, capture};
use tokio::sync::Mutex;

use crate::{
    backend::Backend,
    db::{Scope, Slot},
};

/// The savepoint taken right after a preview begins. Rolling back to it before the final rollback
/// proves the handler did not end the transaction (a raw `COMMIT`, or a MySQL statement that
/// commits implicitly), which would have made its writes permanent.
const GUARD: &str = "SAVEPOINT sendproof_guard";
const ROLLBACK_TO_GUARD: &str = "ROLLBACK TO SAVEPOINT sendproof_guard";

/// Enrolls operations in a transaction on the connection the handler uses.
///
/// Use the aliases [`SqliteProvider`], [`PgProvider`] and [`MySqlProvider`]. Handlers must reach the
/// database through [`Db`](crate::Db).
pub struct SqlxProvider<B: Backend> {
    pool: Pool<B>,
    database: Option<String>,
}

/// The SQLite provider.
#[cfg(feature = "sqlite")]
pub type SqliteProvider = SqlxProvider<sqlx::Sqlite>;
/// The PostgreSQL provider.
#[cfg(feature = "postgres")]
pub type PgProvider = SqlxProvider<sqlx::Postgres>;
/// The MySQL provider.
#[cfg(feature = "mysql")]
pub type MySqlProvider = SqlxProvider<sqlx::MySql>;

impl<B: Backend> Clone for SqlxProvider<B> {
    fn clone(&self) -> Self {
        Self { pool: self.pool.clone(), database: self.database.clone() }
    }
}

impl<B: Backend> SqlxProvider<B> {
    /// Creates a provider over `pool`.
    pub fn new(pool: Pool<B>) -> Self {
        Self { pool, database: None }
    }

    /// The label shown for the database. Use a short name, never a path or connection string.
    ///
    /// A label that looks like a URL, connection string or file path (it contains `://`, `@`, `;`,
    /// `=`, `/` or `\`) is not shown at all, so a mistakenly passed `DATABASE_URL` cannot leak.
    pub fn database(mut self, label: impl Into<String>) -> Self {
        let label = label.into();
        self.database = is_display_label(&label).then_some(label);
        self
    }
}

/// Whether `label` is a bare display name rather than a URL, connection string or path.
fn is_display_label(label: &str) -> bool {
    !label.trim().is_empty()
        && label.chars().count() <= 128
        && !label.contains("://")
        && !label.contains(['@', ';', '=', '/', '\\'])
        && !label.chars().any(char::is_control)
}

impl<B: Backend> PreviewProvider for SqlxProvider<B> {
    fn database(&self) -> Option<String> {
        self.database.clone()
    }

    fn is_available(&self) -> bool {
        !self.pool.is_closed()
    }

    fn begin_preview<'a>(&'a self, extensions: &'a mut Extensions) -> BoxFuture<'a, Result<Box<dyn PreviewSession>, BoxError>> {
        Box::pin(async move {
            // On any error below, dropping the transaction rolls back whatever was installed.
            let mut transaction = self.pool.begin_with(B::PREVIEW_BEGIN).await?;
            let capture = Arc::new(B::begin(&mut transaction, true).await?);
            if let Err(error) = B::run_raw(&mut transaction, GUARD).await {
                B::abandon(&mut transaction, &capture).await;
                return Err(error.into());
            }
            let scope = Scope { slot: Arc::new(Mutex::new(Slot::Tx(transaction))), capture };
            extensions.insert(scope.clone());
            Ok(Box::new(Session { scope, finished: false }) as Box<dyn PreviewSession>)
        })
    }

    fn begin_observation<'a>(&'a self, extensions: &'a mut Extensions) -> BoxFuture<'a, Result<Option<Box<dyn Observation>>, BoxError>> {
        Box::pin(async move {
            let mut connection = self.pool.acquire().await?;
            let capture = match B::begin(&mut connection, false).await {
                Ok(capture) => Arc::new(capture),
                Err(error) => {
                    if B::CLOSE_UNFINISHED {
                        connection.close_on_drop();
                    }
                    return Err(error);
                }
            };
            let scope = Scope { slot: Arc::new(Mutex::new(Slot::Conn(connection))), capture };
            extensions.insert(scope.clone());
            Ok(Some(Box::new(Session { scope, finished: false }) as Box<dyn Observation>))
        })
    }
}

/// One preview or observed send.
struct Session<B: Backend> {
    scope: Scope<B>,
    /// The capture was collected and removed.
    finished: bool,
}

impl<B: Backend> Session<B> {
    /// Takes the connection back from the handler, failing if the handler still holds it.
    fn reclaim(&self) -> Result<Slot<B>, BoxError> {
        let mut slot = self.scope.slot.try_lock().map_err(|_| -> BoxError { "the handler still holds the preview connection".into() })?;
        Ok(std::mem::replace(&mut *slot, Slot::Closed))
    }

    /// Puts a connection back so `close` can release it.
    fn restore(&self, slot: Slot<B>) {
        if let Ok(mut current) = self.scope.slot.try_lock() {
            *current = slot;
        }
    }
}

impl<B: Backend> Drop for Session<B> {
    fn drop(&mut self) {
        // Dropped mid-request (for example a panicking handler): an observed connection that still
        // carries capture state is closed instead of going back to the pool. A preview transaction
        // rolls back on drop, which removes everything it installed.
        if !self.finished
            && B::CLOSE_UNFINISHED
            && let Ok(mut slot) = self.scope.slot.try_lock()
            && let Slot::Conn(connection) = &mut *slot
        {
            connection.close_on_drop();
        }
    }
}

impl<B: Backend> PreviewSession for Session<B> {
    fn rollback(&mut self) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async move {
            let Slot::Tx(mut transaction) = self.reclaim()? else {
                return Err("the preview has no transaction to roll back".into());
            };
            // The provider's own statements are not part of the capture.
            let _mute = capture::current().map(|recorder| recorder.mute_sqlx_events());
            if let Err(error) = B::finish(&mut transaction, &self.scope.capture).await {
                B::abandon(&mut transaction, &self.scope.capture).await;
                return Err(error);
            }
            self.finished = true;
            B::run_raw(&mut transaction, ROLLBACK_TO_GUARD).await.map_err(|error| -> BoxError {
                format!("the preview transaction ended before its rollback, so its writes may be permanent: {error}").into()
            })?;
            transaction.rollback().await?;
            Ok(())
        })
    }

    fn changes(&mut self) -> Changes {
        B::changes(&self.scope.capture)
    }

    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), BoxError>> {
        // The transaction was consumed by `rollback`. If it was not (a failed rollback), the slot
        // still owns it and dropping it rolls it back and returns the connection to the pool.
        Box::pin(async move {
            if let Ok(Slot::Tx(mut transaction)) = self.reclaim() {
                if !self.finished {
                    B::abandon(&mut transaction, &self.scope.capture).await;
                }
                let _ = transaction.rollback().await;
            }
            Ok(())
        })
    }
}

impl<B: Backend> Observation for Session<B> {
    fn complete(&mut self) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async move {
            match self.reclaim()? {
                Slot::Conn(mut connection) => {
                    let result = B::finish(&mut connection, &self.scope.capture).await;
                    match &result {
                        Ok(()) => self.finished = true,
                        Err(_) => {
                            B::abandon(&mut connection, &self.scope.capture).await;
                            if B::CLOSE_UNFINISHED {
                                connection.close_on_drop();
                            }
                        }
                    }
                    self.restore(Slot::Conn(connection));
                    result
                }
                other => {
                    self.restore(other);
                    Err("the observed send has no connection".into())
                }
            }
        })
    }

    fn changes(&mut self) -> Changes {
        B::changes(&self.scope.capture)
    }

    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), BoxError>> {
        Box::pin(async move {
            if let Ok(Slot::Conn(mut connection)) = self.reclaim()
                && !self.finished
            {
                // `complete` did not run or failed: remove what can be removed, and never return a
                // connection that may still carry capture state to the pool.
                B::abandon(&mut connection, &self.scope.capture).await;
                if B::CLOSE_UNFINISHED {
                    connection.close_on_drop();
                }
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::is_display_label;

    #[test]
    fn database_labels_are_bare_names() {
        for good in ["fixture.db", "fixture (PostgreSQL)", "inventory"] {
            assert!(is_display_label(good), "{good}");
        }
        for bad in ["postgres://u:p@host/db", "Server=db;Password=x", "/var/data/app.db", "C:\\data\\app.db", "user@host", ""] {
            assert!(!is_display_label(bad), "{bad}");
        }
    }
}
