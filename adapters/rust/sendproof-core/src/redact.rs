//! Redaction of secret-looking SQL parameters.

use crate::{
    limits,
    model::{SqlCapture, SqlParameter},
};

/// The value shown in place of a redacted parameter.
pub const REDACTED: &str = "[REDACTED]";

// Matched against whole words, so `IdempotencyKey` or `Monkey` stay visible while
// `PasswordHash`, `api_key` and `RefreshToken` are hidden.
const SECRET_WORDS: &[&str] = &["password", "passwd", "pwd", "secret", "token", "hash", "salt", "credential", "credentials", "apikey"];

// "key" alone is ordinary (primary key, idempotency key); it is secret only after these words.
const KEY_QUALIFIERS: &[&str] = &["api", "private", "secret", "access", "signing", "encryption", "client"];

/// Whether an identifier or statement names a secret, judged by whole words.
pub fn looks_secret(text: &str) -> bool {
    let mut previous: Option<String> = None;
    for word in words(text) {
        let lower = word.to_ascii_lowercase();
        if SECRET_WORDS.contains(&lower.as_str()) || (lower == "key" && previous.as_deref().is_some_and(|p| KEY_QUALIFIERS.contains(&p))) {
            return true;
        }
        previous = Some(lower);
    }
    false
}

/// Splits identifiers and SQL text into words at punctuation, underscores and camel-case boundaries.
fn words(text: &str) -> Vec<&str> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut result = Vec::new();
    let mut start: Option<usize> = None;
    for index in 0..=chars.len() {
        let current = chars.get(index).map(|&(_, c)| c);
        let letter = current.is_some_and(char::is_alphanumeric);
        let boundary =
            !letter || (start.is_some() && current.is_some_and(char::is_uppercase) && index > 0 && chars[index - 1].1.is_lowercase());
        if boundary && let Some(first) = start.take() {
            let end = chars.get(index).map_or(text.len(), |&(offset, _)| offset);
            result.push(&text[chars[first].0..end]);
        }
        if letter && start.is_none() {
            start = Some(index);
        }
    }
    result
}

/// Builds a captured SQL command, applying the redaction rules.
///
/// When values are shown and the statement text names a secret, every value in that
/// statement is hidden: a positional placeholder carries no column information, and
/// inferring bindings from fragments of SQL is unsafe. A parameter whose own name looks
/// secret is always hidden. With `show_values == false` every value is hidden.
/// Returns the capture and whether anything was truncated.
pub fn capture_sql(
    text: &str,
    parameters: impl IntoIterator<Item = (String, Option<String>, String)>,
    rows_affected: Option<u64>,
    show_values: bool,
) -> (SqlCapture, bool) {
    let clipped = limits::clip(text, limits::TEXT);
    let mut truncated = clipped.len() != text.len();
    let redact_statement = show_values && looks_secret(text);
    let mut captured = Vec::new();
    for (index, (name, value, db_type)) in parameters.into_iter().enumerate() {
        if index == limits::PARAMETERS {
            truncated = true;
            break;
        }
        let shown_name = limits::clip(&name, limits::NAME);
        truncated |= shown_name != name;
        let redact = !show_values || redact_statement || looks_secret(&name);
        let value = if redact {
            Some(REDACTED.to_owned())
        } else {
            value.map(|value| {
                let clipped = limits::clip(&value, limits::TEXT);
                truncated |= clipped.len() != value.len();
                clipped
            })
        };
        captured.push(SqlParameter { name: shown_name, value, db_type });
    }
    (SqlCapture { text: clipped, parameters: captured, rows_affected }, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_whole_word_secrets_only() {
        for secret in ["PasswordHash", "api_key", "RefreshToken", "fixture_secret", "client key", "UPDATE users SET salt = ?"] {
            assert!(looks_secret(secret), "{secret} should look secret");
        }
        for ordinary in ["IdempotencyKey", "Monkey", "primary key", "items", "name", "Hashtag"] {
            assert!(!looks_secret(ordinary), "{ordinary} should be visible");
        }
    }

    #[test]
    fn redacts_every_value_of_a_secret_statement() {
        let (sql, _) = capture_sql("SELECT ?1 AS fixture_secret", [("$1".into(), Some("hunter2".into()), "TEXT".into())], None, true);
        assert_eq!(sql.parameters[0].value.as_deref(), Some(REDACTED));
        let (plain, _) = capture_sql("SELECT ?1", [("$1".into(), Some("x".into()), "TEXT".into())], None, true);
        assert_eq!(plain.parameters[0].value.as_deref(), Some("x"));
        let (hidden, _) = capture_sql("SELECT ?1", [("$1".into(), Some("x".into()), "TEXT".into())], None, false);
        assert_eq!(hidden.parameters[0].value.as_deref(), Some(REDACTED));
    }
}
