//! The write guard of `spec/data-stores.md`: the single decision point every store hook calls
//! before it sends a command, plus the helpers hooks share.
//!
//! Outside a Preview the guard does nothing, so Send and observed Send are never blocked. In a
//! Preview it records the first refused write on the request's recorder and returns
//! [`PreviewWriteBlocked`]. **The recorder's mark, not the handler's response, decides the outcome**:
//! a handler that swallows the error and returns 200 still produces a 409.

use std::{collections::HashSet, error::Error, fmt, sync::Arc};

use crate::{
    capture::{self, Blocked, DbEntry, Recorder},
    config::ConfigError,
    transport::Enrollment,
};

use super::classify::CommandKind;

/// Display names used in "Preview unavailable: this operation writes to <Store>".
pub fn store_name(store: &str) -> &str {
    match store {
        "mongodb" => "MongoDB",
        "redis" => "Redis",
        "dynamodb" => "DynamoDB",
        other => other,
    }
}

/// The reason shown for a write to a guarded store.
pub fn write_reason(store: &str) -> String {
    format!("Preview unavailable: this operation writes to {}", store_name(store))
}

/// Returned to the handler when the guard refuses a write. No byte of the command reached the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewWriteBlocked {
    /// The store id, such as `redis`.
    pub store: String,
    /// The refused command or action name.
    pub operation: String,
    /// The sentence the workbench shows.
    pub detail: String,
}

impl fmt::Display for PreviewWriteBlocked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({} {})", self.detail, store_name(&self.store), self.operation)
    }
}

impl Error for PreviewWriteBlocked {}

/// Returned when a handler tries to end or escape the Preview transaction: a MongoDB
/// `commitTransaction`, or a store command sent with a session other than the Preview's. The
/// Preview answers 500 without confirmation even if the handler swallows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewFault(pub String);

impl fmt::Display for PreviewFault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Error for PreviewFault {}

/// The recorder of a request, stored in the [`Enrollment`] so a store handle created in a handler
/// keeps its Preview even when a task it spawns has no task-local capture.
#[derive(Clone)]
pub struct CaptureScope(pub Arc<Recorder>);

/// The request is a preview, but this route was not enrolled by the Sendproof gate. Nothing was sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotEnrolled;

impl fmt::Display for NotEnrolled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("this preview request was not enrolled by the Sendproof gate")
    }
}

impl Error for NotEnrolled {}

/// What a store hook knows of the current request: its recorder, if any.
///
/// A hook built from an extractor holds the recorder of the request ([`from_enrollment`](Self::from_enrollment));
/// a hook with no handle to the request, such as an AWS SDK interceptor, reads the task-local
/// capture ([`current`](Self::current)).
#[derive(Clone, Default)]
pub struct StoreScope {
    recorder: Option<Arc<Recorder>>,
}

impl StoreScope {
    /// The task-local capture of the current request, if any.
    pub fn current() -> Self {
        Self { recorder: capture::current() }
    }

    /// The scope the Sendproof gate stored in the request. `required` says the request is a preview
    /// (the adapter inserted [`PreviewRequired`](crate::PreviewRequired)): without an enrollment it
    /// fails, so an undeclared route can never write during a preview.
    pub fn from_enrollment(enrollment: Option<&Enrollment>, required: bool) -> Result<Self, NotEnrolled> {
        let recorder = enrollment.and_then(|enrollment| enrollment.0.get::<CaptureScope>()).map(|scope| scope.0.clone());
        if recorder.is_none() && required { Err(NotEnrolled) } else { Ok(Self { recorder }) }
    }

    /// The recorder: the request's own, else the task-local one.
    pub fn recorder(&self) -> Option<Arc<Recorder>> {
        self.recorder.clone().or_else(capture::current)
    }

    /// Whether the request is a rollback preview.
    pub fn in_preview(&self) -> bool {
        self.recorder().is_some_and(|recorder| recorder.is_rollback_preview())
    }

    /// Call before sending a store command. Does nothing outside a Preview, or for anything but a
    /// write. In a Preview it marks the recorder blocked (the first block wins), logs a blocked `Db`
    /// entry and returns the error. `detail` replaces the default "writes to <Store>" reason, for
    /// example for a MongoDB command that can't run inside a transaction.
    pub fn guard(&self, store: &str, operation: &str, kind: CommandKind, detail: Option<&str>) -> Result<(), PreviewWriteBlocked> {
        if kind != CommandKind::Write {
            return Ok(());
        }
        let Some(recorder) = self.recorder().filter(|recorder| recorder.is_rollback_preview()) else {
            return Ok(());
        };
        let detail = detail.map_or_else(|| write_reason(store), str::to_owned);
        recorder.block(Blocked { store: store.to_owned(), operation: operation.to_owned(), detail: detail.clone() });
        recorder.record_db(DbEntry { system: store.to_owned(), operation: operation.to_owned(), blocked: true, ..DbEntry::default() });
        Err(PreviewWriteBlocked { store: store.to_owned(), operation: operation.to_owned(), detail })
    }

    /// Refuses something that would end or escape the Preview transaction. Records the fault on the
    /// Preview, so it answers 500 even if the handler swallows the error, and returns the error for the
    /// caller to return. Outside a Preview the error is returned without a mark.
    pub fn refuse(&self, message: impl Into<String>) -> PreviewFault {
        let message = message.into();
        if let Some(recorder) = self.recorder() {
            recorder.refuse(&message);
        }
        PreviewFault(message)
    }

