//! The command monitor: the tripwire, the `Db` log, and the change candidates.
//!
//! Command monitoring reports a command; it can't stop it. So it backs the guarded handles up:
//!
//! * a **write** during a Preview that doesn't carry the Preview's `lsid` and `autocommit: false`
//!   escaped the transaction, so the Preview fails with 500 and is never confirmed;
//! * a **`commitTransaction` or `abortTransaction`** that reaches the server during a Preview may have
//!   ended the Preview transaction, so the Preview can never be confirmed either;
//! * a reply with code 263 (`OperationNotSupportedInTransaction`) is a **block**: the server refused
//!   something a transaction can't do and applied nothing;
//! * every other command becomes a `Db` log entry, and writes yield change candidates.
//!
//! The handler runs in the task that sent the command, so the request's task-local capture finds the
//! Preview. Commands the engine sends itself run under [`INTERNAL`] and are ignored.

use std::sync::Arc;

use mongodb::{
    bson::{Bson, Document, Timestamp},
    error::ErrorKind,
    event::command::CommandEvent,
};
use sendproof_core::{
    capture::{self, Blocked, Recorder},
    stores::CommandKind,
};

use crate::{
    classify::classify_mongo,
    preview::{Candidate, Filter, Mode, Pending, Shared, refused_reason},
    sanitize::sanitize_document,
};

tokio::task_local! {
    /// Set while the engine itself talks to the server, so monitoring ignores those commands.
    pub(crate) static INTERNAL: ();
}

/// Whether the current task is running an engine-internal command.
pub(crate) fn internal() -> bool {
    INTERNAL.try_with(|()| ()).is_ok()
}

/// Commands the monitoring specification marks security-sensitive: never logged.
const SENSITIVE: &[&str] =
    &["authenticate", "saslstart", "saslcontinue", "getnonce", "createuser", "updateuser", "copydbgetnonce", "copydbsaslstart", "copydb"];

/// Fields the driver adds to every command; they carry no meaning for the log and are dropped.
const ENVELOPE: &[&str] = &[
    "lsid",
    "txnNumber",
    "autocommit",
    "startTransaction",
    "$clusterTime",
    "$db",
    "$readPreference",
    "readConcern",
    "writeConcern",
    "apiVersion",
    "apiStrict",
    "apiDeprecationErrors",
];

/// Most commands waiting for their reply at once, across every request.
const MAX_PENDING: usize = 4096;

/// Commands that end a transaction. In a Preview only the engine may send them.
pub(crate) fn ends_transaction(lower: &str) -> bool {
    lower == "committransaction" || lower == "aborttransaction"
}

/// Whether an update document replaces the whole document rather than applying operators.
fn replaces(update: Option<&Bson>) -> bool {
    matches!(update, Some(Bson::Document(update)) if update.keys().next().is_some_and(|key| !key.starts_with('$')))
}

fn via_of(upsert: bool, update: Option<&Bson>) -> Option<&'static str> {
    if upsert {
        Some("upsert")
    } else if replaces(update) {
        Some("replace")
    } else {
        None
    }
}

fn flag(document: &Document, key: &str) -> bool {
    matches!(document.get(key), Some(Bson::Boolean(true)))
}

impl Shared {
    /// Handles one command event. Never panics and never blocks: it runs in the request's task.
    pub(crate) fn handle(self: &Arc<Self>, event: CommandEvent) {
        match event {
            CommandEvent::Started(event) => self.started(&event.command, &event.command_name, &event.db, event.request_id),
            CommandEvent::Succeeded(event) => self.succeeded(event.request_id, &event.reply, event.duration),
            CommandEvent::Failed(event) => {
                let (code, name) = match &*event.failure.kind {
                    ErrorKind::Command(error) => (error.code, error.code_name.clone()),
                    other => (0, format!("{other:?}").split(['(', ' ', '{']).next().unwrap_or("Error").to_owned()),
                };
                self.failed(event.request_id, code, name, event.duration);
            }
            _ => {}
        }
    }

