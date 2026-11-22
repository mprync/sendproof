//! Write classification for Cassandra (CQL), driven by `spec/data-stores/cassandra.json` (embedded in
//! [`tables`](super::tables)), plus the statement scanner the SQL endpoints of Elasticsearch and
//! OpenSearch share.
//!
//! The unit is the statement's first keyword. Reads are listed; **everything else, including text the
//! scanner can't read, is a write**. Every function here is pure; the shared vectors in
//! `spec/data-stores/classification-cases.json` run through them in this module's tests.

use std::{collections::HashSet, sync::OnceLock};

use serde_json::Value;

use super::{classify::CommandKind, tables};

/// What the guard needs to know about one classified request: how to treat it and what to call it in
/// the `Db` log entry and the 409 body (`db.operation.name`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    /// How the guard treats it.
    pub kind: CommandKind,
    /// The operation name, such as `SELECT`, `BATCH` or `update_by_query`.
    pub operation: String,
}

/// Which quoting and comment forms a statement scanner knows.
#[derive(Debug, Clone, Copy, Default)]
pub struct Dialect {
    /// `` `name` `` quotes (SQL as OpenSearch and Elasticsearch read it).
    pub backticks: bool,
    /// CQL's `$$ ... $$` strings.
    pub dollar: bool,
    /// `//` line comments (CQL).
    pub slash_comments: bool,
}

impl Dialect {
    /// CQL: `$$` strings and `//` comments.
    pub const CQL: Self = Self { backticks: false, dollar: true, slash_comments: true };
    /// The SQL of Elasticsearch and OpenSearch: backtick quotes.
    pub const SQL: Self = Self { backticks: true, dollar: false, slash_comments: false };
}

/// The shape of one statement, read the way the server would.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Shape {
    /// The first word in upper case, after whitespace and comments; `""` when there is none.
    pub first: String,
    /// The second word, for `LIST ROLES` and the like.
    pub second: String,
    /// Anything but whitespace and comments follows a semicolon outside quotes.
    pub multiple: bool,
    /// An unterminated quote or comment: the text can't be trusted to mean what it seems to.
    pub broken: bool,
}

struct Scanner<'a> {
    text: &'a str,
    at: usize,
    dialect: Dialect,
}

/// An unterminated quote or block comment.
struct Unterminated;

impl Scanner<'_> {
    fn rest(&self) -> &str {
        &self.text[self.at..]
    }

    /// Skips one comment if the text is at one. `Err` for a block comment that never closes.
    fn comment(&mut self) -> Result<bool, Unterminated> {
        let rest = self.rest();
        if rest.starts_with("--") || (self.dialect.slash_comments && rest.starts_with("//")) {
            self.at = rest.find('\n').map_or(self.text.len(), |end| self.at + end + 1);
            return Ok(true);
        }
        if let Some(body) = rest.strip_prefix("/*") {
            let end = body.find("*/").ok_or(Unterminated)?;
            self.at += 2 + end + 2;
            return Ok(true);
        }
        Ok(false)
    }

    fn skip(&mut self) -> Result<(), Unterminated> {
        loop {
            let trimmed = self.rest().trim_start();
            self.at = self.text.len() - trimmed.len();
            if !self.comment()? {
                return Ok(());
            }
        }
    }

    fn word(&mut self) -> Result<String, Unterminated> {
        self.skip()?;
        let word: String = self.rest().chars().take_while(|c| c.is_ascii_alphabetic() || *c == '_').collect();
        self.at += word.len();
        Ok(word.to_ascii_uppercase())
    }

    /// The quote that opens at the current position, if any.
    fn quote(&self) -> Option<&'static str> {
        let rest = self.rest();
        match rest.chars().next()? {
            '\'' => Some("'"),
            '"' => Some("\""),
            '`' if self.dialect.backticks => Some("`"),
            '$' if self.dialect.dollar && rest.starts_with("$$") => Some("$$"),
            _ => None,
        }
    }

    /// Skips a quoted string, treating a doubled quote character as an escape (not in `$$` strings).
    fn skip_quoted(&mut self, quote: &str) -> Result<(), Unterminated> {
        let mut end = self.at + quote.len();
        loop {
            let found = self.text[end..].find(quote).ok_or(Unterminated)? + end;
            if quote != "$$" && self.text[found + quote.len()..].starts_with(quote) {
                end = found + 2 * quote.len();
                continue;
            }
            self.at = found + quote.len();
            return Ok(());
        }
    }

    fn scan(&mut self) -> Result<Shape, Unterminated> {
        let first = self.word()?;
        let second = self.word()?;
        let mut multiple = false;
        while self.at < self.text.len() {
            if self.comment()? {
                continue;
            }
            if let Some(quote) = self.quote() {
                self.skip_quoted(quote)?;
                continue;
            }
            let char = self.rest().chars().next().unwrap_or(';');
            self.at += char.len_utf8();
            if char == ';' {
                self.skip()?;
                multiple = self.at < self.text.len();
                break;
            }
        }
        Ok(Shape { first, second, multiple, broken: false })
    }
}

