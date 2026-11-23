//! Owns the held transactions and serializes requests within a Preview session.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde_json::json;
use tokio::{
    sync::{Mutex as AsyncMutex, OwnedMutexGuard},
    time::{Instant, sleep_until},
};
use uuid::Uuid;

use crate::{HeldPreview, Reply, trace_store::TraceOwner};

const PER_OWNER: usize = 4;
const TOTAL: usize = 16;
pub(crate) const IDLE: Duration = Duration::from_secs(300);
pub(crate) const LIFETIME: Duration = Duration::from_secs(1800);

/// One owner per authenticated subject. Anonymous callers share an owner and need the secret ID.
type Owner = Option<TraceOwner>;
type Entries = Arc<Mutex<Registry>>;

#[derive(Default)]
struct Registry {
    entries: HashMap<String, Arc<Entry>>,
    closed: bool,
}

#[derive(Default)]
pub(crate) struct Sessions(Entries);

struct Entry {
    owner: Owner,
    opened: Instant,
    run: Arc<AsyncMutex<Run>>,
    closed: AtomicBool,
    timer: OnceLock<tokio::task::AbortHandle>,
}

impl Drop for Entry {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.get() {
            timer.abort();
        }
    }
}

pub(crate) struct Run {
    last_used: Instant,
    pub(crate) step: u32,
    pub(crate) parts: Vec<Box<dyn HeldPreview>>,
}

impl Run {
    fn deadline(&self, opened: Instant) -> Instant {
        (opened + LIFETIME).min(self.last_used + IDLE)
    }

    async fn end(&mut self) -> bool {
        let mut clean = true;
        while let Some(part) = self.parts.pop() {
            if let Err(error) = part.end().await {
                tracing::error!(%error, "Sendproof could not roll back a held transaction");
                clean = false;
            }
        }
        clean
    }
}

/// Owns the turn from admission through dispatch, capture and cleanup. Cancellation drops the
/// session and its transactions, so a partially executed step can never be re-used.
pub(crate) struct Turn {
    entries: Entries,
    entry: Arc<Entry>,
    pub(crate) id: String,
    pub(crate) run: OwnedMutexGuard<Run>,
    pub(crate) enrollment_failure: Option<Reply>,
    released: bool,
}

impl Turn {
    pub(crate) async fn release(mut self) {
        if Instant::now() >= self.entry.opened + LIFETIME {
            self.end().await;
        } else {
            self.run.last_used = Instant::now();
            self.released = true;
        }
    }

    pub(crate) async fn end(mut self) -> bool {
        self.entry.closed.store(true, Ordering::Relaxed);
        let clean = self.run.end().await;
        self.remove();
        self.released = true;
        clean
    }

    fn remove(&self) {
        self.entries.lock().unwrap_or_else(|p| p.into_inner()).entries.remove(&self.id);
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        if !self.released {
            self.entry.closed.store(true, Ordering::Relaxed);
            self.run.parts.clear();
            self.remove();
        }
    }
}

impl Sessions {
    /// Reserves quota before taking locks or opening connections.
    pub(crate) fn reserve(&self, owner: Owner) -> Result<Turn, Reply> {
        let mut registry = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if registry.closed {
            return Err(failed());
        }
        if registry.entries.len() >= TOTAL || registry.entries.values().filter(|entry| entry.owner == owner).count() >= PER_OWNER {
            return Err(problem(429, "session_limit", "Too many preview sessions are open. End one first."));
        }
        let id = loop {
            let id = Uuid::new_v4().simple().to_string();
            if !registry.entries.contains_key(&id) {
                break id;
            }
        };
        let opened = Instant::now();
        let run = Arc::new(AsyncMutex::new(Run { last_used: opened, step: 1, parts: Vec::new() }));
        let turn = run.clone().try_lock_owned().expect("a new session is unlocked");
        let entry = Arc::new(Entry { owner, opened, run, closed: AtomicBool::new(false), timer: OnceLock::new() });
        registry.entries.insert(id.clone(), entry.clone());
        let entries = Arc::downgrade(&self.0);
        let weak_entry = Arc::downgrade(&entry);
        let timer_id = id.clone();
        let timer = tokio::spawn(expire(entries, weak_entry, timer_id, opened + IDLE));
        let _ = entry.timer.set(timer.abort_handle());
        Ok(Turn { entries: self.0.clone(), entry, id, run: turn, enrollment_failure: None, released: false })
    }

    pub(crate) async fn enter(&self, id: &str, owner: &Owner) -> Result<Turn, Reply> {
        let entry = self.0.lock().unwrap_or_else(|p| p.into_inner()).entries.get(id).filter(|entry| &entry.owner == owner).cloned();
        let entry = entry.ok_or_else(not_found)?;
        let run = entry.run.clone().try_lock_owned().map_err(|_| {
            if entry.closed.load(Ordering::Relaxed) {
                not_found()
            } else {
                problem(409, "session_busy", "The preview session takes one request at a time.")
            }
        })?;
        if entry.closed.load(Ordering::Relaxed) {
            return Err(not_found());
        }
        let expired = Instant::now() >= run.deadline(entry.opened);
        let turn = Turn { entries: self.0.clone(), entry, id: id.into(), run, enrollment_failure: None, released: false };
        if expired {
            turn.end().await;
            return Err(not_found());
        }
        Ok(turn)
    }

    pub(crate) async fn shutdown(&self) {
        let entries = {
            let mut registry = self.0.lock().unwrap_or_else(|p| p.into_inner());
            registry.closed = true;
            std::mem::take(&mut registry.entries)
        };
        for entry in entries.into_values() {
            entry.closed.store(true, Ordering::Relaxed);
            entry.run.lock().await.end().await;
        }
    }
}

