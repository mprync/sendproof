//! Wire models of the preview envelope and observed-send trace.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

/// A row change reported by a preview provider.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Change {
    /// `insert`, `update` or `delete`.
    pub operation: String,
    /// Table (or collection) name.
    pub table: String,
    /// Primary key of the changed row.
    pub key: Option<Value>,
    /// Row before the change; `None` for an insert.
    pub before: Option<Value>,
    /// Row after the change; `None` for a delete.
    pub after: Option<Value>,
}

/// A side effect recorded by the host: an email, HTTP call, job or message.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Effect {
    /// `email`, `http`, `job`, `message`, or any host-defined kind.
    pub kind: String,
    /// Short human-readable description.
    pub description: String,
    /// Optional structured payload. The conventional shapes are in the protocol spec.
    pub data: Option<Value>,
    /// Set to `true` in an observed send when the host proceeded to deliver the effect.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered: Option<bool>,
}

/// A captured SQL parameter. Values are strings or null; redacted values are `[REDACTED]`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlParameter {
    pub name: String,
    pub value: Option<String>,
    pub db_type: String,
}

/// A captured SQL command.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlCapture {
    pub text: String,
    pub parameters: Vec<SqlParameter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows_affected: Option<u64>,
}

/// The exception attached to a log entry.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CapturedException {
    #[serde(rename = "type")]
    pub kind: String,
    pub message: String,
}

/// A structured log entry. SQL commands use `level: "Sql"` and a populated `sql` member.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub level: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exception: Option<CapturedException>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<SqlCapture>,
}

impl LogEntry {
    /// Creates an entry with only the required members.
    pub fn new(level: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            level: level.into(),
            message: message.into(),
            category: None,
            offset_ms: None,
            elapsed_ms: None,
            properties: None,
            exception: None,
            sql: None,
        }
    }

    pub(crate) fn size(&self) -> usize {
        self.level.len()
            + self.message.len()
            + self.category.as_ref().map_or(0, String::len)
            + self.properties.as_ref().map_or(0, |p| p.iter().map(|(k, v)| k.len() + v.len()).sum())
            + self.exception.as_ref().map_or(0, |e| e.kind.len() + e.message.len())
            + self.sql.as_ref().map_or(0, |s| {
                s.text.len()
                    + s.parameters.iter().map(|p| p.name.len() + p.value.as_ref().map_or(0, String::len) + p.db_type.len()).sum::<usize>()
            })
    }
}

/// Timing of one preview or observed send, in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub auth: f64,
    pub handler: f64,
    pub db: f64,
    pub query_count: u32,
    pub serialize: f64,
}

impl Timing {
    /// The `Server-Timing` header value: `auth`, `handler`, `db` and `serialize`.
    pub fn server_timing(&self) -> String {
        format!(
            "auth;dur={:.3}, handler;dur={:.3}, db;dur={:.3};desc=\"{} queries\", serialize;dur={:.3}",
            self.auth, self.handler, self.db, self.query_count, self.serialize
        )
    }
}

/// The confirmed preview envelope returned by `/bench/_preview`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEnvelope {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Value,
    pub changes: Vec<Change>,
    pub effects: Vec<Effect>,
    pub logs: Vec<LogEntry>,
    pub rolled_back: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub changes_truncated: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub effects_truncated: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub logs_truncated: bool,
}

/// The trace of an observed send, served at `/bench/_api/traces/{id}`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedTrace {
    pub changes: Vec<Change>,
    pub effects: Vec<Effect>,
    pub logs: Vec<LogEntry>,
    pub timing: Timing,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub changes_truncated: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub effects_truncated: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub logs_truncated: bool,
}
