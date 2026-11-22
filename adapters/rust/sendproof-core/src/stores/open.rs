//! The Previews open on a guard-only store.
//!
//! A guard-only store starts nothing on its server when a Preview begins, but it still has to know
//! which Previews are open: a write that no request sent (a task the handler spawned has no
//! task-local capture) may be the Preview's, it has already reached the store, and nothing can undo
//! it. So every Preview open on that store answers 500 instead of claiming it changed nothing, unless
//! the write came from work the host marked [`detached`](super::detached).

use std::sync::{Arc, Mutex, MutexGuard, Weak};

use http::Extensions;

use super::{
    attribution::is_attributed,
    classify::CommandKind,
    guard::{CaptureScope, StoreScope, store_name},
};
use crate::{
    capture::Recorder,
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

    /// Call before sending a command, after classifying it. When it is a write that belongs to no
    /// request (no capture on `scope`, no task-local capture, not [`detached`](super::detached)
    /// work), every open Preview fails with `store`'s display name and `operation`.
    pub fn refuse_unattributed(&self, scope: &StoreScope, store: &str, operation: &str, kind: CommandKind) {
        if kind != CommandKind::Write || scope.recorder().is_some() || is_attributed() {
            return;
        }
        let open: Vec<Arc<Recorder>> = self.list().iter().filter_map(Weak::upgrade).collect();
        for preview in open {
            preview.refuse(&format!(
                "A {} {operation} that no request sent was made while this Preview was open; the Preview can't be confirmed. \
                 Wrap background work in sendproof_core::detached.",
                store_name(store)
            ));
        }
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
    async fn an_unattributed_write_fails_every_open_preview() {
        let open = OpenPreviews::new();
        let (recorder, extensions) = preview();
        let _session = open.begin(&extensions).unwrap();
        assert_eq!(open.count(), 1);
        // A task the handler spawned: no capture, not detached.
        let open_clone = open.clone();
        tokio::spawn(async move { open_clone.refuse_unattributed(&StoreScope::current(), "cassandra", "INSERT", CommandKind::Write) }).await.unwrap();
        assert!(recorder.fault().unwrap().contains("Cassandra INSERT"));
    }

    #[tokio::test]
    async fn attributed_and_detached_writes_and_reads_leave_previews_alone() {
        let open = OpenPreviews::new();
        let (recorder, extensions) = preview();
        let _session = open.begin(&extensions).unwrap();
        let scope = StoreScope::current();
        open.refuse_unattributed(&scope, "cassandra", "SELECT", CommandKind::Read);
        detached(async { open.refuse_unattributed(&StoreScope::current(), "cassandra", "INSERT", CommandKind::Write) }).await;
        capture::scope(recorder.clone(), async { open.refuse_unattributed(&StoreScope::current(), "cassandra", "INSERT", CommandKind::Write) }).await;
        assert!(recorder.fault().is_none());
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
