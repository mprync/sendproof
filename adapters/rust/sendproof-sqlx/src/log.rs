//! The in-memory list of row changes a capture collects.

use std::sync::Mutex;

use sendproof_core::{Changes, limits, model::Change};

/// Row changes in the order they happened, capped at [`limits::CHANGES`].
#[derive(Default)]
pub(crate) struct ChangeLog {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    changes: Vec<Change>,
    /// Changes recorded so far, including those over the cap. Used to rewind nested transactions.
    seen: usize,
    /// Changes were dropped over the cap, or could not be captured at all.
    truncated: bool,
}

impl ChangeLog {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn push(&self, change: Change) {
        let mut inner = self.lock();
        inner.seen += 1;
        if inner.changes.len() >= limits::CHANGES {
            inner.truncated = true;
        } else {
            inner.changes.push(change);
        }
    }

    /// Records that some changes could not be captured, so the list is incomplete.
    #[cfg_attr(not(any(feature = "postgres", feature = "mysql")), allow(dead_code))]
    pub(crate) fn mark_incomplete(&self) {
        self.lock().truncated = true;
    }

    /// The position to [`rewind`](Self::rewind) to when a nested transaction rolls back.
    #[cfg_attr(not(any(feature = "sqlite", feature = "mysql")), allow(dead_code))]
    pub(crate) fn mark(&self) -> usize {
        self.lock().seen
    }

    /// Forgets the changes recorded after `mark`: their nested transaction rolled back.
    #[cfg_attr(not(any(feature = "sqlite", feature = "mysql")), allow(dead_code))]
    pub(crate) fn rewind(&self, mark: usize) {
        let mut inner = self.lock();
        if mark < inner.seen {
            inner.changes.truncate(mark);
            inner.seen = mark;
        }
    }

    pub(crate) fn take(&self) -> Changes {
        let mut inner = self.lock();
        Changes { changes: std::mem::take(&mut inner.changes), truncated: inner.truncated }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(n: usize) -> Change {
        Change { operation: "insert".into(), table: format!("t{n}"), ..Change::default() }
    }

    #[test]
    fn caps_and_rewinds() {
        let log = ChangeLog::default();
        log.push(change(0));
        let mark = log.mark();
        log.push(change(1));
        log.push(change(2));
        log.rewind(mark);
        log.push(change(3));
        let taken = log.take();
        assert_eq!(taken.changes.iter().map(|c| c.table.as_str()).collect::<Vec<_>>(), ["t0", "t3"]);
        assert!(!taken.truncated);

        let full = ChangeLog::default();
        for n in 0..=limits::CHANGES {
            full.push(change(n));
        }
        let taken = full.take();
        assert_eq!(taken.changes.len(), limits::CHANGES);
        assert!(taken.truncated);
    }

    #[test]
    fn incomplete_marks_truncated() {
        let log = ChangeLog::default();
        log.mark_incomplete();
        assert!(log.take().truncated);
    }
}
