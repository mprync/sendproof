//! Replaces the literals in PartiQL text, so a value never appears in a `Db` entry.

/// Replaces every literal in PartiQL text with `?`: single-quoted strings (with `''` escapes) and
/// numbers. Double-quoted identifiers (table and attribute names) are kept as written.
///
/// A statement may inline values instead of using `?` parameters, and a value never appears in a
/// `Db` entry.
pub fn sanitize_partiql(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        match current {
            '"' => {
                // A quoted identifier: kept as written, through the closing quote.
                let end = chars[index + 1..].iter().position(|&c| c == '"').map_or(chars.len(), |offset| index + 1 + offset + 1);
                out.extend(&chars[index..end]);
                index = end;
            }
            '\'' => {
                let mut end = index + 1;
                while end < chars.len() {
                    if chars[end] == '\'' {
                        if chars.get(end + 1) == Some(&'\'') {
                            end += 2;
                            continue;
                        }
                        break;
                    }
                    end += 1;
                }
                out.push('?');
                index = end + 1;
            }
            digit if digit.is_ascii_digit() && !index.checked_sub(1).is_some_and(|before| chars[before].is_alphanumeric() || chars[before] == '_' || chars[before] == '.') => {
                let mut end = index;
                let numeric = |c: char| c.is_ascii_digit();
                while end < chars.len() && numeric(chars[end]) {
                    end += 1;
                }
                if chars.get(end) == Some(&'.') && chars.get(end + 1).is_some_and(|c| numeric(*c)) {
                    end += 1;
                    while end < chars.len() && numeric(chars[end]) {
                        end += 1;
                    }
                }
                if matches!(chars.get(end), Some('e' | 'E')) {
                    let mut exponent = end + 1;
                    if matches!(chars.get(exponent), Some('+' | '-')) {
                        exponent += 1;
                    }
                    if chars.get(exponent).is_some_and(|c| numeric(*c)) {
                        while exponent < chars.len() && numeric(chars[exponent]) {
                            exponent += 1;
                        }
                        end = exponent;
                    }
                }
                out.push('?');
                index = end;
            }
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::sanitize_partiql;

    #[test]
    fn replaces_strings_and_numbers_and_keeps_identifiers() {
        assert_eq!(sanitize_partiql(r#"UPDATE "orders" SET status = 'cancelled', hits = 3 WHERE id = ?"#), r#"UPDATE "orders" SET status = ?, hits = ? WHERE id = ?"#);
        assert_eq!(sanitize_partiql("INSERT INTO \"t\" VALUE {'id': 'it''s', 'n': 1.5e3}"), "INSERT INTO \"t\" VALUE {?: ?, ?: ?}");
    }

    #[test]
    fn digits_inside_names_survive() {
        assert_eq!(sanitize_partiql(r#"SELECT col1, "a'b" FROM "t2" WHERE x = 10"#), r#"SELECT col1, "a'b" FROM "t2" WHERE x = ?"#);
    }

    #[test]
    fn an_unterminated_string_hides_the_rest() {
        assert_eq!(sanitize_partiql("SELECT 'secret"), "SELECT ?");
    }
}
