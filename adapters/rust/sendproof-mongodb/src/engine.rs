//! The per-client engine: topology detection, the Preview's session and transaction, change
//! capture, and the time limit.
//!
//! * **Topology:** `hello` decides the mode. A replica set or mongos with logical sessions runs in
//!   `preview` mode; anything else, or a reply it doesn't recognise, in `guard` mode.
//! * **Session:** each `preview`-mode Preview gets one client session with a snapshot/majority
//!   transaction. Handles pass it to every operation. Nothing ever commits it: the engine only aborts.
//! * **Finish:** after the handler, changes are read (inside the transaction for `after`, and at the
//!   transaction's own snapshot time for `before`), then the transaction is aborted and the session
//!   released. A Preview that outlives its time limit is aborted early and answers 500. An abort no
//!   reply acknowledged is followed by `killSessions`, so a dropped connection doesn't leave the
//!   transaction holding its locks until the server's lifetime limit.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use mongodb::{
    Client, ClientSession,
    bson::{Bson, Document, doc},
    error::{Error, ErrorKind},
    options::{ReadConcern, WriteConcern},
};
use sendproof_core::{BoxError, BoxFuture, Changes, PreviewSession, capture::Recorder, model::Change};
use tokio::sync::Mutex as AsyncMutex;

use crate::{
    monitor::{ABORTING, DETECTING, INTERNAL},
    plain,
    preview::{Candidate, Mode, PreviewState, STANDALONE_REASON, Shared, UNMONITORED_REASON, UNREACHABLE_REASON},
};

/// The default Preview time limit: below the server's 60-second `transactionLifetimeLimitSeconds`, so
/// the binding, not the server, ends a Preview whose handler runs too long.
pub const DEFAULT_PREVIEW_TIMEOUT: Duration = Duration::from_secs(50);

/// How long the engine keeps trying to end a Preview transaction whose abort no reply acknowledged,
/// and the backoff between tries. Well inside the server's 60-second transaction lifetime.
const KILL_RETRY_LIMIT: Duration = Duration::from_secs(10);
const KILL_FIRST_DELAY: Duration = Duration::from_millis(100);
const KILL_MAX_DELAY: Duration = Duration::from_secs(2);

/// Most candidate documents read back for change capture in one Preview.
const CANDIDATE_LIMIT: usize = 1000;

/// Server error codes meaning the collection or snapshot didn't exist at the start time.
const NAMESPACE_NOT_FOUND: i32 = 26;
const SNAPSHOT_UNAVAILABLE: i32 = 246;
/// `NoSuchTransaction`: the server already ended it, so there is nothing to capture.
const NO_SUCH_TRANSACTION: i32 = 251;

/// The detected topology.
#[derive(Clone)]
pub(crate) struct Detected {
    pub mode: Mode,
    pub reason: Option<&'static str>,
    /// `false` when the client's own `hello` came back without reaching its command monitor: the
    /// tripwire isn't on this client, so it never begins a Preview. (An unreachable server proves
    /// nothing either way, and a write can't reach it.)
    pub monitored: bool,
}

/// One engine per hooked client.
pub(crate) struct Engine {
    pub client: Client,
    pub database: String,
    pub shared: Arc<Shared>,
    pub timeout: Duration,
    detected: AsyncMutex<Option<Detected>>,
}

/// The mode a `hello` reply allows: `preview` on a replica set or mongos with logical sessions,
/// `guard` for a standalone server or any reply this doesn't recognise.
pub(crate) fn topology(hello: &Document) -> Detected {
    let sessions = !matches!(hello.get("logicalSessionTimeoutMinutes"), None | Some(Bson::Null));
    let clustered = hello.get_str("setName").is_ok() || hello.get_str("msg") == Ok("isdbgrid");
    let mode = if clustered && sessions { Mode::Preview } else { Mode::Guard };
    Detected { mode, reason: (mode == Mode::Guard).then_some(STANDALONE_REASON), monitored: true }
}

pub(crate) fn code_of(error: &Error) -> i32 {
    match &*error.kind {
        ErrorKind::Command(command) => command.code,
        _ => 0,
    }
}

