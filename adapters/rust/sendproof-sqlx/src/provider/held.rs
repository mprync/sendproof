//! Named checkpoints on a single SQLx transaction, which owns the pinned pooled connection.

use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use http::Extensions;
use sendproof_core::{BoxError, BoxFuture, Changes, HeldPreview, HeldStepError, OpenSessionError, capture};
use sqlx::Transaction;
use tokio::sync::{Mutex, OwnedMutexGuard};

use super::SqlxProvider;
use crate::{
    backend::Backend,
    db::{Scope, Slot},
    query::{PREVIEW_SAVEPOINT, Rules},
};

const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(2);
const PROBE: &str = "SAVEPOINT sendproof_preview_probe";
const RELEASE_PROBE: &str = "RELEASE SAVEPOINT sendproof_preview_probe";

pub(super) async fn open<B: Backend>(provider: &SqlxProvider<B>) -> Result<Box<dyn HeldPreview>, OpenSessionError> {
    let acquiring = async {
        let turn = if B::SERIAL_PREVIEWS { Some(provider.turn.clone().lock_owned().await) } else { None };
        let mut tx = provider.pool.begin_with(B::PREVIEW_BEGIN).await?;
        let capture = if B::CAPTURE_PER_STEP { None } else { Some(Arc::new(B::begin(&mut tx, true).await?)) };
        Ok::<_, BoxError>(Held { tx: Some(tx), capture, active: None, rules: provider.rules(), turn })
    };
    match tokio::time::timeout(ACQUIRE_TIMEOUT, acquiring).await {
        Ok(Ok(held)) => Ok(Box::new(held)),
        Ok(Err(error)) if !error.downcast_ref::<sqlx::Error>().is_some_and(lock_busy::<B>) => Err(error.into()),
        _ => Err(OpenSessionError::Busy(provider.database.clone().unwrap_or_else(|| B::SYSTEM.into()))),
    }
}

fn lock_busy<B: Backend>(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::PoolTimedOut)
        || B::ends_transaction(error)
        || error.as_database_error().and_then(|error| error.code()).is_some_and(|code| {
            code == "55P03" || (B::SYSTEM == "sqlite" && code.parse::<u32>().is_ok_and(|code| matches!(code & 0xff, 5 | 6)))
        })
}

#[derive(Debug)]
struct TransactionEnded;

impl std::fmt::Display for TransactionEnded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the database ended the held transaction after a deadlock or lock wait timeout")
    }
}

impl std::error::Error for TransactionEnded {}

struct Held<B: Backend> {
    /// Between steps the transaction is inaccessible to application handles.
    tx: Option<Transaction<'static, B>>,
    capture: Option<Arc<B::Capture>>,
    active: Option<Scope<B>>,
    rules: Arc<Rules>,
    turn: Option<OwnedMutexGuard<()>>,
}

impl<B: Backend> Held<B> {
    /// Reclaims the transaction and closes the request's scope before it can be used in another step.
    fn reclaim(&mut self) -> Result<(), BoxError> {
        let Some(scope) = &self.active else { return Ok(()) };
        {
            let mut slot = scope.slot.try_lock().map_err(|_| "the handler still holds the Preview connection")?;
            let Slot::Tx(tx) = std::mem::replace(&mut *slot, Slot::Closed) else {
                return Err("the held preview lost its transaction".into());
            };
            self.tx = Some(tx);
        }
        self.active = None;
        Ok(())
    }

    fn verify_rules(&self) -> Result<(), BoxError> {
        if self.rules.refused.load(Ordering::SeqCst) {
            return Err("the handler tried to end the held transaction; the statement was refused".into());
        }
        if self.rules.broken() {
            return Err(TransactionEnded.into());
        }
        Ok(())
    }
}

