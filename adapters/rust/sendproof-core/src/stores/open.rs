//! The Previews open on a guard-only store.
//!
//! A guard-only store starts nothing on its server when a Preview begins, but it still has to know
//! which Previews are open: a write that no request sent (a task the handler spawned has no
//! task-local capture, nor does a client's own background writer) may be the Preview's, and once sent
//! nothing can undo it. So while a Preview is open such a write is **refused before it is sent** and
//! every open Preview is marked blocked (`spec/data-stores.md`, "Writes the binding can't attribute
//! to a request"), unless the write came from work the host marked
//! [`detached`](super::detached).

use std::sync::{Arc, Mutex, MutexGuard, Weak};

use http::Extensions;

use super::{
    attribution::is_attributed,
    classify::CommandKind,
    guard::{CaptureScope, PreviewWriteBlocked, StoreScope, write_reason},
};
use crate::{
    capture::{Blocked, DbEntry, Recorder},
    provider::{BoxError, BoxFuture, Changes, PreviewSession},
};

/// The Previews open on one store. Cheap to clone; clones share the list.
#[derive(Clone, Default)]
pub struct OpenPreviews {
    open: Arc<Mutex<Vec<Weak<Recorder>>>>,
}

impl OpenPreviews {
    /// An empty list.
    pub fn new() -> Self {
        Self::default()
    }

    fn list(&self) -> MutexGuard<'_, Vec<Weak<Recorder>>> {
        self.open.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Registers the Preview whose capture scope is in `extensions` as open until the returned session
    /// is closed or dropped. Dropping covers a Preview whose future was cancelled before it finished.
    /// Nothing is started on the store: there is nothing to roll back.
    pub fn begin(&self, extensions: &Extensions) -> Result<Box<dyn PreviewSession>, BoxError> {
        let recorder = extensions.get::<CaptureScope>().map(|scope| scope.0.clone()).ok_or("the Preview has no capture scope")?;
        let mut open = self.list();
        open.retain(|preview| preview.strong_count() > 0);
        open.push(Arc::downgrade(&recorder));
        drop(open);
        Ok(Box::new(OpenPreview { previews: self.clone(), recorder }))
    }

    /// How many Previews are open.
    pub fn count(&self) -> usize {
        self.list().iter().filter(|preview| preview.strong_count() > 0).count()
    }

    /// Call before sending a command, after classifying it. A write that belongs to no request (no
    /// capture on `scope`, no task-local capture, not [`detached`](super::detached) work) while a
    /// Preview is open is treated as that Preview's: it returns the refusal, so **the command must not
    /// be sent**, and every open Preview is marked blocked and logs the refused write. Without an open
    /// Preview, or for a read, a request's own write or detached work, it does nothing.
    pub fn block_unattributed(
        &self,
        scope: &StoreScope,
        store: &str,
        operation: &str,
        kind: CommandKind,
    ) -> Result<(), PreviewWriteBlocked> {
        if kind != CommandKind::Write || scope.recorder().is_some() || is_attributed() {
            return Ok(());
        }
        let open: Vec<Arc<Recorder>> = self.list().iter().filter_map(Weak::upgrade).collect();
        if open.is_empty() {
            return Ok(());
        }
        let detail = write_reason(store);
        for preview in open {
            preview.block(Blocked { store: store.to_owned(), operation: operation.to_owned(), detail: detail.clone() });
            preview.record_db(DbEntry { system: store.to_owned(), operation: operation.to_owned(), blocked: true, ..DbEntry::default() });
        }
        Err(PreviewWriteBlocked { store: store.to_owned(), operation: operation.to_owned(), detail })
    }
}

/// A Preview open on a guard-only store. Closing or dropping it takes the Preview off the list.
struct OpenPreview {
    previews: OpenPreviews,
    recorder: Arc<Recorder>,
}

impl PreviewSession for OpenPreview {
    fn rollback(&mut self) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async { Ok(()) })
    }

    fn changes(&mut self) -> Changes {
        Changes::default()
    }

    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), BoxError>> {
        Box::pin(async { Ok(()) })
    }
}

impl Drop for OpenPreview {
    fn drop(&mut self) {
        let recorder = Arc::as_ptr(&self.recorder);
        self.previews.list().retain(|preview| preview.strong_count() > 0 && preview.as_ptr() != recorder);
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::{capture, stores::detached};

    fn preview() -> (Arc<Recorder>, Extensions) {
        let recorder = Recorder::new_preview(Instant::now(), true);
        recorder.begin(true);
        let mut extensions = Extensions::new();
        extensions.insert(CaptureScope(recorder.clone()));
        (recorder, extensions)
    }

    #[tokio::test]
    async fn an_unattributed_write_is_refused_and_blocks_every_open_preview() {
        let open = OpenPreviews::new();
        let (first, extensions) = preview();
        let (second, other) = preview();
        let _sessions = (open.begin(&extensions).unwrap(), open.begin(&other).unwrap());
        assert_eq!(open.count(), 2);
        // A task the handler spawned: no capture, not detached.
        let open_clone = open.clone();
        let refusal = tokio::spawn(async move { open_clone.block_unattributed(&StoreScope::current(), "cassandra", "INSERT", CommandKind::Write) })
            .await
            .unwrap();
        let refusal = refusal.expect_err("the write is refused, so the caller never sends it");
        assert_eq!((refusal.store.as_str(), refusal.operation.as_str()), ("cassandra", "INSERT"));
        for preview in [&first, &second] {
            let blocked = preview.blocked().expect("every open Preview is blocked");
            assert_eq!((blocked.store.as_str(), blocked.operation.as_str()), ("cassandra", "INSERT"));
        }
    }

    #[tokio::test]
    async fn without_an_open_preview_an_unattributed_write_is_allowed() {
        let open = OpenPreviews::new();
        assert!(open.block_unattributed(&StoreScope::current(), "cassandra", "INSERT", CommandKind::Write).is_ok());
    }

    #[tokio::test]
    async fn attributed_and_detached_writes_and_reads_leave_previews_alone() {
        let open = OpenPreviews::new();
        let (recorder, extensions) = preview();
        let _session = open.begin(&extensions).unwrap();
        let scope = StoreScope::current();
        assert!(open.block_unattributed(&scope, "cassandra", "SELECT", CommandKind::Read).is_ok());
        assert!(detached(async { open.block_unattributed(&StoreScope::current(), "cassandra", "INSERT", CommandKind::Write) }).await.is_ok());
        // A request's own write is the guard's business, not this check's.
        assert!(capture::scope(recorder.clone(), async { open.block_unattributed(&StoreScope::current(), "cassandra", "INSERT", CommandKind::Write) }).await.is_ok());
        assert!(recorder.blocked().is_none());
    }

    #[tokio::test]
    async fn closing_or_dropping_a_preview_takes_it_off_the_list() {
        let open = OpenPreviews::new();
        let (_recorder, extensions) = preview();
        let session = open.begin(&extensions).unwrap();
        assert_eq!(open.count(), 1);
        session.close().await.unwrap();
        assert_eq!(open.count(), 0);
        let (_other, extensions) = preview();
        drop(open.begin(&extensions).unwrap());
        assert_eq!(open.count(), 0, "a Preview whose future was dropped is no longer open");
        assert!(open.begin(&Extensions::new()).is_err());
    }
}