/// Reads the shape of one statement: its first two words (upper case, after whitespace and
/// comments), whether anything but whitespace and comments follows a semicolon outside quotes, and
/// whether a quote or comment never closes. Quotes are `'...'` and `"..."` with doubled-quote
/// escapes; the [`Dialect`] adds backticks, `$$` strings and `//` comments.
pub fn statement_shape(text: &str, dialect: Dialect) -> Shape {
    Scanner { text, at: 0, dialect }.scan().unwrap_or(Shape { broken: true, ..Shape::default() })
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("an embedded table is valid JSON")
}

fn list(table: &Value, list: &str) -> HashSet<String> {
    table[list].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

struct Cassandra {
    read: HashSet<String>,
    session: HashSet<String>,
}

fn cassandra() -> &'static Cassandra {
    static TABLE: OnceLock<Cassandra> = OnceLock::new();
    TABLE.get_or_init(|| {
        let table = parse(tables::CASSANDRA);
        Cassandra { read: list(&table, "read"), session: list(&table["protocol"], "session") }
    })
}

/// Classifies one CQL statement.
///
/// A [`Read`](CommandKind::Read) only when the whole text is one statement whose first keyword (`LIST`
/// takes its next word) the table lists as a read, or one in `treat_as_read` (exact, upper-case keys).
/// Everything else is a [`Write`](CommandKind::Write): any `BATCH` (`BEGIN ... APPLY BATCH`), a
/// lightweight transaction, DDL, a second statement after a semicolon, an unterminated quote or
/// comment, and text with no statement at all.
pub fn classify_cql(statement: &str, treat_as_read: Option<&HashSet<String>>) -> Classified {
    let shape = statement_shape(statement, Dialect::CQL);
    let key = if shape.first == "LIST" { format!("LIST {}", shape.second) } else { shape.first.clone() };
    let operation = match shape.first.as_str() {
        "BEGIN" => "BATCH".to_owned(),
        "LIST" => key.clone(),
        "" => "UNKNOWN".to_owned(),
        first => first.to_owned(),
    };
    let listed = cassandra().read.contains(&key) || treat_as_read.is_some_and(|reads| reads.contains(&key));
    let kind = if !shape.broken && !shape.multiple && listed { CommandKind::Read } else { CommandKind::Write };
    Classified { kind, operation }
}

/// Classifies a CQL native-protocol message, for a hook below the statement API: `PREPARE` and the
/// connection messages are [`Session`](CommandKind::Session), `QUERY` classifies its `statement`,
/// `EXECUTE` classifies the text it `prepared` (an id never seen prepared is a write), and every
/// `BATCH`, and any message the table doesn't know, is a write.
pub fn classify_cql_message(message: &str, statement: Option<&str>, prepared: Option<&str>) -> Classified {
    if cassandra().session.contains(message) {
        return Classified { kind: CommandKind::Session, operation: message.to_owned() };
    }
    match (message, statement, prepared) {
        ("QUERY", Some(statement), _) => classify_cql(statement, None),
        ("EXECUTE", _, Some(prepared)) => classify_cql(prepared, None),
        _ => Classified { kind: CommandKind::Write, operation: message.to_owned() },
    }
}

