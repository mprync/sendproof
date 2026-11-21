//! Per-request capture of logs, effects, SQL and timing.
//!
//! The middleware of a framework adapter creates a [`Recorder`], activates it for the
//! duration of the request with [`scope`], and starts it with [`Recorder::begin`] once the
//! request is past authorization. Host code reaches the active recorder through [`current`]
//! or the free functions of this module. Outside a preview or observed send they do nothing.

use std::{
    future::Future,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::Value;

use crate::{
    limits,
    model::{Effect, LogEntry, SqlCapture, Timing},
};

tokio::task_local! {
    static CURRENT: Arc<Recorder>;
}

/// Runs `future` with `recorder` as the current request's recorder.
///
/// Tasks spawned from `future` do not inherit the recorder; capture stays scoped to the request.
pub async fn scope<F: Future>(recorder: Arc<Recorder>, future: F) -> F::Output {
    CURRENT.scope(recorder, future).await
}

/// Returns the recorder of the current request, if one is active.
pub fn current() -> Option<Arc<Recorder>> {
    CURRENT.try_with(Arc::clone).ok()
}

/// Records an effect on the current request. Returns `true` when the host must **suppress** the
/// effect (a rollback preview), and `false` when it should proceed (a normal or observed send).
pub fn record_effect(kind: &str, description: &str, data: impl Serialize) -> bool {
    current().is_some_and(|recorder| recorder.record_effect(kind, description, data))
}

/// Records an email effect. Returns `true` when delivery must be suppressed.
pub fn record_email(description: &str, email: &EmailEffect) -> bool {
    record_effect("email", description, email)
}

/// Records an outgoing HTTP call. Returns `true` when the call must be suppressed.
pub fn record_http(description: &str, call: &HttpEffect) -> bool {
    record_effect("http", description, call)
}

/// Records a background job. Returns `true` when scheduling must be suppressed.
pub fn record_job(description: &str, job: &JobEffect) -> bool {
    record_effect("job", description, job)
}

/// Records a published message. Returns `true` when publishing must be suppressed.
pub fn record_message(description: &str, message: &MessageEffect) -> bool {
    record_effect("message", description, message)
}

/// Records a log entry on the current request. Returns whether a capture is active.
pub fn record_log(level: &str, message: &str) -> bool {
    current().is_some_and(|recorder| recorder.record_log(level, message))
}

/// Conventional `data` of an `email` effect.
#[derive(Debug, Clone, Default, Serialize)]
pub struct EmailEffect {
    pub from: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub text: String,
    pub html: Option<String>,
}

/// Conventional `data` of an `http` effect.
#[derive(Debug, Clone, Default, Serialize)]
pub struct HttpEffect {
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub body: Option<Value>,
}

/// Conventional `data` of a `job` effect.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEffect {
    pub name: String,
    pub arguments: Option<Value>,
    pub queue: Option<String>,
    /// ISO 8601 timestamp.
    pub run_at: Option<String>,
}

/// Conventional `data` of a `message` effect.
#[derive(Debug, Clone, Default, Serialize)]
pub struct MessageEffect {
    pub topic: String,
    pub payload: Option<Value>,
    pub key: Option<String>,
}

/// What a recorder collected.
#[derive(Debug, Default)]
pub struct CaptureSnapshot {
    pub effects: Vec<Effect>,
    pub logs: Vec<LogEntry>,
    pub logs_truncated: bool,
    pub effects_truncated: bool,
}

#[derive(Default)]
struct Inner {
    active: bool,
    rollback: bool,
    effects: Vec<Effect>,
    logs: Vec<LogEntry>,
    logs_truncated: bool,
    effects_truncated: bool,
    log_size: usize,
    effect_size: usize,
    db_ms: f64,
    queries: u32,
    serialize_ms: f64,
    handler_start: Option<Instant>,
    handler_end: Option<Instant>,
}