impl Engine {
    pub fn new(client: Client, database: String, shared: Arc<Shared>, timeout: Duration) -> Arc<Self> {
        Arc::new(Self { client, database, shared, timeout, detected: AsyncMutex::new(None) })
    }

    /// Pretends detection found `detected` (tests only).
    #[cfg(test)]
    pub async fn set_detected(&self, detected: Detected) {
        *self.detected.lock().await = Some(detected);
    }

    /// Detects the topology once: `preview` on a replica set or mongos with logical sessions. A server
    /// that can't be reached runs in `guard` mode for now, and is asked again next time.
    pub async fn detect(&self) -> Detected {
        let mut detected = self.detected.lock().await;
        if let Some(known) = detected.as_ref() {
            return known.clone();
        }
        let hello =
            INTERNAL.scope((), DETECTING.scope((), async { self.client.database("admin").run_command(doc! { "hello": 1 }).await })).await;
        // An unreachable server proves nothing either way: guard mode for now, asked again next time.
        let Ok(hello) = hello else { return Detected { mode: Mode::Guard, reason: Some(UNREACHABLE_REASON), monitored: true } };
        let result = if !self.shared.monitored.load(std::sync::atomic::Ordering::SeqCst) {
            Detected { mode: Mode::Guard, reason: Some(UNMONITORED_REASON), monitored: false }
        } else {
            topology(&hello)
        };
        *detected = Some(result.clone());
        result
    }

    /// Prepares a Preview: detects the mode and, in `preview` mode, starts the Preview's session and
    /// transaction and its time limit. The state is registered under the Preview's recorder so the
    /// command monitor finds it.
    pub async fn begin(self: &Arc<Self>, recorder: &Arc<Recorder>) -> Result<Arc<PreviewState>, Error> {
        let detected = self.detect().await;
        if !detected.monitored {
            return Err(Error::custom(sendproof_core::ConfigError(UNMONITORED_REASON.into())));
        }
        let state = match detected.mode {
            Mode::Preview => {
                let mut session = self.client.start_session().await?;
                session.start_transaction().read_concern(ReadConcern::snapshot()).write_concern(WriteConcern::majority()).await?;
                PreviewState::new(session, recorder.clone())
            }
            Mode::Guard => PreviewState::guard(recorder.clone()),
        };
        self.shared.register(state.clone());
        if state.mode == Mode::Preview {
            // A handler still running at the limit loses its transaction: later operations fail, nothing
            // commits, and the Preview answers 500 when it ends.
            let (engine, recorder, state_for_timer, limit) = (self.clone(), recorder.clone(), state.clone(), self.timeout);
            let timer = tokio::spawn(async move {
                tokio::time::sleep(limit).await;
                recorder.refuse(&format!("The Preview ran longer than {} ms, so its MongoDB transaction was aborted.", limit.as_millis()));
                engine.end(&state_for_timer, true).await;
            });
            state.data().timer = Some(timer);
        }
        Ok(state)
    }

    /// Aborts the Preview transaction and releases its session, once. The session's lock is taken
    /// first, so an operation in flight completes before the abort and none can follow it: a command
    /// sent on a session after an abort would run outside any transaction, and commit.
    ///
    /// The driver ignores abort errors, as the transactions specification requires: an unacknowledged
    /// abort still commits nothing, because no `commitTransaction` is ever sent for the Preview
    /// session. But the server then keeps the transaction, and its locks, until its 60-second
    /// lifetime limit. So when a command was sent on the session and no reply acknowledged the abort,
    /// this returns `false` at once (the Preview answers 500) and kills the session in the background.
    pub async fn end(self: &Arc<Self>, state: &PreviewState, from_timer: bool) -> bool {
        let Some(session) = &state.session else { return true };
        // Already ended: return without waiting for the lock, which a background kill may still hold.
        if state.data().finished {
            return true;
        }
        let mut session = session.clone().lock_owned().await;
        let opened = {
            let mut data = state.data();
            if data.finished {
                return true;
            }
            data.finished = true;
            // The timer must not cancel itself while it aborts.
            if let Some(timer) = data.timer.take()
                && !from_timer
            {
                timer.abort();
            }
            data.opened
        };
        let acknowledged = Arc::new(AtomicBool::new(false));
        let _ = INTERNAL.scope((), ABORTING.scope(acknowledged.clone(), async { session.abort_transaction().await })).await;
        if !opened || acknowledged.load(Ordering::SeqCst) {
            return true;
        }
        if let Some(lsid) = state.lsid.clone() {
            let engine = self.clone();
            tokio::spawn(async move {
                engine.kill(&lsid).await;
                // Held until here, so the driver can't hand the session id to another operation meanwhile.
                drop(session);
            });
        }
        false
    }

