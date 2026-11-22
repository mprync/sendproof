//! The state of one Preview on one MongoDB client, and the registry the command monitor reads.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard, atomic::AtomicBool},
};

use mongodb::{
    ClientSession,
    bson::{Bson, Document, Timestamp},
};
use sendproof_core::capture::{DbEntry, Recorder};
use tokio::task::JoinHandle;

/// The reason a standalone server, or any reply the binding doesn't recognise, runs in `guard` mode.
pub const STANDALONE_REASON: &str = "Preview unavailable: this MongoDB server doesn't support transactions";

/// The reason when the detection `hello` got no answer: whether the server supports transactions is
/// unknown, so the store runs in `guard` mode for now and asks again next time.
pub const UNREACHABLE_REASON: &str =
    "Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, so this Preview runs in guard mode";

/// The reason a client whose command monitoring never saw its own `hello` can't Preview: the tripwire
/// isn't on it, so an escaped write would go unseen.
pub const UNMONITORED_REASON: &str = "Preview unavailable: command monitoring isn't installed on this MongoDB client";

/// The reason for a command MongoDB refuses inside a transaction.
pub fn refused_reason(operation: &str) -> String {
    format!("Preview unavailable: MongoDB can't run {operation} inside a transaction")
}

/// The mode one Preview began in. It is fixed at the start: a Preview that began without a session
/// never has its writes treated as joining a transaction it never had, even if a later detection
/// succeeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Preview,
    Guard,
}

/// One document a Preview may have changed, and how.
#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub namespace: String,
    pub collection: String,
    pub id: Bson,
    pub via: Option<&'static str>,
}

/// A filter whose matches, before and inside the transaction, are change candidates.
#[derive(Debug, Clone)]
pub(crate) struct Filter {
    pub namespace: String,
    pub collection: String,
    pub filter: Document,
    pub via: Option<&'static str>,
}

#[derive(Default)]
pub(crate) struct Data {
    /// Set once a command carried the session to the server.
    pub used: bool,
    /// Set when a handle hands out the session for a command: from then on the server may hold the
    /// transaction, and its locks, until an abort reaches it.
    pub opened: bool,
    /// The transaction was aborted and the session released. Nothing may use the session again.
    pub finished: bool,
    pub candidates: Vec<Candidate>,
    pub seen: HashMap<String, usize>,
    pub filters: Vec<Filter>,
    /// The transaction's snapshot time: the `operationTime` of the first reply to a command the Preview
    /// session sent. `before` images are read at this time, so a concurrent commit by another request
    /// never shows up as a Preview change.
    pub start_time: Option<Timestamp>,
    /// Aborts the transaction when the Preview outlives its time limit.
    pub timer: Option<JoinHandle<()>>,
}

/// The state of one Preview on one client.
pub(crate) struct PreviewState {
    pub mode: Mode,
    /// The Preview's session, shared by every operation of the request. Held for the whole of an
    /// operation, and by the abort, so no command can follow the abort.
    pub session: Option<Arc<tokio::sync::Mutex<ClientSession>>>,
    /// The session id (`lsid`) every command of the Preview carries.
    pub lsid: Option<Document>,
    /// The Preview's recorder, so monitoring can attribute a command that carries the Preview's `lsid`
    /// even when it was sent from a task without the request's task-local capture.
    pub recorder: Arc<Recorder>,
    data: Mutex<Data>,
}

impl PreviewState {
    pub fn new(session: ClientSession, recorder: Arc<Recorder>) -> Arc<Self> {
        let lsid = session.id().clone();
        Arc::new(Self {
            mode: Mode::Preview,
            session: Some(Arc::new(tokio::sync::Mutex::new(session))),
            lsid: Some(lsid),
            recorder,
            data: Mutex::default(),
        })
    }

    /// A Preview of a store that can't join one: reads run, the first write blocks.
    pub fn guard(recorder: Arc<Recorder>) -> Arc<Self> {
        Arc::new(Self { mode: Mode::Guard, session: None, lsid: None, recorder, data: Mutex::default() })
    }

