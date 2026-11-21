//! Statement capture for SQLite through `sqlite3_trace_v2`.
//!
//! SQLx runs SQLite on a worker thread, so its `tracing` events never reach the request's task.
//! The trace callback instead reports every finished statement to the request's recorder.
//! It sees the statement text with placeholders and never the bound values.

use std::{
    ffi::{CStr, c_int, c_uint, c_void},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{Arc, Mutex},
    time::Duration,
};

use libsqlite3_sys as ffi;
use sendproof_core::{capture::Recorder, redact};
use sqlx::SqliteConnection;

/// Parameters announced by [`crate::NamedQuery`] for the statement it is about to run.
pub(crate) struct Pending {
    pub(crate) text: String,
    pub(crate) parameters: Vec<(String, Option<String>, String)>,
}

/// The sink of the trace callback for one enrolled connection.
pub(crate) struct SqlTrace {
    recorder: Arc<Recorder>,
    pending: Mutex<Option<Pending>>,
}

impl SqlTrace {
    pub(crate) fn announce(&self, pending: Option<Pending>) {
        *self.pending.lock().unwrap_or_else(|p| p.into_inner()) = pending;
    }

    fn take(&self) -> Option<Pending> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).take()
    }
}

/// Starts reporting statements of `connection` to `recorder`.
pub(crate) async fn install(connection: &mut SqliteConnection, recorder: Arc<Recorder>) -> Result<Arc<SqlTrace>, sqlx::Error> {
    let trace = Arc::new(SqlTrace { recorder, pending: Mutex::new(None) });
    let mut handle = connection.lock_handle().await?;
    let context = Arc::into_raw(trace.clone()) as *mut c_void;
    // SAFETY: the handle is locked, so the worker is idle. The context holds a strong
    // reference that is released in `remove`, so the callback never sees a freed value.
    unsafe {
        ffi::sqlite3_trace_v2(handle.as_raw_handle().as_ptr(), ffi::SQLITE_TRACE_PROFILE as c_uint, Some(profile), context);
    }
    Ok(trace)
}

/// Stops reporting and releases the callback's reference.
pub(crate) async fn remove(connection: &mut SqliteConnection, trace: &Arc<SqlTrace>) -> Result<(), sqlx::Error> {
    let mut handle = connection.lock_handle().await?;
    // SAFETY: as in `install`. Clearing the callback first guarantees no further use of the
    // context before the strong reference taken in `install` is released.
    unsafe {
        ffi::sqlite3_trace_v2(handle.as_raw_handle().as_ptr(), 0, None, std::ptr::null_mut());
        Arc::decrement_strong_count(Arc::as_ptr(trace));
    }
    Ok(())
}

unsafe extern "C" fn profile(mask: c_uint, context: *mut c_void, statement: *mut c_void, nanoseconds: *mut c_void) -> c_int {
    if mask != ffi::SQLITE_TRACE_PROFILE as c_uint || context.is_null() || statement.is_null() || nanoseconds.is_null() {
        return 0;
    }
    // A panic must never unwind into SQLite.
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: SQLite passes the context given to `sqlite3_trace_v2`, kept alive by `install`.
        let trace = unsafe { &*(context as *const SqlTrace) };
        let statement = statement as *mut ffi::sqlite3_stmt;
        // SAFETY: for SQLITE_TRACE_PROFILE `statement` is a prepared statement and the last
        // argument points to the elapsed time in nanoseconds.
        let (text, elapsed, rows) = unsafe {
            let sql = ffi::sqlite3_sql(statement);
            let text = if sql.is_null() { String::new() } else { CStr::from_ptr(sql).to_string_lossy().into_owned() };
            let elapsed = Duration::from_nanos(u64::try_from(*(nanoseconds as *const i64)).unwrap_or(0));
            let rows = (ffi::sqlite3_stmt_readonly(statement) == 0)
                .then(|| u64::try_from(ffi::sqlite3_changes(ffi::sqlite3_db_handle(statement))).unwrap_or(0));
            (text, elapsed, rows)
        };
        let (text, parameters) = match trace.take() {
            Some(pending) => (pending.text, pending.parameters),
            None => (text, Vec::new()),
        };
        let (sql, truncated) = redact::capture_sql(&text, parameters, rows, trace.recorder.show_sql_values());
        trace.recorder.record_sql(elapsed, "Sendproof.Sql", sql, truncated);
    }));
    0
}