    /// Ends the Preview transaction with `killSessions` after an abort no reply acknowledged (the
    /// connection dropped), retrying with backoff while the server can't be reached. A final failure
    /// is logged with the session id: the server ends the transaction at its lifetime limit.
    async fn kill(&self, lsid: &Document) {
        let attempts = async {
            let mut delay = KILL_FIRST_DELAY;
            loop {
                let admin = self.client.database("admin");
                let killed = INTERNAL.scope((), async { admin.run_command(doc! { "killSessions": [lsid.clone()] }).await }).await;
                match killed {
                    Ok(_) => return Ok(()),
                    Err(error) if code_of(&error) != 0 => return Err(error.to_string()),
                    // A network error or no server to select: try again shortly.
                    Err(_) => tokio::time::sleep(delay).await,
                }
                delay = (delay * 2).min(KILL_MAX_DELAY);
            }
        };
        let failure = match tokio::time::timeout(KILL_RETRY_LIMIT, attempts).await {
            Ok(Ok(())) => return,
            Ok(Err(error)) => error,
            Err(_) => format!("MongoDB couldn't be reached for {} s", KILL_RETRY_LIMIT.as_secs()),
        };
        tracing::warn!(
            session = %lsid,
            %failure,
            "couldn't end a MongoDB Preview transaction; the server ends it, and releases its locks, at transactionLifetimeLimitSeconds"
        );
    }

