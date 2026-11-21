//! Named-parameter queries that report their parameters to the capture.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use sendproof_core::limits;
use sqlx::Row;

use crate::{
    backend::{Backend, Fetch, Output, prepare},
    db::DbError,
};

/// A bound SQL value.
#[derive(Debug, Clone, PartialEq)]
pub enum SqlValue {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl SqlValue {
    pub(crate) fn db_type(&self) -> &'static str {
        match self {
            Self::Null => "Object",
            Self::Int(_) => "Int64",
            Self::Real(_) => "Double",
            Self::Text(_) => "String",
            Self::Blob(_) => "Binary",
        }
    }

    pub(crate) fn display(&self) -> Option<String> {
        match self {
            Self::Null => None,
            Self::Int(value) => Some(value.to_string()),
            Self::Real(value) => Some(value.to_string()),
            Self::Text(value) => Some(value.clone()),
            Self::Blob(bytes) => Some(bytes.iter().take(limits::TEXT / 2).map(|byte| format!("{byte:02x}")).collect()),
        }
    }

    /// The value as it appears in a JSON row image.
    #[cfg_attr(not(feature = "mysql"), allow(dead_code))]
    pub(crate) fn to_json(&self) -> serde_json::Value {
        match self {
            Self::Null => serde_json::Value::Null,
            Self::Int(value) => (*value).into(),
            Self::Real(value) => (*value).into(),
            Self::Text(value) => value.clone().into(),
            Self::Blob(_) => self.display().into(),
        }
    }
}

macro_rules! from_value {
    ($($type:ty => $variant:ident $(as $cast:ty)?),* $(,)?) => {$(
        impl From<$type> for SqlValue {
            fn from(value: $type) -> Self { Self::$variant(value $(as $cast)?) }
        }
    )*};
}
from_value!(i64 => Int, i32 => Int as i64, u32 => Int as i64, f64 => Real, String => Text, Vec<u8> => Blob);

impl From<&str> for SqlValue {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

impl From<&String> for SqlValue {
    fn from(value: &String) -> Self {
        Self::Text(value.clone())
    }
}

impl From<bool> for SqlValue {
    fn from(value: bool) -> Self {
        Self::Int(i64::from(value))
    }
}

impl<T: Into<SqlValue>> From<Option<T>> for SqlValue {
    fn from(value: Option<T>) -> Self {
        value.map_or(Self::Null, Into::into)
    }
}

/// How a database spells placeholders.
#[derive(Debug, Clone, Copy)]
pub struct Dialect {
    /// Characters that start a named parameter in the source SQL.
    pub(crate) prefixes: &'static [char],
    /// The placeholder for the parameter at a (1-based) position, or `None` for the positional `?`
    /// of MySQL, where every occurrence takes its own value.
    pub(crate) numbered: Option<fn(usize) -> String>,
    /// Whether a backslash escapes the next character inside a string literal.
    pub(crate) backslash_escapes: bool,
    /// Whether `$tag$ ... $tag$` quotes a string (PostgreSQL).
    pub(crate) dollar_quotes: bool,
    /// Whether `#` starts a comment to the end of the line (MySQL).
    pub(crate) hash_comments: bool,
    /// Whether DDL and other statements commit the transaction implicitly (MySQL).
    pub(crate) implicit_commits: bool,
}

/// A statement with its named parameters resolved for one database.
pub struct Statement {
    /// The SQL as written, with named parameters; this is what the capture shows.
    pub(crate) original: String,
    /// The SQL as sent, with the database's placeholders.
    pub(crate) rewritten: String,
    /// Parameter names in placeholder order (repeated for positional placeholders).
    pub(crate) order: Vec<String>,
    /// Distinct parameter names in order of first appearance.
    pub(crate) names: Vec<String>,
    pub(crate) values: HashMap<String, SqlValue>,
}

impl Statement {
    pub(crate) fn new(sql: &str, dialect: Dialect) -> Self {
        let (rewritten, order) = rewrite(sql, dialect);
        let mut names: Vec<String> = Vec::new();
        for name in &order {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }
        Self { original: sql.to_owned(), rewritten, order, names, values: HashMap::new() }
    }

    /// The bound values in placeholder order.
    pub(crate) fn ordered_values(&self) -> Result<Vec<SqlValue>, DbError> {
        self.order
            .iter()
            .map(|name| self.values.get(name).cloned().ok_or_else(|| DbError::Query(format!("no value bound for parameter `{name}`"))))
            .collect()
    }

