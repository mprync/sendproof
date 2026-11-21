//! The preview provider, generic over the database backend.

use std::{collections::HashSet, sync::Arc};

use http::Extensions;
use sendproof_core::{BoxError, BoxFuture, Changes, Observation, PreviewProvider, PreviewSession, capture};
use sqlx::Pool;
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::{
    backend::Backend,
    db::{Scope, Slot},
    query::Rules,
};

/// The savepoint taken right after a preview begins (spec/data-stores.md, `sendproof_preview`).
/// Rolling back to it before the final rollback proves the handler did not end the transaction (a
/// raw `COMMIT`, or a MySQL statement that commits implicitly), which would have made its writes
/// permanent: any commit erases every savepoint. A savepoint taken only at the end could not tell,
/// because under `autocommit=0` MySQL opens a new transaction after a commit. The guard refuses a
/// handler's statements naming it (`query::PREVIEW_SAVEPOINT`).
const GUARD: &str = "SAVEPOINT sendproof_preview";
const ROLLBACK_TO_GUARD: &str = "ROLLBACK TO SAVEPOINT sendproof_preview";

/// Enrolls operations in a transaction on the connection the handler uses.
///
/// Use the aliases [`SqliteProvider`], [`PgProvider`] and [`MySqlProvider`]. Handlers must reach the
/// database through [`Db`](crate::Db).
pub struct SqlxProvider<B: Backend> {
    pool: Pool<B>,
    database: Option<String>,
    /// Held by the running preview when the backend's previews take turns (see `SERIAL_PREVIEWS`). Clones of the
    /// provider share it.
    turn: Arc<Mutex<()>>,
    /// MySQL procedures a preview may `CALL`; see [`safe_procedure`](Self::safe_procedure).
    safe: Arc<HashSet<String>>,
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
        Self { pool: self.pool.clone(), database: self.database.clone(), turn: self.turn.clone(), safe: self.safe.clone() }
    }
}

impl<B: Backend> SqlxProvider<B> {
    /// Creates a provider over `pool`.
    pub fn new(pool: Pool<B>) -> Self {
        Self { pool, database: None, turn: Arc::new(Mutex::new(())), safe: Arc::default() }
    }

    /// Declares a MySQL or MariaDB stored procedure that never commits, by exact name (`name` or
    /// `schema.name`, optionally backtick-quoted, no wildcards). During a preview every other `CALL`
    /// is refused, because a procedure can run `COMMIT` or an implicitly committing statement inside
    /// the preview transaction. The match ignores case, as MySQL routine names do, and a
    /// schema-qualified call matches only a declaration with that schema.
    ///
    /// **Warning:** declaring a procedure is your statement that it never commits. One that does
    /// commits the handler's writes; the preview still fails, because the savepoint it set at the
    /// start is gone, but the writes stay.
    ///
    /// # Panics
    ///
    /// Panics when `name` is not an exact procedure name, at startup rather than in a request.
    pub fn safe_procedure(mut self, name: &str) -> Self {
        let parsed = crate::query::safe_procedure_name(name)
            .unwrap_or_else(|| panic!("safe procedure names are exact names, such as `name` or `schema.name`: {name:?}"));
        Arc::make_mut(&mut self.safe).insert(parsed);
        self
    }

    /// Fresh guard state for one preview or observed send.
    fn rules(&self) -> Arc<Rules> {
        Arc::new(Rules { procedures: (*self.safe).clone(), ..Rules::default() })
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

    fn system(&self) -> Option<&'static str> {
        Some(B::SYSTEM)
    }

    fn is_available(&self) -> bool {
        !self.pool.is_closed()
    }

    fn begin_preview<'a>(&'a self, extensions: &'a mut Extensions) -> BoxFuture<'a, Result<Box<dyn PreviewSession>, BoxError>> {
        Box::pin(async move {
            // Wait for this preview's turn before taking a connection, so waiting previews hold none. The session
            // keeps the guard until it is dropped, after its transaction has ended.
            let turn = if B::SERIAL_PREVIEWS { Some(self.turn.clone().lock_owned().await) } else { None };
            // On any error below, dropping the transaction rolls back whatever was installed.
            let mut transaction = self.pool.begin_with(B::PREVIEW_BEGIN).await?;
            let capture = Arc::new(B::begin(&mut transaction, true).await?);
            if let Err(error) = B::run_raw(&mut transaction, GUARD).await {
                B::abandon(&mut transaction, &capture).await;
                return Err(error.into());
            }
            let scope = Scope { slot: Arc::new(Mutex::new(Slot::Tx(transaction))), capture, safe: self.rules() };
            extensions.insert(scope.clone());
            Ok(Box::new(Session { scope, finished: false, _turn: turn }) as Box<dyn PreviewSession>)
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
            let scope = Scope { slot: Arc::new(Mutex::new(Slot::Conn(connection))), capture, safe: self.rules() };
            extensions.insert(scope.clone());
            Ok(Some(Box::new(Session { scope, finished: false, _turn: None }) as Box<dyn Observation>))
        })
    }
}

/// One preview or observed send.
struct Session<B: Backend> {
    scope: Scope<B>,
    /// The capture was collected and removed.
    finished: bool,
    /// The preview's turn, released when the session is dropped: after `rollback` or `close` has ended the
    /// transaction.
    _turn: Option<OwnedMutexGuard<()>>,
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
            let guard = B::run_raw(&mut transaction, ROLLBACK_TO_GUARD).await;
            if self.scope.safe.broken() {
                let _ = transaction.rollback().await;
                return Err("the database rolled the preview transaction back after a deadlock or lock wait timeout, so the preview can't be confirmed".into());
            }
            if self.scope.safe.refused.load(std::sync::atomic::Ordering::SeqCst) {
                transaction.rollback().await?;
                return Err(
                    "the handler tried to end the preview transaction; the statement was refused, but the preview can't be confirmed"
                        .into(),
                );
            }
            guard.map_err(|error| -> BoxError {
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
