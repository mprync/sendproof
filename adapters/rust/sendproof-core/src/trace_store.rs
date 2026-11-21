//! Short-lived storage of observed-send traces, scoped to their owner.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::{sync::watch, time::Instant};
use uuid::Uuid;

use crate::model::ObservedTrace;

/// Traces kept per owner.
pub const PER_OWNER_LIMIT: usize = 8;
/// Traces kept per host.
pub const TOTAL_LIMIT: usize = 32;
/// Default retention.
pub const DEFAULT_RETENTION: Duration = Duration::from_secs(5 * 60);
const READ_WAIT: Duration = Duration::from_secs(5);

/// Identifies the authenticated subject that owns a trace.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TraceOwner {
    pub authentication_type: String,
    pub subject: String,
    pub path_base: String,
}

#[derive(Clone)]
enum State {
    Pending,
    Ready(Arc<ObservedTrace>),
    Gone,
}

struct Entry {
    id: Uuid,
    owner: TraceOwner,
    start: Instant,
    state: watch::Sender<State>,
}

/// A reserved trace identifier. Complete it with [`TraceStore::complete`] or discard it.
#[derive(Debug, Clone, Copy)]
pub struct Reservation {
    pub id: Uuid,
}

/// Stores traces for a bounded time. Expiry is evaluated against `tokio::time`, so tests
/// can advance a paused clock instead of sleeping.
pub struct TraceStore {
    retention: Duration,
    entries: Mutex<VecDeque<Entry>>,
}

impl TraceStore {
    /// Creates a store whose traces expire `retention` after they are reserved.
    pub fn new(retention: Duration) -> Self {
        Self { retention, entries: Mutex::new(VecDeque::new()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<Entry>> {
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn expire(&self, entries: &mut VecDeque<Entry>) {
        while entries.front().is_some_and(|entry| entry.start.elapsed() >= self.retention) {
            if let Some(entry) = entries.pop_front() {
                entry.state.send_replace(State::Gone);
            }
        }
    }

    /// Reserves an identifier for `owner`, evicting the oldest trace of that owner or of the host when full.
    pub fn reserve(&self, owner: TraceOwner) -> Reservation {
        let mut entries = self.lock();
        self.expire(&mut entries);
        let owned: Vec<usize> = entries.iter().enumerate().filter(|(_, e)| e.owner == owner).map(|(i, _)| i).collect();
        if owned.len() >= PER_OWNER_LIMIT
            && let Some(entry) = entries.remove(owned[0])
        {
            entry.state.send_replace(State::Gone);
        }
        if entries.len() >= TOTAL_LIMIT
            && let Some(entry) = entries.pop_front()
        {
            entry.state.send_replace(State::Gone);
        }
        let id = Uuid::new_v4();
        let (state, _) = watch::channel(State::Pending);
        entries.push_back(Entry { id, owner, start: Instant::now(), state });
        Reservation { id }
    }

    /// Publishes the finished trace.
    pub fn complete(&self, reservation: Reservation, trace: ObservedTrace) {
        let entries = self.lock();
        if let Some(entry) = entries.iter().find(|entry| entry.id == reservation.id) {
            entry.state.send_replace(State::Ready(Arc::new(trace)));
        }
    }

    /// Drops a reservation whose request did not complete.
    pub fn discard(&self, reservation: Reservation) {
        let mut entries = self.lock();
        if let Some(index) = entries.iter().position(|entry| entry.id == reservation.id)
            && let Some(entry) = entries.remove(index)
        {
            entry.state.send_replace(State::Gone);
        }
    }

    /// Reads a trace. Returns `None` for a missing, expired, evicted or foreign identifier.
    /// A trace still being collected is awaited for up to five seconds.
    pub async fn read(&self, id: Uuid, owner: &TraceOwner) -> Option<Arc<ObservedTrace>> {
        let mut receiver = {
            let mut entries = self.lock();
            self.expire(&mut entries);
            entries.iter().find(|entry| entry.id == id && &entry.owner == owner)?.state.subscribe()
        };
        let wait = async {
            loop {
                match &*receiver.borrow_and_update() {
                    State::Ready(trace) => return Some(trace.clone()),
                    State::Gone => return None,
                    State::Pending => {}
                }
                if receiver.changed().await.is_err() {
                    return None;
                }
            }
        };
        tokio::time::timeout(READ_WAIT, wait).await.ok().flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Timing;

    fn owner(subject: &str) -> TraceOwner {
        TraceOwner { authentication_type: "cookie".into(), subject: subject.into(), path_base: String::new() }
    }

    fn trace() -> ObservedTrace {
        ObservedTrace {
            changes: vec![],
            effects: vec![],
            logs: vec![],
            timing: Timing { auth: 0.0, handler: 0.0, db: 0.0, query_count: 0, serialize: 0.0 },
            changes_truncated: false,
            effects_truncated: false,
            logs_truncated: false,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn expires_after_retention_and_hides_foreign_traces() {
        let store = TraceStore::new(Duration::from_secs(5));
        let reservation = store.reserve(owner("a"));
        store.complete(reservation, trace());
        assert!(store.read(reservation.id, &owner("b")).await.is_none());
        assert!(store.read(reservation.id, &owner("a")).await.is_some());
        tokio::time::advance(Duration::from_secs(6)).await;
        assert!(store.read(reservation.id, &owner("a")).await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn evicts_the_oldest_trace_of_an_owner() {
        let store = TraceStore::new(DEFAULT_RETENTION);
        let first = store.reserve(owner("a"));
        store.complete(first, trace());
        for _ in 0..PER_OWNER_LIMIT {
            let next = store.reserve(owner("a"));
            store.complete(next, trace());
        }
        assert!(store.read(first.id, &owner("a")).await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn discarded_reservations_are_not_found() {
        let store = TraceStore::new(DEFAULT_RETENTION);
        let reservation = store.reserve(owner("a"));
        store.discard(reservation);
        assert!(store.read(reservation.id, &owner("a")).await.is_none());
    }
}