    /// Names, display values and types, for the capture.
    pub(crate) fn parameters(&self) -> Vec<(String, Option<String>, String)> {
        self.names
            .iter()
            .filter_map(|name| self.values.get(name).map(|value| (name.clone(), value.display(), value.db_type().to_owned())))
            .collect()
    }
}

/// A query with named parameters: `:name`, and also `@name` or `$name` where the database does
/// not use those characters itself (`@name` and `$name` on SQLite, `$name` on MySQL, `@name` on
/// PostgreSQL).
///
/// Names and values are reported to the Sendproof capture, redacted when the statement or the
/// parameter name looks secret (for example `password`, `token`, `api_key`).
///
/// ```ignore
/// let mut conn = db.acquire().await?;
/// conn.query("UPDATE items SET name = :name WHERE id = :id")
///     .bind("name", "Bolt").bind("id", "12")
///     .execute().await?;
/// ```
pub struct NamedQuery<'c, B: Backend> {
    connection: &'c mut B::Connection,
    capture: Option<Arc<B::Capture>>,
    /// What the statement guard knows of the request's preview.
    safe: Arc<Rules>,
    statement: Statement,
}

/// What the statement guard knows of one preview (spec/data-stores.md "Transaction-control
/// statements from the handler").
#[derive(Default)]
pub(crate) struct Rules {
    /// MySQL procedures the preview may `CALL` (see `SqlxProvider::safe_procedure`).
    pub(crate) procedures: HashSet<String>,
    /// Set when the database answered a deadlock or lock wait timeout, which on MySQL roll the whole
    /// preview transaction back. Later statements would run outside it, and with autocommit a
    /// retry would commit for real, so every further statement is refused and the preview fails.
    pub(crate) broken: std::sync::atomic::AtomicBool,
    /// Set when the guard refused a statement. Nothing was sent, but spec/data-stores.md fails such a
    /// preview with 500 even when the handler catches the error.
    pub(crate) refused: std::sync::atomic::AtomicBool,
}