    pub fn data(&self) -> MutexGuard<'_, Data> {
        // Capture must never take the application down: recover from a poisoned lock.
        self.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Records a candidate document. An upsert or replace label wins over an unlabelled sighting.
    pub fn candidate(&self, candidate: Candidate) {
        if matches!(candidate.id, Bson::Null) {
            return;
        }
        let key = format!("{}\u{0}{}\u{0}{}", candidate.namespace, candidate.collection, crate::plain(&candidate.id));
        let mut data = self.data();
        match data.seen.get(&key).copied() {
            None => {
                let position = data.candidates.len();
                data.seen.insert(key, position);
                data.candidates.push(candidate);
            }
            Some(position) if data.candidates[position].via.is_none() && candidate.via.is_some() => data.candidates[position] = candidate,
            Some(_) => {}
        }
    }
}

/// A command seen by monitoring, kept until its reply arrives.
pub(crate) struct Pending {
    /// The request's recorder (preview or observed send): where the `Db` entry is logged.
    pub capture: Option<Arc<Recorder>>,
    pub preview: Option<Arc<Recorder>>,
    pub name: String,
    pub namespace: String,
    pub target: Option<String>,
    pub statement: String,
    pub lsid: Option<Document>,
}

impl Pending {
    pub fn log(&self, elapsed: std::time::Duration, rows_affected: Option<u64>, error: Option<String>) {
        let Some(capture) = &self.capture else { return };
        capture.record_db(DbEntry {
            system: crate::SYSTEM.into(),
            operation: self.name.clone(),
            target: self.target.clone(),
            namespace: Some(self.namespace.clone()),
            statement: Some(self.statement.clone()),
            rows_affected,
            error,
            elapsed,
            ..DbEntry::default()
        });
    }
}

/// What the command monitor, the engine and the handles share.
pub(crate) struct Shared {
    /// Host-declared reads, lower case.
    pub reads: HashSet<String>,
    /// Each Preview's state, keyed by its recorder, which is how the monitor (running in the calling
    /// task, with the request's task-local capture) finds the Preview a command belongs to.
    pub previews: Mutex<HashMap<usize, Arc<PreviewState>>>,
    pub pending: Mutex<HashMap<i32, Pending>>,
    /// Set when monitoring saw this client's own detection `hello`: proof the tripwire is installed on
    /// the guarded client itself.
    pub monitored: AtomicBool,
}

/// The registry key of a Preview's recorder.
pub(crate) fn key(recorder: &Arc<Recorder>) -> usize {
    Arc::as_ptr(recorder) as usize
}

impl Shared {
    pub fn new(reads: HashSet<String>) -> Arc<Self> {
        Arc::new(Self { reads, previews: Mutex::default(), pending: Mutex::default(), monitored: AtomicBool::new(false) })
    }

    fn registry(&self) -> MutexGuard<'_, HashMap<usize, Arc<PreviewState>>> {
        self.previews.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn state_of(&self, recorder: &Arc<Recorder>) -> Option<Arc<PreviewState>> {
        self.registry().get(&key(recorder)).cloned()
    }

    /// The recorder of the `preview`-mode Preview whose session is `lsid`: a command carrying it belongs
    /// to that Preview, whichever task sent it.
    pub fn preview_of_session(&self, lsid: Option<&Document>) -> Option<Arc<Recorder>> {
        let lsid = lsid?;
        self.registry().values().find(|state| state.lsid.as_ref() == Some(lsid)).map(|state| state.recorder.clone())
    }

    /// Registers a Preview's state under its recorder.
    pub fn register(&self, state: Arc<PreviewState>) {
        self.registry().insert(key(&state.recorder), state);
    }

    /// Removes a Preview's state, if it is still the one registered under its recorder.
    pub fn forget(&self, state: &Arc<PreviewState>) {
        let mut registry = self.registry();
        if registry.get(&key(&state.recorder)).is_some_and(|registered| Arc::ptr_eq(registered, state)) {
            registry.remove(&key(&state.recorder));
        }
    }
}
