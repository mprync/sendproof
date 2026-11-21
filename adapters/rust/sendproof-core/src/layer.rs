//! A `tracing` layer that copies the events of the current request into its capture.

use std::{collections::BTreeMap, fmt};

use tracing::{
    Event, Level, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context};

use crate::{
    capture, limits,
    model::{CapturedException, LogEntry},
    redact,
};

const SQLX_TARGET: &str = "sqlx::query";

/// Records `tracing` events emitted while a preview or observed send is running.
///
/// Add it to the subscriber of the application:
///
/// ```
/// use tracing_subscriber::layer::SubscriberExt;
/// let subscriber = tracing_subscriber::registry().with(sendproof_core::SendproofLayer::new());
/// # let _ = subscriber;
/// ```
///
/// Events from `sqlx::query` become SQL entries without parameters (SQLx does not expose them).
/// SQLite statements run on SQLx's worker thread and never reach this layer; the SQLite provider
/// records them itself.
#[derive(Debug, Default, Clone, Copy)]
pub struct SendproofLayer;

impl SendproofLayer {
    /// Creates the layer.
    pub fn new() -> Self {
        Self
    }
}

impl<S: Subscriber> Layer<S> for SendproofLayer {
    fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
        let Some(recorder) = capture::current() else { return };
        if !recorder.is_active() {
            return;
        }
        let mut fields = Fields::default();
        event.record(&mut fields);
        let metadata = event.metadata();
        if metadata.target() == SQLX_TARGET {
            if recorder.sqlx_events_muted() {
                return;
            }
            if let Some(entry) = sql_entry(&fields) {
                if entry.sql.as_ref().and_then(|sql| sql.rows_affected).is_some_and(|rows| rows > 0) {
                    recorder.note_unattributed_write();
                }
                recorder.push_entry(entry);
            }
            return;
        }
        let mut entry = LogEntry::new(level_name(*metadata.level()), limits::clip(&fields.message, limits::TEXT));
        entry.category = Some(limits::clip(metadata.target(), limits::NAME));
        if !fields.properties.is_empty() {
            entry.properties = Some(
                fields
                    .properties
                    .into_iter()
                    .take(limits::PROPERTIES)
                    .map(|(name, value)| {
                        // A secret-named field (`password`, `api_key`, ...) never shows its value.
                        let value = if redact::looks_secret(&name) { redact::REDACTED.to_owned() } else { value };
                        (limits::clip(&name, limits::NAME), value)
                    })
                    .collect(),
            );
        }
        if let Some(error) = fields.error {
            entry.exception = Some(CapturedException { kind: "Error".into(), message: limits::clip(&error, limits::TEXT) });
        }
        recorder.push_entry(entry);
    }
}

fn level_name(level: Level) -> &'static str {
    match level {
        Level::TRACE => "Trace",
        Level::DEBUG => "Debug",
        Level::INFO => "Information",
        Level::WARN => "Warning",
        Level::ERROR => "Error",
    }
}

fn sql_entry(fields: &Fields) -> Option<LogEntry> {
    let text = match fields.properties.get("db.statement").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(statement) => statement.to_owned(),
        None => fields.properties.get("summary")?.clone(),
    };
    let rows = fields.properties.get("rows_affected").and_then(|v| v.parse::<u64>().ok());
    let elapsed = fields.properties.get("elapsed_secs").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) * 1000.0;
    let (sql, _) = redact::capture_sql(&text, [], rows, false);
    let mut entry = LogEntry::new("Sql", sql.text.clone());
    entry.category = Some(SQLX_TARGET.to_owned());
    entry.elapsed_ms = Some(elapsed);
    entry.sql = Some(sql);
    Some(entry)
}

/// Formats `args` into at most [`limits::TEXT`] characters, stopping the formatter there, so a
/// huge field value is never formatted in full.
fn bounded(args: fmt::Arguments<'_>) -> String {
    struct Writer {
        text: String,
        room: usize,
    }
    impl fmt::Write for Writer {
        fn write_str(&mut self, part: &str) -> fmt::Result {
            for c in part.chars() {
                if self.room == 0 {
                    return Err(fmt::Error);
                }
                self.text.push(c);
                self.room -= 1;
            }
            Ok(())
        }
    }
    let mut writer = Writer { text: String::new(), room: limits::TEXT };
    let _ = fmt::write(&mut writer, args);
    writer.text
}

#[derive(Default)]
struct Fields {
    message: String,
    properties: BTreeMap<String, String>,
    error: Option<String>,
}

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.store(field, bounded(format_args!("{value:?}")));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.store(field, limits::clip(value, limits::TEXT));
    }
    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        let text = bounded(format_args!("{value}"));
        if self.error.is_none() {
            self.error = Some(text.clone());
        }
        self.store(field, text);
    }
}

impl Fields {
    fn store(&mut self, field: &Field, value: String) {
        match field.name() {
            "message" => self.message = value,
            name if name.starts_with("log.") => {}
            name => {
                self.properties.insert(name.to_owned(), value);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use tracing_subscriber::layer::SubscriberExt;

    use super::*;
    use crate::capture::Recorder;

    #[tokio::test]
    async fn redacts_secret_fields_and_bounds_their_values() {
        let _subscriber = tracing::subscriber::set_default(tracing_subscriber::registry().with(SendproofLayer::new()));
        let recorder = Recorder::new(Instant::now(), true);
        recorder.begin(false);
        let huge = "x".repeat(limits::TEXT * 4);
        capture::scope(recorder.clone(), async {
            tracing::info!(password = "hunter2", refresh_token = %"abc", body = %huge, user = "ann", "signed in");
        })
        .await;
        let logs = recorder.finish().logs;
        let properties = logs[0].properties.as_ref().expect("properties");
        assert_eq!(properties["password"], redact::REDACTED);
        assert_eq!(properties["refresh_token"], redact::REDACTED);
        assert_eq!(properties["user"], "ann");
        assert_eq!(properties["body"].chars().count(), limits::TEXT);
    }
}