async fn expire(entries: Weak<Mutex<Registry>>, entry: Weak<Entry>, id: String, mut deadline: Instant) {
    loop {
        sleep_until(deadline).await;
        let (Some(entries), Some(entry)) = (entries.upgrade(), entry.upgrade()) else { return };
        let run = entry.run.clone().lock_owned().await;
        if entry.closed.load(Ordering::Relaxed) {
            return;
        }
        deadline = run.deadline(entry.opened);
        if Instant::now() >= deadline {
            Turn { entries, entry, id, run, enrollment_failure: None, released: false }.end().await;
            return;
        }
    }
}

fn problem(status: u16, code: &str, title: &str) -> Reply {
    session_problem(status, code, title, json!({}))
}

fn session_problem(status: u16, code: &str, title: &str, mut body: serde_json::Value) -> Reply {
    body["type"] = json!("about:blank");
    body["title"] = json!(title);
    body["status"] = json!(status);
    body["code"] = json!(code);
    Reply::problem_body(status, body.to_string().into_bytes())
}

pub(crate) fn not_found() -> Reply {
    problem(404, "session_not_found", "The preview session was not found. It may have ended or expired.")
}

pub(crate) fn failed() -> Reply {
    problem(409, "session_failed", "A store could not hold its transaction, so the preview session was closed.")
}

pub(crate) fn store_busy(store: &str) -> Reply {
    let idle = IDLE.as_secs();
    session_problem(
        409,
        "store_busy",
        &format!("Another Preview session is holding {store}."),
        json!({
            "detail": format!("That session ends by itself after its idle timeout ({idle} seconds), or when it is ended."),
            "idleTimeoutSeconds": idle,
        }),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use http::Extensions;

    use super::*;
    use crate::{BoxError, BoxFuture, Changes, HeldStepError};

    struct Part(Arc<AtomicUsize>);

    impl HeldPreview for Part {
        fn begin_step<'a>(&'a mut self, _: u32, _: &'a mut Extensions) -> BoxFuture<'a, Result<(), BoxError>> {
            Box::pin(async { Ok(()) })
        }

        fn keep_step(&mut self) -> BoxFuture<'_, Result<Changes, HeldStepError>> {
            Box::pin(async { Ok(Changes::default()) })
        }

        fn rewind(&mut self, _: u32) -> BoxFuture<'_, Result<(), BoxError>> {
            Box::pin(async { Ok(()) })
        }

        fn end(self: Box<Self>) -> BoxFuture<'static, Result<(), BoxError>> {
            Box::pin(async move {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }
    }

    fn owner(subject: &str) -> Owner {
        Some(TraceOwner { subject: subject.into(), authentication_type: "cookie".into(), path_base: String::new() })
    }

    #[tokio::test(start_paused = true)]
    async fn rolls_back_at_idle_expiry_without_another_request() {
        let sessions = Sessions::default();
        let ended = Arc::new(AtomicUsize::new(0));
        let mut turn = sessions.reserve(None).unwrap();
        let id = turn.id.clone();
        turn.run.parts.push(Box::new(Part(ended.clone())));
        turn.release().await;

        tokio::time::sleep(IDLE + Duration::from_millis(1)).await;
        assert_eq!(ended.load(Ordering::SeqCst), 1);
        assert_eq!(sessions.enter(&id, &None).await.err().unwrap().status, 404);
    }

    #[tokio::test(start_paused = true)]
    async fn defers_rollback_at_maximum_lifetime_until_request_leaves() {
        let sessions = Sessions::default();
        let ended = Arc::new(AtomicUsize::new(0));
        let mut running = sessions.reserve(None).unwrap();
        let id = running.id.clone();
        running.run.parts.push(Box::new(Part(ended.clone())));

        tokio::time::sleep(LIFETIME + Duration::from_millis(1)).await;
        assert_eq!(ended.load(Ordering::SeqCst), 0);
        running.release().await;
        assert_eq!(ended.load(Ordering::SeqCst), 1);
        assert_eq!(sessions.enter(&id, &None).await.err().unwrap().status, 404);
    }

    #[tokio::test]
    async fn enforces_owner_and_host_quotas_and_ends_sessions_on_shutdown() {
        let sessions = Sessions::default();
        let ended = Arc::new(AtomicUsize::new(0));
        for subject in ["one", "two", "three", "four"] {
            for _ in 0..PER_OWNER {
                let mut turn = sessions.reserve(owner(subject)).unwrap();
                turn.run.parts.push(Box::new(Part(ended.clone())));
                turn.release().await;
            }
            assert_eq!(sessions.reserve(owner(subject)).err().unwrap().status, 429);
        }
        assert_eq!(sessions.reserve(owner("five")).err().unwrap().status, 429);
        sessions.shutdown().await;
        assert_eq!(ended.load(Ordering::SeqCst), TOTAL);
        assert_eq!(sessions.reserve(owner("one")).err().unwrap().status, 409);
    }

    #[tokio::test]
    async fn cancels_an_interrupted_step_and_releases_its_quota() {
        let sessions = Sessions::default();
        let held = sessions.reserve(owner("alice")).unwrap();
        let id = held.id.clone();
        assert_eq!(sessions.enter(&id, &None).await.err().unwrap().status, 404);
        assert_eq!(sessions.enter(&id, &owner("alice")).await.err().unwrap().status, 409);
        drop(held);
        assert_eq!(sessions.enter(&id, &owner("alice")).await.err().unwrap().status, 404);
        for _ in 0..PER_OWNER {
            sessions.reserve(owner("alice")).unwrap().release().await;
        }
    }
}
