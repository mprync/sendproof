//! Capture limits shared by every adapter. They match the .NET adapters.

use serde_json::Value;

use crate::model::Change;

/// Maximum number of captured log entries per request.
pub const LOGS: usize = 500;
/// Maximum number of captured effects per request.
pub const EFFECTS: usize = 100;
/// Maximum number of captured row changes per request.
pub const CHANGES: usize = 200;
/// Maximum number of log properties, and of fields in a row snapshot.
pub const PROPERTIES: usize = 32;
/// Maximum number of SQL parameters, array items or object members in a captured payload.
pub const PARAMETERS: usize = 64;
/// Maximum length of a name, category, kind or table.
pub const NAME: usize = 256;
/// Maximum length of a message, SQL text or captured string.
pub const TEXT: usize = 4096;
/// Maximum serialized size of one captured payload.
pub const PAYLOAD_BYTES: usize = 16 * 1024;
/// Total size budget for logs, and for effects.
pub const LOG_BUDGET: usize = 128 * 1024;
/// Total size budget for the row changes of one request.
pub const PAYLOAD_BUDGET: usize = 128 * 1024;
/// Maximum JSON nesting depth of a captured payload.
pub const MAX_DEPTH: usize = 16;
/// Maximum size of a buffered preview response body (1 MiB).
pub const PREVIEW_BODY_BYTES: usize = 1024 * 1024;

/// Truncates `value` to at most `maximum` characters.
pub fn clip(value: &str, maximum: usize) -> String {
    match value.char_indices().nth(maximum) {
        Some((end, _)) => value[..end].to_owned(),
        None => value.to_owned(),
    }
}

/// Returns the value when it fits the payload limits, or `None` when it is too large or too deep.
///
/// Capture must never interrupt the application, so oversized payloads become `None`
/// and the caller marks the collection as truncated.
pub fn snapshot(value: &Value) -> Option<Value> {
    let size = serde_json::to_vec(value).ok()?.len();
    (size <= PAYLOAD_BYTES && fits(value, 0)).then(|| value.clone())
}

fn fits(value: &Value, depth: usize) -> bool {
    depth < MAX_DEPTH
        && match value {
            Value::String(text) => text.chars().count() <= TEXT,
            Value::Array(items) => items.len() <= PARAMETERS && items.iter().all(|item| fits(item, depth + 1)),
            Value::Object(map) => {
                map.len() <= PARAMETERS && map.iter().all(|(name, item)| name.chars().count() <= NAME && fits(item, depth + 1))
            }
            _ => true,
        }
}

pub(crate) fn size(value: &Option<Value>) -> usize {
    value.as_ref().map_or(0, |value| value.to_string().len())
}

/// Applies the change-count, size and payload limits. Returns the changes and whether any were dropped.
pub fn snapshot_changes(changes: &[Change]) -> (Vec<Change>, bool) {
    let mut result = Vec::new();
    let mut truncated = changes.len() > CHANGES;
    let mut remaining = PAYLOAD_BUDGET as i64;
    for change in changes.iter().take(CHANGES) {
        let key = change.key.as_ref().and_then(snapshot);
        let before = change.before.as_ref().and_then(snapshot);
        let after = change.after.as_ref().and_then(snapshot);
        let operation = clip(&change.operation, NAME);
        let table = clip(&change.table, NAME);
        remaining -= (size(&key) + size(&before) + size(&after) + operation.len() + table.len()) as i64;
        if remaining < 0 {
            truncated = true;
            break;
        }
        truncated |= (key.is_none() && change.key.is_some())
            || (before.is_none() && change.before.is_some())
            || (after.is_none() && change.after.is_some())
            || operation != change.operation
            || table != change.table;
        result.push(Change { operation, table, key, before, after });
    }
    (result, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clips_on_character_boundaries() {
        assert_eq!(clip("héllo", 2), "hé");
        assert_eq!(clip("abc", 10), "abc");
    }

    #[test]
    fn rejects_deep_and_wide_payloads() {
        let mut deep = json!(1);
        for _ in 0..MAX_DEPTH {
            deep = json!([deep]);
        }
        assert!(snapshot(&deep).is_none());
        let wide = Value::Array(vec![json!(1); PARAMETERS + 1]);
        assert!(snapshot(&wide).is_none());
        assert!(snapshot(&json!({"a": [1, 2, 3]})).is_some());
    }

    #[test]
    fn limits_change_count() {
        let changes: Vec<_> = (0..CHANGES + 5)
            .map(|i| Change {
                operation: "insert".into(),
                table: "items".into(),
                key: Some(json!({"id": i})),
                before: None,
                after: Some(json!({"id": i})),
            })
            .collect();
        let (kept, truncated) = snapshot_changes(&changes);
        assert_eq!(kept.len(), CHANGES);
        assert!(truncated);
    }
}