    fn started(&self, command: &Document, name: &str, database: &str, request_id: i32) {
        if internal() {
            return;
        }
        let lower = name.to_lowercase();
        let kind = classify_mongo(command, Some(&self.reads)).kind;
        // A command carrying a Preview's session belongs to that Preview even when it was sent from a task
        // the handler spawned, which has no task-local capture.
        let session = self.preview_of_session(command.get_document("lsid").ok());
        let capture = capture::current().filter(|current| session.as_ref().is_none_or(|preview| Arc::ptr_eq(current, preview))).or(session);
        let preview = capture.clone().filter(|recorder| recorder.is_rollback_preview());
        if let Some(preview) = &preview {
            if ends_transaction(&lower) {
                // Sent around the hook: it may have committed the Preview transaction, so the Preview can never be confirmed.
                preview.refuse(&format!("A MongoDB {name} reached the server during a Preview; the Preview can't be confirmed."));
            } else if kind == CommandKind::Write {
                self.watch_write(preview, command, database, &lower);
            }
        }
        if kind == CommandKind::Session || SENSITIVE.contains(&lower.as_str()) {
            return;
        }
        let body: Document = command
            .iter()
            .filter(|(field, _)| !ENVELOPE.contains(&field.as_str()))
            .map(|(field, value)| (field.clone(), value.clone()))
            .collect();
        let mut sanitized = sanitize_document(&body);
        // The command's own collection name is a name, not a value: `{"update":"documents", ...}`.
        if let Some((first, Bson::String(collection))) = command.iter().next() {
            sanitized.insert(first.clone(), Bson::String(collection.clone()));
        }
        let statement = serde_json::to_string(&sanitized).unwrap_or_default();
        let target = command.get(name).and_then(Bson::as_str).map(str::to_owned);
        let pending = Pending {
            capture,
            preview,
            name: name.to_owned(),
            namespace: database.to_owned(),
            target,
            statement,
            lsid: command.get_document("lsid").ok().cloned(),
        };
        let mut waiting = self.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // A command whose reply never arrives (its future was dropped) leaves an entry behind; bound them.
        if waiting.len() >= MAX_PENDING {
            waiting.clear();
        }
        waiting.insert(request_id, pending);
    }

    /// A write seen during a Preview: collect change candidates, or trip if it escaped the session.
    fn watch_write(&self, preview: &Arc<Recorder>, command: &Document, namespace: &str, name: &str) {
        let state = self.state_of(preview);
        // Only a command inside the Preview transaction (its lsid and autocommit: false) rolls back.
        let inside = state.as_ref().is_some_and(|state| {
            !state.data().finished
                && state.lsid.is_some()
                && state.lsid.as_ref() == command.get_document("lsid").ok()
                && command.get("autocommit") == Some(&Bson::Boolean(false))
        });
        let Some(state) = state.filter(|_| inside) else {
            // The hook couldn't stop it and nothing can undo it: never claim a rollback.
            preview.refuse(&format!("A MongoDB {name} escaped the Preview session; the Preview can't be confirmed."));
            return;
        };
        state.data().used = true;
        let collection = command.values().next().and_then(Bson::as_str).unwrap_or_default().to_owned();
        let namespace = namespace.to_owned();
        let documents = |key: &str| command.get_array(key).ok().map(|items| items.iter().filter_map(Bson::as_document).collect::<Vec<_>>());
        match name {
            "insert" => {
                for document in documents("documents").unwrap_or_default() {
                    state.candidate(Candidate {
                        namespace: namespace.clone(),
                        collection: collection.clone(),
                        id: document.get("_id").cloned().unwrap_or(Bson::Null),
                        via: None,
                    });
                }
            }
            "update" => {
                for update in documents("updates").unwrap_or_default() {
                    let via = via_of(flag(update, "upsert"), update.get("u"));
                    let filter = update.get_document("q").cloned().unwrap_or_default();
                    state.data().filters.push(Filter { namespace: namespace.clone(), collection: collection.clone(), filter, via });
                }
            }
            "delete" => {
                for remove in documents("deletes").unwrap_or_default() {
                    let filter = remove.get_document("q").cloned().unwrap_or_default();
                    state.data().filters.push(Filter { namespace: namespace.clone(), collection: collection.clone(), filter, via: None });
                }
            }
            "findandmodify" => {
                let via = via_of(flag(command, "upsert"), command.get("update"));
                let filter = command.get_document("query").cloned().unwrap_or_default();
                state.data().filters.push(Filter { namespace, collection, filter, via });
            }
            "bulkwrite" => self.watch_bulk(&state, command, &namespace),
            _ => {}
        }
    }