impl Rules {
    /// Whether the database already ended the preview transaction after an error.
    pub(crate) fn broken(&self) -> bool {
        self.broken.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl<'c, B: Backend> NamedQuery<'c, B> {
    pub(crate) fn new(connection: &'c mut B::Connection, capture: Option<Arc<B::Capture>>, safe: Arc<Rules>, sql: &str) -> Self {
        Self { connection, capture, safe, statement: Statement::new(sql, B::DIALECT) }
    }

    /// Binds `value` to the parameter `name` (given without its `:`, `@` or `$` prefix).
    pub fn bind(mut self, name: &str, value: impl Into<SqlValue>) -> Self {
        self.statement.values.insert(name.to_owned(), value.into());
        self
    }

    /// Executes the statement.
    pub async fn execute(self) -> Result<B::QueryResult, DbError> {
        match self.run(Fetch::Execute).await? {
            Output::Executed(result) => Ok(result),
            _ => unreachable!("an executed statement answers with its result"),
        }
    }

    /// Fetches every row.
    pub async fn fetch_all(self) -> Result<Vec<B::Row>, DbError> {
        match self.run(Fetch::All).await? {
            Output::Rows(rows) => Ok(rows),
            _ => unreachable!("fetch_all answers with rows"),
        }
    }

    /// Fetches the first row, if any.
    pub async fn fetch_optional(self) -> Result<Option<B::Row>, DbError> {
        match self.run(Fetch::Optional).await? {
            Output::Row(row) => Ok(row),
            _ => unreachable!("fetch_optional answers with an optional row"),
        }
    }

    /// Fetches the first row's first column, if any.
    pub async fn fetch_scalar<T>(self) -> Result<Option<T>, DbError>
    where
        T: for<'r> sqlx::Decode<'r, B> + sqlx::Type<B>,
        usize: sqlx::ColumnIndex<B::Row>,
    {
        match self.fetch_optional().await? {
            Some(row) => Ok(Some(row.try_get::<T, _>(0)?)),
            None => Ok(None),
        }
    }

    async fn run(self, fetch: Fetch) -> Result<Output<B>, DbError> {
        // Fail before anything runs when a value is missing.
        self.statement.ordered_values()?;
        // In a preview, a statement that ends the transaction would make the writes before it
        // permanent. Refuse it before it reaches the database.
        let preview = self.capture.as_deref().is_some_and(B::rolls_back);
        if preview && self.safe.broken() {
            return Err(DbError::Query(
                "Sendproof refused the statement: the database already rolled the preview transaction back after a deadlock or lock wait timeout".into(),
            ));
        }
        if preview && let Some(verb) = preview_refusal(&self.statement.original, B::DIALECT, &self.safe.procedures) {
            self.safe.refused.store(true, std::sync::atomic::Ordering::SeqCst);
            return Err(DbError::Query(format!(
                "Sendproof refused `{verb}` in a preview: it would end the preview transaction and make its writes permanent"
            )));
        }
        let result = B::run(self.connection, self.capture.as_deref(), &self.statement, fetch).await;
        // The handler still gets the original error; every later statement of the preview is refused.
        if preview
            && let Err(DbError::Sqlx(error)) = &result
            && B::ends_transaction(error)
        {
            self.safe.broken.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        result
    }
}

/// Plain execution of a prepared statement, shared by the backends.
pub(crate) async fn run_plain<B>(connection: &mut B::Connection, statement: &Statement, fetch: Fetch) -> Result<Output<B>, DbError>
where
    B: Backend,
    B::Arguments: sqlx::IntoArguments<B>,
    for<'e> &'e mut B::Connection: sqlx::Executor<'e, Database = B>,
{
    let query = prepare::<B>(statement)?;
    Ok(crate::backend::fetch::<B>(connection, query, fetch).await?)
}

/// Rewrites named placeholders for `dialect`, returning the SQL and the names in placeholder order.
/// String literals, quoted identifiers, comments and PostgreSQL `::` casts are left alone.
pub(crate) fn rewrite(sql: &str, dialect: Dialect) -> (String, Vec<String>) {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut order: Vec<String> = Vec::new();
    let mut distinct: Vec<String> = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        let closer = match c {
            '\'' => Some('\''),
            '"' => Some('"'),
            '`' => Some('`'),
            '[' => Some(']'),
            _ => None,
        };
        if let Some(closer) = closer {
            out.push(c);
            index += 1;
            while index < chars.len() {
                let current = chars[index];
                out.push(current);
                index += 1;
                if dialect.backslash_escapes && current == '\\' && closer != '`' && index < chars.len() {
                    out.push(chars[index]);
                    index += 1;
                    continue;
                }
                if current == closer {
                    if closer != ']' && chars.get(index) == Some(&closer) {
                        out.push(closer);
                        index += 1;
                        continue;
                    }
                    break;
                }
            }
        } else if (c == '-' && chars.get(index + 1) == Some(&'-')) || (c == '#' && dialect.hash_comments) {
            while index < chars.len() && chars[index] != '\n' {
                out.push(chars[index]);
                index += 1;
            }
        } else if c == '/' && chars.get(index + 1) == Some(&'*') {
            while index < chars.len() && !(chars[index] == '*' && chars.get(index + 1) == Some(&'/')) {
                out.push(chars[index]);
                index += 1;
            }
            for _ in 0..2 {
                if index < chars.len() {
                    out.push(chars[index]);
                    index += 1;
                }
            }
        } else if let Some(tag) = dialect.dollar_quotes.then(|| dollar_tag(&chars, index)).flatten() {
            // Copy the quoted body up to and including the closing tag.
            let body = index + tag.len();
            let close = (body..=chars.len().saturating_sub(tag.len()))
                .find(|&at| chars[at..].starts_with(&tag))
                .map_or(chars.len(), |at| at + tag.len());
            out.extend(&chars[index..close]);
            index = close;
        } else if c == ':' && chars.get(index + 1) == Some(&':') {
            // A PostgreSQL cast such as `value::text`.
            out.push_str("::");
            index += 2;
        } else if dialect.prefixes.contains(&c)
            && chars.get(index + 1).is_some_and(|n| n.is_alphabetic() || *n == '_')
            && !(index > 0 && (chars[index - 1].is_alphanumeric() || chars[index - 1] == '_'))
        {
            let start = index + 1;
            let mut end = start;
            while end < chars.len() && (chars[end].is_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
            let name: String = chars[start..end].iter().collect();
            match dialect.numbered {
                Some(placeholder) => {
                    let position = distinct.iter().position(|n| *n == name).unwrap_or_else(|| {
                        distinct.push(name.clone());
                        order.push(name.clone());
                        distinct.len() - 1
                    });
                    out.push_str(&placeholder(position + 1));
                }
                None => {
                    order.push(name);
                    out.push('?');
                }
            }
            index = end;
        } else {
            out.push(c);
            index += 1;
        }
    }
    (out, order)
}

/// The opening tag of a PostgreSQL dollar-quoted string at `index` (`$$` or `$tag$`), if any.
fn dollar_tag(chars: &[char], index: usize) -> Option<Vec<char>> {
    if chars.get(index) != Some(&'$') || (index > 0 && (chars[index - 1].is_alphanumeric() || chars[index - 1] == '_')) {
        return None;
    }
    let mut end = index + 1;
    while end < chars.len() && (chars[end].is_alphanumeric() || chars[end] == '_') {
        end += 1;
    }
    // `$1` is a positional parameter, not a tag.
    let first = chars.get(index + 1);
    (chars.get(end) == Some(&'$') && !first.is_some_and(char::is_ascii_digit)).then(|| chars[index..=end].to_vec())
}

/// One top-level statement: its bare words, upper-cased, and its text.
struct Words {
    words: Vec<String>,
    text: String,
}

/// The top-level statements of `sql` as the dialect's server reads it, with `backslash` deciding
/// whether a backslash escapes a quote in `'...'` and `"..."` (a session setting the provider can't
/// see: MySQL `NO_BACKSLASH_ESCAPES` and `ANSI_QUOTES`, PostgreSQL `standard_conforming_strings`).
/// String literals, quoted identifiers, comments and dollar-quoted bodies are skipped, and `;`
/// separates statements.
///
/// MySQL ([`Dialect::implicit_commits`]): `#` starts a comment, `--` only when whitespace or a
/// control character follows, and the bodies of `/*! ... */` and `/*M! ... */` run as SQL.
/// PostgreSQL ([`Dialect::dollar_quotes`]): block comments nest and `E'...'` always takes escapes.
fn statement_words(sql: &str, dialect: Dialect, backslash: bool) -> Vec<Words> {
    let mysql = dialect.implicit_commits;
    let postgres = dialect.dollar_quotes;
    let chars: Vec<char> = sql.chars().collect();
    let mut statements = vec![Words { words: Vec::new(), text: String::new() }];
    let mut start = 0;
    let mut executable = false;
    let mut index = 0;
    // Skips a quoted string or identifier that opens at `index`.
    let skip_quoted = |chars: &[char], mut index: usize, closer: char, backslash: bool| -> usize {
        index += 1;
        while index < chars.len() {
            let current = chars[index];
            index += 1;
            if backslash && current == '\\' && closer != '`' && closer != ']' {
                index += 1;
            } else if current == closer {
                if closer != ']' && chars.get(index) == Some(&closer) {
                    index += 1;
                } else {
                    break;
                }
            }
        }
        index
    };
    while index < chars.len() {
        let c = chars[index];
        let next = chars.get(index + 1).copied();
        let closer = match c {
            '\'' => Some('\''),
            '"' => Some('"'),
            '`' => Some('`'),
            '[' if !postgres && !mysql => Some(']'),
            _ => None,
        };
        let dash = c == '-'
            && next == Some('-')
            && (!mysql || chars.get(index + 2).is_none_or(|after| after.is_whitespace() || after.is_control()));
        if executable && c == '*' && next == Some('/') {
            executable = false;
            index += 2;
        } else if let Some(closer) = closer {
            index = skip_quoted(&chars, index, closer, backslash);
        } else if dash || (c == '#' && dialect.hash_comments) {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
        } else if mysql && !executable && c == '/' && next == Some('*') && matches!(chars.get(index + 2), Some('!' | 'M')) {
            let marker = if chars.get(index + 2) == Some(&'M') { 4 } else { 3 };
            if marker == 4 && chars.get(index + 3) != Some(&'!') {
                // `/*M` without `!` is an ordinary comment.
                index = skip_comment(&chars, index, false);
                continue;
            }
            // The server runs the body (after an optional version number) as SQL.
            index += marker;
            while chars.get(index).is_some_and(char::is_ascii_digit) {
                index += 1;
            }
            executable = true;
        } else if c == '/' && next == Some('*') {
            index = skip_comment(&chars, index, postgres);
        } else if let Some(tag) = dialect.dollar_quotes.then(|| dollar_tag(&chars, index)).flatten() {
            let body = index + tag.len();
            index = (body..=chars.len().saturating_sub(tag.len()))
                .find(|&at| chars[at..].starts_with(&tag))
                .map_or(chars.len(), |at| at + tag.len());
        } else if c == ';' {
            let current = statements.last_mut().expect("at least one statement");
            current.text = chars[start..index].iter().collect();
            statements.push(Words { words: Vec::new(), text: String::new() });
            index += 1;
            start = index;
        } else if c.is_alphabetic() || c == '_' {
            let word_start = index;
            while index < chars.len() && (chars[index].is_alphanumeric() || chars[index] == '_' || chars[index] == '$') {
                index += 1;
            }
            if postgres && index == word_start + 1 && matches!(c, 'E' | 'e') && chars.get(index) == Some(&'\'') {
                // An escape string literal, not a word.
                index = skip_quoted(&chars, index, '\'', true);
                continue;
            }
            let word: String = chars[word_start..index].iter().collect();
            statements.last_mut().expect("at least one statement").words.push(word.to_ascii_uppercase());
        } else {
            index += 1;
        }
    }
    statements.last_mut().expect("at least one statement").text = chars[start.min(chars.len())..].iter().collect();
    statements.retain(|statement| !statement.words.is_empty());
    statements
}

/// The index after a block comment that opens at `index`; PostgreSQL's nest.
fn skip_comment(chars: &[char], mut index: usize, nested: bool) -> usize {
    let mut depth = 0usize;
    while index < chars.len() {
        if chars[index] == '/' && chars.get(index + 1) == Some(&'*') {
            depth = if nested { depth + 1 } else { 1 };
            index += 2;
        } else if chars[index] == '*' && chars.get(index + 1) == Some(&'/') {
            depth = depth.saturating_sub(1);
            index += 2;
            if depth == 0 {
                return index;
            }
        } else {
            index += 1;
        }
    }
    chars.len()
}

/// The savepoint the provider sets when a preview starts and rolls back to before the final
/// rollback (see `provider.rs`). A handler may not set, release or roll back to it.
pub(crate) const PREVIEW_SAVEPOINT: &str = "sendproof_preview";

/// The statement verb that a rollback preview must refuse in `sql`, if any.
///
/// Refused everywhere: statements that end the transaction (`COMMIT`, `END`, `ROLLBACK` other than
/// `ROLLBACK TO`, `ABORT`, `BEGIN`, `START`, PostgreSQL two-phase commit), and savepoint statements
/// naming the preview's own savepoint. With [`Dialect::implicit_commits`] (MySQL) only the
/// statements that keep the transaction open are allowed: reads and DML, `SET` (except
/// `autocommit`), savepoints, temporary tables, and `CALL` of a procedure in `safe`. DDL, `LOCK`,
/// other `CALL`s, `PREPARE` and `EXECUTE` (including MariaDB's `EXECUTE IMMEDIATE`) and the rest
/// commit implicitly or may do so. MariaDB's `SET STATEMENT ... FOR` is judged by its inner
/// statement.
///
/// The text is read both ways a backslash can be read, and refused when either reading finds a
/// refused statement.
pub(crate) fn preview_refusal(sql: &str, dialect: Dialect, safe: &HashSet<String>) -> Option<String> {
    for backslash in [dialect.backslash_escapes, !dialect.backslash_escapes] {
        for statement in statement_words(sql, dialect, backslash) {
            if let Some(verb) = refusal(&statement.words, &statement.text, dialect, safe) {
                return Some(verb);
            }
        }
    }
    None
}

/// The verb to refuse for one statement, if any. `text` is empty for an inner statement.
fn refusal(words: &[String], text: &str, dialect: Dialect, safe: &HashSet<String>) -> Option<String> {
    let verb = words.first()?.as_str();
    let second = words.get(1).map(String::as_str);
    let savepoint = matches!(verb, "SAVEPOINT" | "RELEASE") || (verb == "ROLLBACK" && words.iter().any(|word| word == "TO"));
    if savepoint && text.to_ascii_lowercase().contains(PREVIEW_SAVEPOINT) {
        return Some(format!("{verb} {PREVIEW_SAVEPOINT}"));
    }
    if dialect.implicit_commits && verb == "SET" && second == Some("STATEMENT") {
        return match words.iter().position(|word| word == "FOR") {
            Some(at) => refusal(&words[at + 1..], "", dialect, safe),
            None => Some("SET STATEMENT".to_owned()),
        };
    }
    let ends = match verb {
        "COMMIT" | "END" | "ABORT" | "BEGIN" | "START" | "XA" => true,
        "ROLLBACK" => !words.iter().any(|word| word == "TO"),
        "PREPARE" => second == Some("TRANSACTION"),
        _ => false,
    };
    let implicit = dialect.implicit_commits
        && !match verb {
            "SELECT" | "WITH" | "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "VALUES" | "TABLE" | "SHOW" | "DESCRIBE" | "DESC"
            | "EXPLAIN" | "DO" | "SAVEPOINT" | "RELEASE" | "ROLLBACK" => true,
            "SET" => !words.iter().any(|word| word == "AUTOCOMMIT"),
            "CREATE" | "DROP" => second == Some("TEMPORARY"),
            "CALL" => called_procedure(text).is_some_and(|name| safe.contains(&name.to_lowercase())),
            _ => false,
        };
    if ends || implicit {
        return Some(match second {
            Some(second) if matches!(verb, "PREPARE" | "CREATE" | "DROP" | "ALTER" | "EXECUTE") => format!("{verb} {second}"),
            _ => verb.to_owned(),
        });
    }
    None
}

/// The procedure a plain MySQL `CALL` names, as `name` or `schema.name` with the case written, from
/// bare or backtick-quoted identifiers. `None` when the text is anything but `CALL`, the name and an
/// optional argument list, so a call hidden behind a comment or odd quoting is refused.
fn called_procedure(text: &str) -> Option<String> {
    let rest = text.trim_start();
    let rest = rest.get(..4).filter(|verb| verb.eq_ignore_ascii_case("CALL")).map(|_| &rest[4..])?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let (name, rest) = procedure_name(rest.trim_start())?;
    let rest = rest.trim_start();
    (rest.is_empty() || rest.starts_with('(')).then_some(name)
}

/// Reads `name` or `schema.name` at the start of `text`, returning it and the text after it.
fn procedure_name(text: &str) -> Option<(String, &str)> {
    fn part(text: &str) -> Option<(String, &str)> {
        if let Some(body) = text.strip_prefix('`') {
            let mut value = String::new();
            let mut chars = body.char_indices().peekable();
            while let Some((at, c)) = chars.next() {
                if c == '`' {
                    if chars.peek().is_some_and(|(_, next)| *next == '`') {
                        chars.next();
                        value.push('`');
                        continue;
                    }
                    return (!value.is_empty()).then(|| (value, &body[at + 1..]));
                }
                value.push(c);
            }
            None
        } else {
            let end = text.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$')).unwrap_or(text.len());
            (end > 0).then(|| (text[..end].to_owned(), &text[end..]))
        }
    }
    let (first, rest) = part(text)?;
    let after = rest.trim_start();
    match after.strip_prefix('.') {
        Some(tail) => {
            let (second, rest) = part(tail.trim_start())?;
            Some((format!("{first}.{second}"), rest))
        }
        None => Some((first, rest)),
    }
}

/// Checks one procedure name a host declares never commits: an exact `name` or `schema.name`,
/// optionally backtick-quoted, with nothing else, so no wildcards or argument lists. The name is
/// lower-cased, since MySQL routine names ignore case; calls are compared the same way.
pub(crate) fn safe_procedure_name(name: &str) -> Option<String> {
    let (parsed, rest) = procedure_name(name.trim())?;
    rest.trim().is_empty().then(|| parsed.to_lowercase())
}

/// Placeholder spellings.
#[cfg_attr(not(all(feature = "sqlite", feature = "postgres", feature = "mysql")), allow(dead_code))]
pub(crate) mod dialects {
    use super::Dialect;

    pub(crate) const SQLITE: Dialect = Dialect {
        prefixes: &[':', '@', '$'],
        numbered: Some(|n| format!("?{n}")),
        backslash_escapes: false,
        dollar_quotes: false,
        hash_comments: false,
        implicit_commits: false,
    };
    pub(crate) const POSTGRES: Dialect = Dialect {
        prefixes: &[':', '@'],
        numbered: Some(|n| format!("${n}")),
        backslash_escapes: false,
        dollar_quotes: true,
        hash_comments: false,
        implicit_commits: false,
    };
    pub(crate) const MYSQL: Dialect = Dialect {
        prefixes: &[':', '$'],
        numbered: None,
        backslash_escapes: true,
        dollar_quotes: false,
        hash_comments: true,
        implicit_commits: true,
    };
}

/// Records a statement the data layer ran itself, with its parameters and the redaction rules.
#[cfg(any(feature = "postgres", feature = "mysql"))]
pub(crate) fn record(recorder: &sendproof_core::capture::Recorder, elapsed: std::time::Duration, statement: &Statement, rows: Option<u64>) {
    let (sql, truncated) =
        sendproof_core::redact::capture_sql(&statement.original, statement.parameters(), rows, recorder.show_sql_values());
    recorder.record_sql(elapsed, "Sendproof.Sql", sql, truncated);
}

#[cfg(test)]
mod tests {
    use super::{dialects::*, *};

    #[test]
    fn rewrites_named_placeholders_by_first_appearance() {
        let (sql, names) = rewrite("UPDATE t SET a = :a, b = @b WHERE c = :a", SQLITE);
        assert_eq!(sql, "UPDATE t SET a = ?1, b = ?2 WHERE c = ?1");
        assert_eq!(names, ["a", "b"]);
    }

    #[test]
    fn leaves_literals_identifiers_and_comments_alone() {
        let (sql, names) = rewrite("SELECT ':x', \"a:b\", [c@d] -- :y\n, :z /* :w */", SQLITE);
        assert_eq!(sql, "SELECT ':x', \"a:b\", [c@d] -- :y\n, ?1 /* :w */");
        assert_eq!(names, ["z"]);
    }

    #[test]
    fn postgres_numbers_placeholders_and_keeps_casts_and_dollar_quotes() {
        let (sql, names) = rewrite("SELECT :a::text, $tag$ :b $tag$, $$ :c $$, @d, :a", POSTGRES);
        assert_eq!(sql, "SELECT $1::text, $tag$ :b $tag$, $$ :c $$, $2, $1");
        assert_eq!(names, ["a", "d"]);
    }

    #[test]
    fn mysql_repeats_positional_placeholders_and_keeps_variables() {
        let (sql, names) = rewrite("UPDATE t SET a = :a, b = @b, c = @@sql_mode WHERE d = :a AND e = 'it\\'s :x'", MYSQL);
        assert_eq!(sql, "UPDATE t SET a = ?, b = @b, c = @@sql_mode WHERE d = ? AND e = 'it\\'s :x'");
        assert_eq!(names, ["a", "a"]);
    }

    #[test]
    fn mysql_hash_comments_hide_placeholders_and_quotes() {
        let (sql, names) = rewrite("DELETE FROM t WHERE id = :id # don't use :x\n AND k = :k", MYSQL);
        assert_eq!(sql, "DELETE FROM t WHERE id = ? # don't use :x\n AND k = ?");
        assert_eq!(names, ["id", "k"]);
    }

    #[test]
    fn previews_refuse_statements_that_end_the_transaction() {
        for dialect in [SQLITE, POSTGRES, MYSQL] {
            for sql in
                ["COMMIT", "commit work", "END", "ROLLBACK", "begin", "START TRANSACTION", "/* x */ COMMIT", "UPDATE t SET a = 1; COMMIT"]
            {
                assert!(preview_refusal(sql, dialect, &none()).is_some(), "{sql}");
            }
            for sql in [
                "UPDATE t SET a = ':x; COMMIT'",
                "ROLLBACK TO SAVEPOINT s",
                "SAVEPOINT s",
                "SELECT 1 -- COMMIT",
                "INSERT INTO t VALUES (1)",
            ] {
                assert_eq!(preview_refusal(sql, dialect, &none()), None, "{sql}");
            }
        }
        assert_eq!(preview_refusal("PREPARE TRANSACTION 'x'", POSTGRES, &none()).as_deref(), Some("PREPARE TRANSACTION"));
        assert_eq!(preview_refusal("SELECT $$ ; COMMIT $$", POSTGRES, &none()), None);
        // PostgreSQL DDL is transactional, so it is rolled back with the preview.
        assert_eq!(preview_refusal("CREATE TABLE t (x int)", POSTGRES, &none()), None);
    }

    #[test]
    fn mysql_previews_refuse_implicit_commits() {
        for sql in [
            "CREATE TABLE t (x INT)",
            "ALTER TABLE t ADD y INT",
            "TRUNCATE t",
            "DROP TABLE t",
            "LOCK TABLES t WRITE",
            "SET autocommit = 1",
            "SET @@session.autocommit = 1",
            "CALL refresh()",
            "RENAME TABLE a TO b",
            "GRANT ALL ON *.* TO x",
            "SELECT 1; CREATE INDEX i ON t (x)",
            "ANALYZE TABLE t",
        ] {
            assert!(preview_refusal(sql, MYSQL, &none()).is_some(), "{sql}");
        }
        for sql in [
            "SELECT 1",
            "INSERT INTO t SELECT * FROM u",
            "SET @x = 1",
            "CREATE TEMPORARY TABLE tmp (x INT)",
            "DROP TEMPORARY TABLE tmp",
            "WITH c AS (SELECT 1) SELECT * FROM c",
            "REPLACE INTO t VALUES (1)",
            "SHOW TABLES",
        ] {
            assert_eq!(preview_refusal(sql, MYSQL, &none()), None, "{sql}");
        }
    }

    /// No procedure declared safe.
    fn none() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn mysql_previews_refuse_call_unless_declared_and_the_preview_savepoint() {
        let safe: HashSet<String> = ["audit_read", "`app`.`lookup`"].iter().map(|name| safe_procedure_name(name).unwrap()).collect();
        for sql in [
            "CALL p()",
            "CALL other.audit_read()",
            "CALL audit_read_all()",
            "CALL lookup(1)",
            "/* x */ CALL audit_read()",
            "PREPARE s FROM 'COMMIT'",
            "EXECUTE s",
            "EXECUTE IMMEDIATE 'COMMIT'",
            "SET STATEMENT max_statement_time = 1 FOR COMMIT",
            "SET STATEMENT max_statement_time = 1 FOR CREATE TABLE t (n INT)",
            "SET sql_mode = '', autocommit = 1",
            "SAVEPOINT sendproof_preview",
            "RELEASE SAVEPOINT `sendproof_preview`",
            "ROLLBACK TO SAVEPOINT SENDPROOF_PREVIEW",
        ] {
            assert!(preview_refusal(sql, MYSQL, &safe).is_some(), "{sql}");
        }
        // Routine names ignore case, as MySQL's do; a schema-qualified call matches only a declaration with that schema.
        let audit: HashSet<String> = [safe_procedure_name("audit").unwrap()].into();
        assert_eq!(preview_refusal("CALL AUDIT()", MYSQL, &audit), None);
        assert!(preview_refusal("CALL other.audit()", MYSQL, &audit).is_some());
        for sql in [
            "CALL audit_read()",
            "CALL `audit_read`",
            "CALL app.lookup(1)",
            "CALL `app` . `lookup`()",
            "CALL AUDIT_READ()",
            "CALL `Audit_Read`()",
            "CALL APP.LOOKUP(1)",
            "SET STATEMENT max_statement_time = 1 FOR SELECT 1",
            "SAVEPOINT sp1",
            "RELEASE SAVEPOINT sp1",
        ] {
            assert_eq!(preview_refusal(sql, MYSQL, &safe), None, "{sql}");
        }
        for name in ["", "p%", "p*", "a.b.c", "p()", "p q"] {
            assert_eq!(safe_procedure_name(name), None, "{name:?}");
        }
        // Every backend guards its own savepoint.
        assert!(preview_refusal("RELEASE SAVEPOINT sendproof_preview", POSTGRES, &none()).is_some());
    }

    #[test]
    fn mysql_text_is_read_as_the_server_reads_it() {
        for sql in [
            "# note\nCOMMIT",
            "SELECT 1; # x\nCOMMIT",
            "SELECT 1 --1; COMMIT",
            "/*!COMMIT*/",
            "SELECT 1; /*!50000 COMMIT */",
            "/*M!100100 ROLLBACK */",
            "SELECT 'a\\'; COMMIT; -- '",
            "SELECT \"a\\\"; COMMIT; -- \"",
            "SELECT $$; COMMIT; $$",
        ] {
            assert!(preview_refusal(sql, MYSQL, &none()).is_some(), "{sql:?}");
        }
        for sql in [
            "SELECT 1 -- COMMIT",
            "SELECT 1 # COMMIT",
            "SELECT 1 /* COMMIT */",
            "INSERT INTO t VALUES ('it''s; COMMIT')",
            "SELECT `a;COMMIT` FROM t",
            "SELECT 2--1",
            "/*!40101 SET NAMES utf8mb4 */",
        ] {
            assert_eq!(preview_refusal(sql, MYSQL, &none()), None, "{sql:?}");
        }
    }

    #[test]
    fn postgres_text_is_read_as_the_server_reads_it() {
        for sql in [
            "SELECT 'x\\'; COMMIT; SELECT '",
            "SELECT E'x\\\\'; COMMIT; SELECT 'y'",
            "SELECT 'x\\''; COMMIT; SELECT '",
            "/* outer /* inner */ still a comment */ COMMIT",
            "SELECT \"a\\\"; COMMIT; --\"",
        ] {
            assert!(preview_refusal(sql, POSTGRES, &none()).is_some(), "{sql:?}");
        }
        for sql in
            ["SELECT E'it\\'s; COMMIT'", "DO $$ BEGIN COMMIT; END $$", "SELECT $body$; COMMIT; $body$", "/* a /* b */ COMMIT */ SELECT 1"]
        {
            assert_eq!(preview_refusal(sql, POSTGRES, &none()), None, "{sql:?}");
        }
    }

    #[test]
    fn a_prefix_inside_a_word_is_not_a_parameter() {
        let (sql, names) = rewrite("SELECT a$b, x:y FROM t", MYSQL);
        assert_eq!(sql, "SELECT a$b, x:y FROM t");
        assert!(names.is_empty());
    }

    #[test]
    fn statements_report_distinct_parameters_and_ordered_values() {
        let mut statement = Statement::new("SELECT :a, :b, :a", MYSQL);
        statement.values.insert("a".into(), SqlValue::Int(1));
        statement.values.insert("b".into(), "two".into());
        assert_eq!(statement.ordered_values().unwrap(), [SqlValue::Int(1), SqlValue::Text("two".into()), SqlValue::Int(1)]);
        let names: Vec<_> = statement.parameters().into_iter().map(|(name, ..)| name).collect();
        assert_eq!(names, ["a", "b"]);
        statement.values.remove("b");
        assert!(statement.ordered_values().is_err());
    }
}