    /// Records one command as a `Db` log entry, when a capture is recording.
    pub fn log(&self, entry: DbEntry) {
        if let Some(recorder) = self.recorder() {
            recorder.record_db(entry);
        }
    }
}

/// [`StoreScope::guard`] on the task-local capture, for hooks that can't reach the request.
pub fn guard(store: &str, operation: &str, kind: CommandKind, detail: Option<&str>) -> Result<(), PreviewWriteBlocked> {
    StoreScope::current().guard(store, operation, kind, detail)
}

/// Validates the optional label a host gives a store for capabilities `dataStores`.
///
/// Discovery is shown to anyone who can open the workbench, so the label must be a display name such
/// as `catalog`: never a connection string, URL, host:port, user or password.
pub fn store_label(name: &str) -> Result<String, ConfigError> {
    let forbidden = |c: char| c.is_control() || "/\\@=;:?#%".contains(c);
    if name.trim().is_empty() || name.chars().count() > 64 || name.chars().any(forbidden) {
        return Err(ConfigError(format!(
            "a data store name must be a display label such as `catalog`, not a connection string, URL or host (got `{name}`)"
        )));
    }
    Ok(name.to_owned())
}

/// Normalizes host-declared reads ("treat as read") into an exact-match set, after `transform`.
///
/// Names are exact: wildcards and whitespace are refused.
pub fn exact_names<I, S>(names: I, transform: impl Fn(&str) -> String) -> Result<HashSet<String>, ConfigError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    names
        .into_iter()
        .map(|name| {
            let name = name.as_ref();
            if name.is_empty() || name.contains(['*', '?']) || name.chars().any(char::is_whitespace) {
                Err(ConfigError(format!("treat-as-read takes exact command names, without wildcards (got `{name}`)")))
            } else {
                Ok(transform(name))
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn preview() -> Arc<Recorder> {
        let recorder = Recorder::new_preview(Instant::now(), true);
        recorder.begin(true);
        recorder
    }

    #[tokio::test]
    async fn a_write_in_a_preview_is_marked_and_refused() {
        let recorder = preview();
        let result = capture::scope(recorder.clone(), async { guard("redis", "INCR", CommandKind::Write, None) }).await;
        let error = result.unwrap_err();
        assert_eq!(error.detail, "Preview unavailable: this operation writes to Redis");
        let blocked = recorder.blocked().unwrap();
        assert_eq!((blocked.store.as_str(), blocked.operation.as_str()), ("redis", "INCR"));
        let logs = recorder.finish().logs;
        assert!(logs[0].db.as_ref().unwrap().blocked);
    }

    #[tokio::test]
    async fn reads_and_session_commands_pass() {
        let recorder = preview();
        capture::scope(recorder.clone(), async {
            for kind in [CommandKind::Read, CommandKind::Session, CommandKind::Transaction] {
                assert!(guard("redis", "GET", kind, None).is_ok());
            }
        })
        .await;
        assert!(recorder.blocked().is_none());
    }

    #[tokio::test]
    async fn outside_a_preview_nothing_is_blocked() {
        assert!(guard("redis", "INCR", CommandKind::Write, None).is_ok());
        let observed = Recorder::new(Instant::now(), true);
        observed.begin(false);
        capture::scope(observed.clone(), async { assert!(guard("redis", "INCR", CommandKind::Write, None).is_ok()) }).await;
        assert!(observed.blocked().is_none());
    }

    #[test]
    fn a_scope_taken_from_the_request_outlives_the_task_local_capture() {
        let recorder = preview();
        let scope = StoreScope { recorder: Some(recorder.clone()) };
        assert!(scope.guard("dynamodb", "UpdateItem", CommandKind::Write, None).is_err());
        // The mark is kept even after the capture stopped recording.
        recorder.finish();
        assert!(scope.guard("dynamodb", "PutItem", CommandKind::Write, None).is_err());
        assert_eq!(recorder.blocked().unwrap().operation, "UpdateItem", "the first block wins");
    }

    #[test]
    fn a_fault_is_kept_and_the_first_one_wins() {
        let recorder = preview();
        let scope = StoreScope { recorder: Some(recorder.clone()) };
        scope.refuse("first");
        scope.refuse("second");
        assert_eq!(recorder.fault().as_deref(), Some("first"));
    }

    #[test]
    fn an_unenrolled_preview_request_fails() {
        assert_eq!(StoreScope::from_enrollment(None, true).err(), Some(NotEnrolled));
        assert!(StoreScope::from_enrollment(None, false).is_ok());
    }

    #[test]
    fn labels_are_display_names() {
        assert!(store_label("catalog").is_ok());
        for bad in ["redis://u:p@host:6379", "host:6379", "a b;c", "", "x@y"] {
            assert!(store_label(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn host_reads_are_exact_names() {
        let set = exact_names(["mymodule.get"], str::to_ascii_uppercase).unwrap();
        assert!(set.contains("MYMODULE.GET"));
        assert!(exact_names(["MY*"], str::to_owned).is_err());
        assert!(exact_names(["A B"], str::to_owned).is_err());
    }
}