    /// The client-level `bulkWrite` command: each op names its namespace by index.
    fn watch_bulk(&self, state: &crate::preview::PreviewState, command: &Document, namespace: &str) {
        let (Ok(ops), Ok(info)) = (command.get_array("ops"), command.get_array("nsInfo")) else { return };
        let namespaces: Vec<(String, String)> = info
            .iter()
            .filter_map(|entry| entry.as_document()?.get_str("ns").ok())
            .map(|ns| {
                ns.split_once('.')
                    .map_or((ns.to_owned(), String::new()), |(database, collection)| (database.to_owned(), collection.to_owned()))
            })
            .collect();
        for op in ops.iter().filter_map(Bson::as_document) {
            let index = ["insert", "update", "delete"].iter().find_map(|key| op.get_i32(key).ok()).unwrap_or(0) as usize;
            let (database, collection) = namespaces.get(index).cloned().unwrap_or_else(|| (namespace.to_owned(), String::new()));
            if let Ok(document) = op.get_document("document") {
                state.candidate(Candidate {
                    namespace: database,
                    collection,
                    id: document.get("_id").cloned().unwrap_or(Bson::Null),
                    via: None,
                });
            } else {
                let filter = op.get_document("filter").cloned().unwrap_or_default();
                state.data().filters.push(Filter { namespace: database, collection, filter, via: flag(op, "upsert").then_some("upsert") });
            }
        }
    }

    fn take(&self, request_id: i32) -> Option<Pending> {
        self.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&request_id)
    }

    fn succeeded(&self, request_id: i32, reply: &Document, duration: std::time::Duration) {
        let Some(pending) = self.take(request_id) else { return };
        let state = pending.preview.as_ref().and_then(|preview| self.state_of(preview)).filter(|state| state.mode == Mode::Preview);
        if let Some(state) = &state {
            // The first reply in the transaction carries its snapshot time (the read timestamp).
            let operation_time: Option<Timestamp> = reply.get_timestamp("operationTime").ok();
            if operation_time.is_some() && pending.lsid == state.lsid && state.data().start_time.is_none() {
                state.data().start_time = operation_time;
            }
            if let Some(collection) = &pending.target {
                let (namespace, collection) = (pending.namespace.clone(), collection.clone());
                // Upserted ids appear only in the reply.
                for upsert in reply.get_array("upserted").ok().into_iter().flatten().filter_map(Bson::as_document) {
                    state.candidate(Candidate {
                        namespace: namespace.clone(),
                        collection: collection.clone(),
                        id: upsert.get("_id").cloned().unwrap_or(Bson::Null),
                        via: Some("upsert"),
                    });
                }
                if pending.name.eq_ignore_ascii_case("findAndModify")
                    && let Some(id) = reply.get_document("value").ok().and_then(|value| value.get("_id"))
                {
                    state.candidate(Candidate { namespace: namespace.clone(), collection: collection.clone(), id: id.clone(), via: None });
                }
                if let Some(id) = reply.get_document("lastErrorObject").ok().and_then(|object| object.get("upserted")) {
                    state.candidate(Candidate { namespace, collection, id: id.clone(), via: Some("upsert") });
                }
            }
        }
        let rows = match reply.get_document("cursor") {
            Ok(cursor) => cursor.get_array("firstBatch").or_else(|_| cursor.get_array("nextBatch")).ok().map(|batch| batch.len() as u64),
            Err(_) => reply.get("n").and_then(|n| match n {
                Bson::Int32(n) => u64::try_from(*n).ok(),
                Bson::Int64(n) => u64::try_from(*n).ok(),
                _ => None,
            }),
        };
        pending.log(duration, rows, None);
    }

    fn failed(&self, request_id: i32, code: i32, name: String, duration: std::time::Duration) {
        let Some(pending) = self.take(request_id) else { return };
        // The server refused something a transaction can't do and applied nothing: a block, not a crash.
        if code == 263
            && let Some(preview) = &pending.preview
            && self.state_of(preview).is_some_and(|state| state.mode == Mode::Preview)
        {
            preview.block(Blocked { store: crate::SYSTEM.into(), operation: pending.name.clone(), detail: refused_reason(&pending.name) });
        }
        pending.log(duration, None, Some(if name.is_empty() { "Error".into() } else { name }));
    }
}