    /// Reads documents as they were when the Preview transaction started: a snapshot read at its
    /// start time, outside the transaction, as a raw `find` command. Without a start time (no reply
    /// carried one) it reads the majority-committed view, which the spec allows: nothing the Preview
    /// wrote is committed, so the only difference is a concurrent commit by another request.
    async fn at_start(
        &self,
        state: &PreviewState,
        namespace: &str,
        collection: &str,
        filter: &Document,
        projection: Option<&Document>,
    ) -> Result<Vec<Document>, Error> {
        let read_concern = match state.data().start_time {
            Some(time) => doc! { "level": "snapshot", "atClusterTime": time },
            None => doc! { "level": "majority" },
        };
        let mut command = doc! {
            "find": collection,
            "filter": filter.clone(),
            "batchSize": CANDIDATE_LIMIT as i64,
            "limit": CANDIDATE_LIMIT as i64,
            "singleBatch": true,
            "readConcern": read_concern,
        };
        if let Some(projection) = projection {
            command.insert("projection", projection.clone());
        }
        match self.client.database(namespace).run_command(command).await {
            Ok(reply) => Ok(reply
                .get_document("cursor")
                .ok()
                .and_then(|cursor| cursor.get_array("firstBatch").ok())
                .map(|batch| batch.iter().filter_map(Bson::as_document).cloned().collect())
                .unwrap_or_default()),
            // The collection was created after the start time: nothing in it existed then.
            Err(error) if matches!(code_of(&error), NAMESPACE_NOT_FOUND | SNAPSHOT_UNAVAILABLE) => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }

    /// Compares each candidate's start-time and in-transaction versions and records the differences.
    async fn capture(&self, state: &PreviewState, session: &mut ClientSession) -> Result<Changes, Error> {
        let filters = state.data().filters.clone();
        let projection = doc! { "_id": 1 };
        for filter in filters {
            let target = self.client.database(&filter.namespace).collection::<Document>(&filter.collection);
            let mut cursor = target.find(filter.filter.clone()).projection(projection.clone()).session(&mut *session).await?;
            let mut inside = Vec::new();
            while let Some(document) = cursor.next(&mut *session).await {
                inside.push(document?);
            }
            let before = self.at_start(state, &filter.namespace, &filter.collection, &filter.filter, Some(&projection)).await?;
            for document in inside.into_iter().chain(before) {
                state.candidate(Candidate {
                    namespace: filter.namespace.clone(),
                    collection: filter.collection.clone(),
                    id: document.get("_id").cloned().unwrap_or(Bson::Null),
                    via: filter.via,
                });
                if state.data().candidates.len() >= CANDIDATE_LIMIT {
                    break;
                }
            }
        }
        let candidates = state.data().candidates.clone();
        let mut changes = Changes::default();
        for (read, candidate) in candidates.into_iter().enumerate() {
            if read >= CANDIDATE_LIMIT {
                changes.truncated = true;
                break;
            }
            let target = self.client.database(&candidate.namespace).collection::<Document>(&candidate.collection);
            let before = self
                .at_start(state, &candidate.namespace, &candidate.collection, &doc! { "_id": candidate.id.clone() }, None)
                .await?
                .into_iter()
                .next();
            let after = target.find_one(doc! { "_id": candidate.id.clone() }).session(&mut *session).await?;
            let (was, now) =
                (before.map(|document| plain(&Bson::Document(document))), after.map(|document| plain(&Bson::Document(document))));
            if was == now {
                continue;
            }
            let operation = match (&was, &now) {
                (None, _) => "insert",
                (_, None) => "delete",
                _ => "update",
            };
            changes.changes.push(Change {
                operation: operation.into(),
                table: candidate.collection.clone(),
                key: Some(serde_json::json!({ "_id": plain(&candidate.id) })),
                before: was,
                after: now,
                store: Some(crate::SYSTEM.into()),
                namespace: Some(candidate.namespace.clone()),
                via: candidate.via.filter(|_| operation != "delete").map(str::to_owned),
            });
        }
        Ok(changes)
    }
}

/// A `preview`-mode store's session in the Preview pipeline: `rollback` captures the changes and
/// aborts, `close` releases whatever is left.
pub(crate) struct MongoSession {
    pub engine: Arc<Engine>,
    pub state: Arc<PreviewState>,
    pub changes: Changes,
}

impl PreviewSession for MongoSession {
    /// Captures document changes, then aborts the transaction. A capture read that fails for any reason
    /// but an already-ended transaction fails, after the abort, so the Preview answers 500, as does an
    /// abort the server never acknowledged. Nothing the
    /// Preview wrote is ever committed: no `commitTransaction` is ever sent for the Preview session.
    fn rollback(&mut self) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async move {
            let (engine, state) = (self.engine.clone(), self.state.clone());
            let Some(session) = state.session.clone() else { return Ok(()) };
            let mut failure: Option<BoxError> = None;
            if state.data().used && !state.data().finished {
                let result = {
                    let mut session = session.lock().await;
                    INTERNAL.scope((), engine.capture(&state, &mut session)).await
                };
                match result {
                    Ok(changes) => self.changes = changes,
                    // A failed command inside a transaction makes the server abort it: nothing to capture.
                    Err(error) if code_of(&error) == NO_SUCH_TRANSACTION => {}
                    Err(error) => failure = Some(error.into()),
                }
            }
            if !engine.end(&state, false).await && failure.is_none() {
                // The server may still hold the transaction's locks; the session is killed in the background.
                failure =
                    Some("MongoDB didn't acknowledge the abort of the Preview transaction, so the rollback can't be confirmed.".into());
            }
            match failure {
                Some(error) => Err(error),
                None => Ok(()),
            }
        })
    }

    fn changes(&mut self) -> Changes {
        std::mem::take(&mut self.changes)
    }

    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), BoxError>> {
        Box::pin(async move {
            self.engine.end(&self.state, false).await;
            self.engine.shared.forget(&self.state);
            Ok(())
        })
    }
}

/// A Preview whose pipeline never finished (the client disconnected and the server dropped the request,
/// or an outer timeout cancelled it) is forgotten and its transaction aborted now, rather than held,
/// with its locks, until the time limit fires.
impl Drop for MongoSession {
    fn drop(&mut self) {
        self.engine.shared.forget(&self.state);
        if self.state.session.is_some()
            && !self.state.data().finished
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let (engine, state) = (self.engine.clone(), self.state.clone());
            runtime.spawn(async move { engine.end(&state, false).await });
        }
    }
}
