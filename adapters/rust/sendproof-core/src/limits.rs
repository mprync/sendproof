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
/// Maximum size of the small JSON body selecting a Preview session step.
pub const REWIND_BODY_BYTES: usize = 1024;

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

/// Whether `value` serializes to at most [`PAYLOAD_BYTES`], measured with a writer that stops at
/// the limit, so an oversized value is never fully serialized. `None` when it cannot be serialized.
pub fn fits_payload(value: &impl serde::Serialize) -> Option<bool> {
    struct Bounded(usize);
    impl std::io::Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            if self.0 > PAYLOAD_BYTES { Err(std::io::Error::other("payload limit")) } else { Ok(bytes.len()) }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Bounded(0);
    match serde_json::to_writer(&mut writer, value) {
        Ok(()) => Some(true),
        Err(_) if writer.0 > PAYLOAD_BYTES => Some(false),
        Err(_) => None,
    }
}

/// Replaces the values of secret-named members (`password_hash`, `api_key`, ...) of a row image
/// with [`REDACTED`](crate::redact::REDACTED), using the same whole-word rules as SQL parameters.
/// Change snapshots come straight from the database, so they would otherwise show stored secrets.
///
/// Document stores nest: a secret-named member is hidden at any depth, and arrays are searched too.
pub fn redact_row(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (name, member) in map.iter_mut() {
                if !member.is_null() && crate::redact::looks_secret(name) {
                    *member = Value::String(crate::redact::REDACTED.to_owned());
                } else {
                    redact_row(member);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_row),
        _ => {}
    }
}

pub(crate) fn size(value: &Option<Value>) -> usize {
    value.as_ref().map_or(0, |value| value.to_string().len())
}

/// Applies the change-count, size and payload limits, and redacts secret-named columns.
/// Returns the changes and whether any were dropped.
pub fn snapshot_changes(changes: &[Change]) -> (Vec<Change>, bool) {
    let mut result = Vec::new();
    let mut truncated = changes.len() > CHANGES;
    let mut remaining = PAYLOAD_BUDGET as i64;
    let redacted = |value: Value| {
        let mut value = value;
        redact_row(&mut value);
        value
    };
    for change in changes.iter().take(CHANGES) {
        let key = change.key.as_ref().and_then(snapshot).map(redacted);
        let before = change.before.as_ref().and_then(snapshot).map(redacted);
        let after = change.after.as_ref().and_then(snapshot).map(redacted);
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
        result.push(Change {
            operation,
            table,
            key,
            before,
            after,
            store: change.store.as_deref().map(|store| clip(store, NAME)),
            namespace: change.namespace.as_deref().map(|namespace| clip(namespace, NAME)),
            via: change.via.as_deref().map(|via| clip(via, NAME)),
        });
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
    fn redacts_secret_columns_in_change_snapshots() {
        let change = Change {
            operation: "update".into(),
            table: "users".into(),
            key: Some(json!({"id": 1})),
            before: Some(json!({"id": 1, "name": "Ann", "password_hash": "old", "ApiKey": null})),
            after: Some(json!({"id": 1, "name": "Ann", "password_hash": "new", "api_key": "k", "monkey": "visible"})),
            ..Change::default()
        };
        let (kept, _) = snapshot_changes(&[change]);
        let after = kept[0].after.as_ref().unwrap();
        assert_eq!(after["password_hash"], crate::redact::REDACTED);
        assert_eq!(after["api_key"], crate::redact::REDACTED);
        assert_eq!(after["name"], "Ann");
        assert_eq!(after["monkey"], "visible");
        assert_eq!(kept[0].before.as_ref().unwrap()["password_hash"], crate::redact::REDACTED);
        assert_eq!(kept[0].key, Some(json!({"id": 1})));

        // A secret-named primary key is hidden in the key as well as in the row images.
        let keyed = Change {
            operation: "delete".into(),
            table: "sessions".into(),
            key: Some(json!({"session_token": "t-1"})),
            before: Some(json!({"session_token": "t-1", "password_digest": "d", "user": 7})),
            after: None,
            ..Change::default()
        };
        let (kept, _) = snapshot_changes(&[keyed]);
        assert_eq!(kept[0].key, Some(json!({"session_token": crate::redact::REDACTED})));
        assert_eq!(
            kept[0].before,
            Some(json!({"session_token": crate::redact::REDACTED, "password_digest": crate::redact::REDACTED, "user": 7}))
        );
    }

    #[test]
    fn measures_payloads_without_serializing_past_the_limit() {
        assert_eq!(fits_payload(&json!({"a": 1})), Some(true));
        assert_eq!(fits_payload(&"x".repeat(PAYLOAD_BYTES + 1)), Some(false));
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
                ..Change::default()
            })
            .collect();
        let (kept, truncated) = snapshot_changes(&changes);
        assert_eq!(kept.len(), CHANGES);
        assert!(truncated);
    }
}
