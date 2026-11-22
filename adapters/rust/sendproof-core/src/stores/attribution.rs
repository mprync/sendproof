//! Whose write is it? A store hook that sees a write during a Preview must be able to say which
//! request sent it. A write it can't attribute may belong to the Preview (sent from a task the handler
//! spawned, which has no task-local capture). A guard that sees it before it is sent refuses it and
//! every open Preview answers 409 ([`OpenPreviews`](super::OpenPreviews)); a hook that only sees it
//! after it was sent (the MongoDB command monitor) fails every open Preview with 500 rather than claim a
//! rollback.
//!
//! A write is attributed when it runs in a request's capture (a Preview or an observed Send), inside an
//! ordinary request the adapters dispatch (they wrap it in [`detached`]), or in work the host marks
//! [`detached`], such as a background worker.

use std::future::Future;

use crate::capture;

tokio::task_local! {
    static DETACHED: ();
}

/// Runs `future` as work that is not part of any Preview, so its store writes never fail one.
///
/// The Axum and Actix adapters run every ordinary request this way. Wrap background work that writes
/// to a hooked store (a job runner, a scheduled task) in it too: without it, such a write while a
/// Preview is open is refused and fails that Preview (409, or 500 when only the MongoDB command monitor
/// sees it, after it was sent). Inside a Preview it changes nothing: the Preview's
/// capture still applies, and its writes are still guarded.
pub async fn detached<F: Future>(future: F) -> F::Output {
    DETACHED.scope((), future).await
}

/// Whether a store write sent now can be attributed: it runs in a request's capture, or in
/// [`detached`] work.
pub fn is_attributed() -> bool {
    capture::current().is_some() || DETACHED.try_with(|()| ()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_scoped_work_is_attributed() {
        assert!(!is_attributed());
        assert!(detached(async { is_attributed() }).await);
        // A task spawned from detached work inherits nothing.
        assert!(!detached(async { tokio::spawn(async { is_attributed() }).await.unwrap() }).await);
    }
}