impl<B: Backend> HeldPreview for Held<B> {
    fn begin_step<'a>(&'a mut self, step: u32, extensions: &'a mut Extensions) -> BoxFuture<'a, Result<(), BoxError>> {
        Box::pin(async move {
            let _mute = capture::current().map(|recorder| recorder.mute_sqlx_events());
            let tx = self.tx.as_mut().ok_or("the held preview lost its transaction")?;
            B::run_raw(tx, &format!("SAVEPOINT {PREVIEW_SAVEPOINT}_{step}")).await?;
            // Releasing the nested probe proves the handler left the transaction intact without
            // discarding the changes or the savepoint used for later rewind.
            B::run_raw(tx, PROBE).await?;
            if B::CAPTURE_PER_STEP {
                self.capture = Some(Arc::new(B::begin(tx, true).await?));
            }
            let capture = self.capture.as_ref().ok_or("the held preview lost its capture")?.clone();
            let tx = self.tx.take().expect("step started on this transaction");
            let scope = Scope { slot: Arc::new(Mutex::new(Slot::Tx(tx))), capture, safe: self.rules.clone() };
            extensions.insert(scope.clone());
            self.active = Some(scope);
            Ok(())
        })
    }

    fn keep_step(&mut self) -> BoxFuture<'_, Result<Changes, HeldStepError>> {
        Box::pin(async move {
            let _mute = capture::current().map(|recorder| recorder.mute_sqlx_events());
            self.reclaim().map_err(HeldStepError::Broken)?;
            if let Err(error) = self.verify_rules() {
                return Err(if self.ended(&error) { HeldStepError::Ended(error) } else { HeldStepError::Broken(error) });
            }
            let tx = self.tx.as_mut().ok_or_else(|| HeldStepError::Broken("the held preview lost its transaction".into()))?;
            let capture = self.capture.as_ref().ok_or_else(|| HeldStepError::Broken("the held preview lost its capture".into()))?;
            B::finish_held_step(tx, capture).await.map_err(HeldStepError::Recoverable)?;
            if let Err(error) = B::run_raw(tx, RELEASE_PROBE).await {
                return Err(if B::step_aborted(&error) {
                    HeldStepError::Recoverable(error.into())
                } else {
                    HeldStepError::Broken(error.into())
                });
            }
            let changes = B::changes(capture);
            if B::CAPTURE_PER_STEP {
                self.capture = None;
            }
            Ok(changes)
        })
    }

    fn rewind(&mut self, step: u32) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async move {
            let _mute = capture::current().map(|recorder| recorder.mute_sqlx_events());
            self.reclaim()?;
            self.verify_rules()?;
            let tx = self.tx.as_mut().ok_or("the held preview lost its transaction")?;
            if let Some(capture) = &self.capture {
                if B::CAPTURE_PER_STEP {
                    B::abandon(tx, capture).await;
                    self.capture = None;
                } else {
                    B::changes(capture);
                }
            }
            B::run_raw(tx, &format!("ROLLBACK TO SAVEPOINT {PREVIEW_SAVEPOINT}_{step}")).await?;
            B::run_raw(tx, &format!("RELEASE SAVEPOINT {PREVIEW_SAVEPOINT}_{step}")).await?;
            Ok(())
        })
    }

    fn end(mut self: Box<Self>) -> BoxFuture<'static, Result<(), BoxError>> {
        Box::pin(async move {
            self.reclaim()?;
            let Some(mut tx) = self.tx.take() else { return Ok(()) };
            if let Some(capture) = self.capture.take() {
                B::abandon(&mut tx, &capture).await;
            }
            tx.rollback().await?;
            Ok(())
        })
    }

    fn ended(&self, error: &BoxError) -> bool {
        error.is::<TransactionEnded>()
    }
}

impl<B: Backend> Drop for Held<B> {
    fn drop(&mut self) {
        // A cancelled request can drop the session while its scope still owns the connection.
        // Reclaim it as soon as the handler releases it, then remove hooks before returning it.
        let (active, tx) = (self.active.take(), self.tx.take());
        if (active.is_some() || tx.is_some())
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let (capture, turn) = (self.capture.take(), self.turn.take());
            runtime.spawn(async move {
                let _turn = turn;
                let tx = match active {
                    Some(scope) => match std::mem::replace(&mut *scope.slot.lock().await, Slot::Closed) {
                        Slot::Tx(tx) => Some(tx),
                        _ => None,
                    },
                    None => tx,
                };
                if let Some(mut tx) = tx {
                    if let Some(capture) = capture {
                        B::abandon(&mut tx, &capture).await;
                    }
                    if let Err(error) = tx.rollback().await {
                        tracing::error!(%error, "Sendproof could not roll back a cancelled held SQL transaction");
                    }
                }
            });
        }
    }
}