/// Collects the logs, effects, SQL commands and timing of one request.
pub struct Recorder {
    started: Instant,
    show_sql_values: bool,
    /// While non-zero, `sqlx::query` tracing events are ignored (see [`Recorder::mute_sqlx_events`]).
    sqlx_muted: AtomicUsize,
    /// `sqlx::query` events of statements that changed rows and that no data layer recorded itself.
    unattributed_writes: AtomicUsize,
    inner: Mutex<Inner>,
}

/// Keeps `sqlx::query` tracing events out of the capture until dropped.
///
/// Returned by [`Recorder::mute_sqlx_events`].
pub struct SqlxMute(Arc<Recorder>);

impl Drop for SqlxMute {
    fn drop(&mut self) {
        self.0.sqlx_muted.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Recorder {
    /// Creates an inactive recorder for a request that started at `started`.
    pub fn new(started: Instant, show_sql_values: bool) -> Arc<Self> {
        Arc::new(Self {
            started,
            show_sql_values,
            sqlx_muted: AtomicUsize::new(0),
            unattributed_writes: AtomicUsize::new(0),
            inner: Mutex::new(Inner::default()),
        })
    }

    /// Creates an inactive recorder for a rollback preview. Until [`begin`](Self::begin) it records
    /// nothing, but already tells hosts to suppress effects: a preview never delivers one, even from
    /// a handler that was reached without being enrolled.
    pub fn new_preview(started: Instant, show_sql_values: bool) -> Arc<Self> {
        let recorder = Self::new(started, show_sql_values);
        recorder.lock().rollback = true;
        recorder
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Capture must never take the application down: recover from a poisoned lock.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Starts recording. `rollback` is `true` for a preview and `false` for an observed send.
    pub fn begin(&self, rollback: bool) {
        let mut inner = self.lock();
        inner.rollback = rollback;
        inner.active = true;
    }

    /// Whether SQL parameter values may be shown (subject to redaction).
    pub fn show_sql_values(&self) -> bool {
        self.show_sql_values
    }

    /// Ignores `sqlx::query` tracing events until the guard is dropped.
    ///
    /// A data layer that records a statement itself (with its parameters) uses this so the
    /// [`TestBenchLayer`](crate::TestBenchLayer) does not log the same statement a second time,
    /// and so its own bookkeeping statements never appear in the capture.
    pub fn mute_sqlx_events(self: &Arc<Self>) -> SqlxMute {
        self.sqlx_muted.fetch_add(1, Ordering::SeqCst);
        SqlxMute(self.clone())
    }

    /// Whether `sqlx::query` tracing events are currently ignored.
    pub fn sqlx_events_muted(&self) -> bool {
        self.sqlx_muted.load(Ordering::SeqCst) > 0
    }

    /// Notes a statement, seen by the tracing layer, that changed rows outside any data layer's own
    /// recording (for example a raw SQLx statement).
    pub fn note_unattributed_write(&self) {
        self.unattributed_writes.fetch_add(1, Ordering::SeqCst);
    }

    /// How many statements changed rows without a data layer recording them. A data layer that
    /// captures rows per statement uses this to say its list of changes is incomplete.
    pub fn unattributed_writes(&self) -> usize {
        self.unattributed_writes.load(Ordering::SeqCst)
    }

    /// Whether a rollback-only preview is recording.
    pub fn is_preview(&self) -> bool {
        let inner = self.lock();
        inner.active && inner.rollback
    }

    /// Whether any capture is recording.
    pub fn is_active(&self) -> bool {
        self.lock().active
    }

    /// Marks the moment the handler starts. Everything before it counts as `auth` time.
    pub fn start_handler(&self) {
        self.lock().handler_start = Some(Instant::now());
    }

    /// Marks the moment the handler finished.
    pub fn end_handler(&self) {
        self.lock().handler_end = Some(Instant::now());
    }

    /// Records an effect. Returns `true` when the host must suppress it.
    pub fn record_effect(&self, kind: &str, description: &str, data: impl Serialize) -> bool {
        let started = Instant::now();
        {
            let mut inner = self.lock();
            if !inner.active {
                return inner.rollback;
            }
            if inner.effects.len() == limits::EFFECTS || inner.effect_size >= limits::LOG_BUDGET {
                inner.effects_truncated = true;
                return inner.rollback;
            }
        }
        // Measure the payload with a bounded writer first, so an oversized payload is never
        // materialized as a JSON tree.
        let (data, oversized) = match limits::fits_payload(&data) {
            Some(true) => (serde_json::to_value(&data).ok().filter(|value| !value.is_null()), false),
            Some(false) => (None, true),
            None => (None, false),
        };
        self.record_effect_value(kind, description, data, oversized, started)
    }

    fn record_effect_value(&self, kind: &str, description: &str, data: Option<Value>, oversized: bool, started: Instant) -> bool {
        let mut inner = self.lock();
        if !inner.active {
            return inner.rollback;
        }
        let rollback = inner.rollback;
        if inner.effects.len() == limits::EFFECTS || inner.effect_size >= limits::LOG_BUDGET {
            inner.effects_truncated = true;
            return rollback;
        }
        inner.effects_truncated |= oversized;
        let captured = data.as_ref().and_then(limits::snapshot);
        inner.serialize_ms += started.elapsed().as_secs_f64() * 1000.0;
        let kind_clipped = limits::clip(kind, limits::NAME);
        let description_clipped = limits::clip(description, limits::TEXT);
        inner.effect_size += kind_clipped.len() + description_clipped.len() + limits::size(&captured);
        inner.effects_truncated |= kind_clipped != kind || description_clipped != description || (captured.is_none() && data.is_some());
        if inner.effect_size <= limits::LOG_BUDGET {
            inner.effects.push(Effect {
                kind: kind_clipped,
                description: description_clipped,
                data: captured,
                delivered: (!rollback).then_some(true),
            });
        } else {
            inner.effects_truncated = true;
        }
        rollback
    }

    /// Records a plain log entry. Returns whether a capture is active.
    pub fn record_log(&self, level: &str, message: &str) -> bool {
        let mut inner = self.lock();
        if !inner.active {
            return false;
        }
        let mut entry = LogEntry::new(clip_logged(&mut inner, level, limits::NAME), clip_logged(&mut inner, message, limits::TEXT));
        entry.offset_ms = Some(self.offset_ms());
        push_log(&mut inner, entry);
        true
    }

    /// Records a fully built log entry, applying the log limits. Used by the tracing layer.
    pub fn push_entry(&self, mut entry: LogEntry) {
        let mut inner = self.lock();
        if !inner.active {
            return;
        }
        entry.offset_ms.get_or_insert_with(|| self.offset_ms());
        push_log(&mut inner, entry);
    }

    /// Records a SQL command for a provider: counts it towards `db` timing and adds a `Sql` log entry.
    pub fn record_sql(&self, duration: Duration, category: &str, sql: SqlCapture, truncated: bool) {
        let mut inner = self.lock();
        if !inner.active {
            return;
        }
        let millis = duration.as_secs_f64() * 1000.0;
        inner.db_ms += millis;
        inner.queries = inner.queries.saturating_add(1);
        if !has_room(&mut inner) {
            return;
        }
        inner.logs_truncated |= truncated;
        let mut entry = LogEntry::new("Sql", sql.text.clone());
        entry.category = Some(limits::clip(category, limits::NAME));
        entry.offset_ms = Some((self.offset_ms() - millis).max(0.0));
        entry.elapsed_ms = Some(millis);
        entry.sql = Some(sql);
        push_log(&mut inner, entry);
    }

    /// The timing so far, with `extra_serialize_ms` added to the serialization metric.
    pub fn timing(&self, extra_serialize_ms: f64) -> Timing {
        let inner = self.lock();
        let handler_start = inner.handler_start.unwrap_or(self.started);
        let handler_end = inner.handler_end.unwrap_or_else(Instant::now);
        let millis = |from: Instant, to: Instant| to.saturating_duration_since(from).as_secs_f64() * 1000.0;
        Timing {
            auth: millis(self.started, handler_start),
            handler: (millis(handler_start, handler_end) - inner.db_ms - inner.serialize_ms).max(0.0),
            db: inner.db_ms,
            query_count: inner.queries,
            serialize: inner.serialize_ms + extra_serialize_ms,
        }
    }

    /// Stops recording and takes what was collected.
    pub fn finish(&self) -> CaptureSnapshot {
        let mut inner = self.lock();
        inner.active = false;
        CaptureSnapshot {
            effects: std::mem::take(&mut inner.effects),
            logs: std::mem::take(&mut inner.logs),
            logs_truncated: inner.logs_truncated,
            effects_truncated: inner.effects_truncated,
        }
    }

    fn offset_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }
}

fn clip_logged(inner: &mut Inner, value: &str, maximum: usize) -> String {
    let clipped = limits::clip(value, maximum);
    inner.logs_truncated |= clipped.len() != value.len();
    clipped
}

fn has_room(inner: &mut Inner) -> bool {
    let room = inner.logs.len() < limits::LOGS && inner.log_size < limits::LOG_BUDGET;
    inner.logs_truncated |= !room;
    room
}

fn push_log(inner: &mut Inner, entry: LogEntry) {
    if has_room(inner) {
        let size = entry.size();
        if inner.log_size + size <= limits::LOG_BUDGET {
            inner.logs.push(entry);
            inner.log_size += size;
        } else {
            inner.logs_truncated = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn started() -> Arc<Recorder> {
        let recorder = Recorder::new(Instant::now(), true);
        recorder.begin(true);
        recorder
    }

    #[test]
    fn preview_suppresses_effects_and_observed_send_delivers_them() {
        let preview = started();
        assert!(preview.record_effect("email", "Created", json!({"to": ["a@b"]})));
        assert_eq!(preview.finish().effects[0].delivered, None);

        let observed = Recorder::new(Instant::now(), true);
        observed.begin(false);
        assert!(!observed.record_effect("email", "Created", json!({})));
        assert_eq!(observed.finish().effects[0].delivered, Some(true));
    }

    #[test]
    fn inactive_recorder_records_nothing() {
        let recorder = Recorder::new(Instant::now(), true);
        assert!(!recorder.record_effect("email", "x", json!({})));
        assert!(!recorder.record_log("Information", "x"));
        assert!(recorder.finish().logs.is_empty());
    }

    #[test]
    fn an_unstarted_preview_recorder_suppresses_effects_without_recording_them() {
        let recorder = Recorder::new_preview(Instant::now(), true);
        assert!(recorder.record_effect("email", "Sent before enrollment", json!({"to": ["a@b"]})));
        assert!(recorder.finish().effects.is_empty());
    }

    #[test]
    fn an_oversized_effect_payload_is_dropped_before_it_is_built() {
        let recorder = started();
        let big = "x".repeat(limits::PAYLOAD_BYTES + 1);
        assert!(recorder.record_effect("http", "Large", json!({ "body": big })));
        let snapshot = recorder.finish();
        assert_eq!(snapshot.effects[0].data, None);
        assert!(snapshot.effects_truncated);
    }

    #[test]
    fn caps_effects_and_logs() {
        let recorder = started();
        for i in 0..limits::EFFECTS + 3 {
            recorder.record_effect("message", &format!("m{i}"), json!({"i": i}));
        }
        for i in 0..limits::LOGS + 3 {
            recorder.record_log("Information", &format!("log {i}"));
        }
        let snapshot = recorder.finish();
        assert_eq!(snapshot.effects.len(), limits::EFFECTS);
        assert!(snapshot.effects_truncated);
        assert_eq!(snapshot.logs.len(), limits::LOGS);
        assert!(snapshot.logs_truncated);
    }

    #[tokio::test]
    async fn scope_exposes_the_recorder_to_host_code() {
        assert!(current().is_none());
        let recorder = started();
        scope(recorder.clone(), async {
            assert!(record_log("Information", "created:1"));
            assert!(record_effect("email", "Created item", json!({})));
        })
        .await;
        assert_eq!(recorder.finish().logs[0].message, "created:1");
    }
}