/// The table a CQL statement names (`db.collection.name`), without its keyspace.
pub fn cql_target(statement: &str) -> Option<String> {
    let words: Vec<&str> = statement.split(|c: char| c.is_whitespace() || c == '(').filter(|word| !word.is_empty()).collect();
    let at = words.iter().position(|word| ["FROM", "INTO", "UPDATE", "TRUNCATE", "TABLE"].iter().any(|key| word.eq_ignore_ascii_case(key)))?;
    // `INSERT INTO ks.t`, `TRUNCATE TABLE ks.t` and `TRUNCATE ks.t` all name the table next.
    let mut name = *words.get(at + 1)?;
    if name.eq_ignore_ascii_case("TABLE") {
        name = *words.get(at + 2)?;
    }
    let name = name.rsplit('.').next().unwrap_or(name).trim_matches('"').trim_end_matches([';', ',']);
    (!name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_')).then(|| name.to_owned())
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Replaces the literals of a CQL statement with `?`, so a value never reaches a capture: quoted
/// strings, `$$` strings, and every number or other token that starts with a digit (which also covers
/// UUIDs and hex literals). Quoted identifiers and ordinary names are kept.
pub fn sanitize_cql(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let matches = |at: usize, pattern: &str| pattern.chars().enumerate().all(|(offset, c)| chars.get(at + offset) == Some(&c));
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' || c == '"' {
            // A quoted string is a literal; a double-quoted name is an identifier and stays.
            let start = i;
            i += 1;
            while i < chars.len() {
                if chars[i] == c {
                    if chars.get(i + 1) == Some(&c) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            if c == '\'' {
                out.push('?');
            } else {
                out.extend(&chars[start..i]);
            }
        } else if matches(i, "$$") {
            i += 2;
            while i < chars.len() && !matches(i, "$$") {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            out.push('?');
        } else if is_word(c) && !c.is_ascii_digit() {
            // A name: keep it whole, so `t1` is not mistaken for a number.
            while i < chars.len() && is_word(chars[i]) {
                out.push(chars[i]);
                i += 1;
            }
        } else if c.is_ascii_digit() || (c == '-' && chars.get(i + 1).is_some_and(char::is_ascii_digit) && !out.ends_with(is_word) && !out.ends_with('"'))
        {
            i += 1;
            while i < chars.len() && is_word(chars[i]) {
                i += 1;
            }
            if chars.get(i) == Some(&'.') && chars.get(i + 1).is_some_and(char::is_ascii_digit) {
                i += 1;
                while i < chars.len() && is_word(chars[i]) {
                    i += 1;
                }
            }
            // An exponent sign: `1e-5`.
            if matches!(chars.get(i.wrapping_sub(1)), Some('e' | 'E')) && matches!(chars.get(i), Some('+' | '-')) {
                i += 1;
                while i < chars.len() && is_word(chars[i]) {
                    i += 1;
                }
            }
            // A UUID literal is hex groups joined by hyphens: it is one literal.
            while chars.get(i) == Some(&'-') && chars.get(i + 1).is_some_and(|next| next.is_ascii_alphanumeric()) {
                i += 1;
                while i < chars.len() && is_word(chars[i]) {
                    i += 1;
                }
            }
            out.push('?');
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cases() -> Value {
        serde_json::from_str(include_str!("../../../../../spec/data-stores/classification-cases.json")).unwrap()
    }

    fn expected(case: &Value) -> CommandKind {
        match case["expect"].as_str().unwrap() {
            "read" => CommandKind::Read,
            "write" => CommandKind::Write,
            "session" => CommandKind::Session,
            other => panic!("unknown expectation {other}"),
        }
    }

    #[test]
    fn cassandra_passes_every_shared_vector() {
        let cases = cases();
        let cases = cases["cassandra"].as_array().unwrap();
        assert!(cases.len() >= 30, "the shared vectors were not loaded");
        for case in cases {
            let got = match case["message"].as_str() {
                Some(message) => classify_cql_message(message, case["statement"].as_str(), case["prepared"].as_str()),
                None => classify_cql(case["statement"].as_str().unwrap(), None),
            };
            assert_eq!(got.kind, expected(case), "{case}");
            assert_eq!(got.operation, case["operation"].as_str().unwrap(), "{case}");
        }
    }

    #[test]
    fn host_declared_reads_are_exact() {
        let reads: HashSet<String> = ["LIST CUSTOM".to_owned()].into();
        assert_eq!(classify_cql("list custom things", Some(&reads)).kind, CommandKind::Read);
        assert_eq!(classify_cql("LIST CUSTOMER", Some(&reads)).kind, CommandKind::Write);
        assert_eq!(classify_cql("INSERT INTO t (a) VALUES (1)", Some(&reads)).kind, CommandKind::Write);
    }

    #[test]
    fn targets_drop_the_keyspace() {
        assert_eq!(cql_target("INSERT INTO tickets (id) VALUES (?)").as_deref(), Some("tickets"));
        assert_eq!(cql_target("select * from \"ks\".\"Tickets\" where id = ?").as_deref(), Some("Tickets"));
        assert_eq!(cql_target("UPDATE ks.tickets SET a = 1").as_deref(), Some("tickets"));
        assert_eq!(cql_target("TRUNCATE TABLE tickets").as_deref(), Some("tickets"));
        assert_eq!(cql_target("USE ks"), None);
    }

    #[test]
    fn literals_never_reach_a_statement() {
        assert_eq!(
            sanitize_cql("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)"),
            "INSERT INTO tickets (id, status, hits) VALUES (?, ?, ?)"
        );
        assert_eq!(sanitize_cql("SELECT \"t1\" FROM t1 WHERE a = 'it''s' AND b = $$x;y$$ AND c = -4.5e-3"), "SELECT \"t1\" FROM t1 WHERE a = ? AND b = ? AND c = ?");
        assert_eq!(sanitize_cql("WHERE id = 550e8400-e29b-41d4-a716-446655440000"), "WHERE id = ?");
        assert_eq!(sanitize_cql("a-1"), "a-?");
        assert_eq!(sanitize_cql("WHERE a = 'unterminated"), "WHERE a = ?");
    }

    #[test]
    fn the_scanner_reads_the_shape() {
        let shape = statement_shape("  -- c\n select * from t; ", Dialect::CQL);
        assert_eq!((shape.first.as_str(), shape.multiple, shape.broken), ("SELECT", false, false));
        assert!(statement_shape("select 1; select 2", Dialect::CQL).multiple);
        assert!(statement_shape("select 'x", Dialect::CQL).broken);
        // Backticks are quotes only in the SQL dialect.
        assert!(!statement_shape("select `a;b` from t", Dialect::SQL).multiple);
        assert!(statement_shape("select `a;b` from t", Dialect::CQL).multiple);
    }
}
