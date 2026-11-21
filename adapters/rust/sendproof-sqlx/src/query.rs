//! Named-parameter queries that report their parameters to the capture.

use std::{collections::HashMap, sync::Arc};

use sqlx::Row;
use sendproof_core::limits;

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
    statement: Statement,
}

impl<'c, B: Backend> NamedQuery<'c, B> {
    pub(crate) fn new(connection: &'c mut B::Connection, capture: Option<Arc<B::Capture>>, sql: &str) -> Self {
        Self { connection, capture, statement: Statement::new(sql, B::DIALECT) }
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
        if self.capture.as_deref().is_some_and(B::rolls_back)
            && let Some(verb) = preview_refusal(&self.statement.original, B::DIALECT)
        {
            return Err(DbError::Query(format!(
                "Sendproof refused `{verb}` in a preview: it would end the preview transaction and make its writes permanent"
            )));
        }
        B::run(self.connection, self.capture.as_deref(), &self.statement, fetch).await
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

/// The bare words of each top-level statement of `sql`, upper-cased. String literals, quoted
/// identifiers, comments and dollar-quoted bodies are skipped, and `;` separates statements.
fn statement_words(sql: &str, dialect: Dialect) -> Vec<Vec<String>> {
    let chars: Vec<char> = sql.chars().collect();
    let mut statements = vec![Vec::new()];
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        let closer = match c {
            '\'' => Some('\''),
            '"' => Some('"'),
            '`' => Some('`'),
            '[' if !dialect.dollar_quotes => Some(']'),
            _ => None,
        };
        if let Some(closer) = closer {
            index += 1;
            while index < chars.len() {
                let current = chars[index];
                index += 1;
                if dialect.backslash_escapes && current == '\\' && closer != '`' {
                    index += 1;
                } else if current == closer {
                    if closer != ']' && chars.get(index) == Some(&closer) {
                        index += 1;
                    } else {
                        break;
                    }
                }
            }
        } else if (c == '-' && chars.get(index + 1) == Some(&'-')) || (c == '#' && dialect.hash_comments) {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
        } else if c == '/' && chars.get(index + 1) == Some(&'*') {
            index += 2;
            while index < chars.len() && !(chars[index] == '*' && chars.get(index + 1) == Some(&'/')) {
                index += 1;
            }
            index += 2;
        } else if let Some(tag) = dialect.dollar_quotes.then(|| dollar_tag(&chars, index)).flatten() {
            let body = index + tag.len();
            index = (body..=chars.len().saturating_sub(tag.len()))
                .find(|&at| chars[at..].starts_with(&tag))
                .map_or(chars.len(), |at| at + tag.len());
        } else if c == ';' {
            statements.push(Vec::new());
            index += 1;
        } else if c.is_alphabetic() || c == '_' {
            let start = index;
            while index < chars.len() && (chars[index].is_alphanumeric() || chars[index] == '_' || chars[index] == '$') {
                index += 1;
            }
            let word: String = chars[start..index].iter().collect();
            statements.last_mut().expect("at least one statement").push(word.to_ascii_uppercase());
        } else {
            index += 1;
        }
    }
    statements.retain(|words| !words.is_empty());
    statements
}

/// The statement verb that a rollback preview must refuse in `sql`, if any.
///
/// Refused everywhere: statements that end the transaction (`COMMIT`, `END`, `ROLLBACK` other than
/// `ROLLBACK TO`, `ABORT`, `BEGIN`, `START`, PostgreSQL two-phase commit). With
/// [`Dialect::implicit_commits`] (MySQL) only the statements that keep the transaction open are
/// allowed: reads and DML, `SET` (except `autocommit`), savepoints, and temporary tables. DDL, `LOCK`,
/// `CALL` (a procedure may commit) and the rest commit implicitly or may do so.
pub(crate) fn preview_refusal(sql: &str, dialect: Dialect) -> Option<String> {
    for words in statement_words(sql, dialect) {
        let verb = words[0].as_str();
        let second = words.get(1).map(String::as_str);
        let ends = match verb {
            "COMMIT" | "END" | "ABORT" | "BEGIN" | "START" | "XA" => true,
            "ROLLBACK" => !words.iter().any(|word| word == "TO"),
            "PREPARE" => second == Some("TRANSACTION"),
            _ => false,
        };
        let implicit = dialect.implicit_commits
            && !match verb {
                "SELECT" | "WITH" | "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "VALUES" | "TABLE" | "SHOW" | "DESCRIBE"
                | "DESC" | "EXPLAIN" | "DO" | "SAVEPOINT" | "RELEASE" | "ROLLBACK" => true,
                "SET" => !words.iter().any(|word| word == "AUTOCOMMIT"),
                "CREATE" | "DROP" => second == Some("TEMPORARY"),
                _ => false,
            };
        if ends || implicit {
            return Some(match second {
                Some(second) if matches!(verb, "PREPARE" | "CREATE" | "DROP" | "ALTER") => format!("{verb} {second}"),
                _ => verb.to_owned(),
            });
        }
    }
    None
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
            for sql in ["COMMIT", "commit work", "END", "ROLLBACK", "begin", "START TRANSACTION", "/* x */ COMMIT", "UPDATE t SET a = 1; COMMIT"] {
                assert!(preview_refusal(sql, dialect).is_some(), "{sql}");
            }
            for sql in ["UPDATE t SET a = ':x; COMMIT'", "ROLLBACK TO SAVEPOINT s", "SAVEPOINT s", "SELECT 1 -- COMMIT", "INSERT INTO t VALUES (1)"] {
                assert_eq!(preview_refusal(sql, dialect), None, "{sql}");
            }
        }
        assert_eq!(preview_refusal("PREPARE TRANSACTION 'x'", POSTGRES).as_deref(), Some("PREPARE TRANSACTION"));
        assert_eq!(preview_refusal("SELECT $$ ; COMMIT $$", POSTGRES), None);
        // PostgreSQL DDL is transactional, so it is rolled back with the preview.
        assert_eq!(preview_refusal("CREATE TABLE t (x int)", POSTGRES), None);
    }

    #[test]
    fn mysql_previews_refuse_implicit_commits() {
        for sql in ["CREATE TABLE t (x INT)", "ALTER TABLE t ADD y INT", "TRUNCATE t", "DROP TABLE t", "LOCK TABLES t WRITE",
            "SET autocommit = 1", "SET @@session.autocommit = 1", "CALL refresh()", "RENAME TABLE a TO b", "GRANT ALL ON *.* TO x",
            "SELECT 1; CREATE INDEX i ON t (x)", "ANALYZE TABLE t"] {
            assert!(preview_refusal(sql, MYSQL).is_some(), "{sql}");
        }
        for sql in ["SELECT 1", "INSERT INTO t SELECT * FROM u", "SET @x = 1", "CREATE TEMPORARY TABLE tmp (x INT)",
            "DROP TEMPORARY TABLE tmp", "WITH c AS (SELECT 1) SELECT * FROM c", "REPLACE INTO t VALUES (1)", "SHOW TABLES"] {
            assert_eq!(preview_refusal(sql, MYSQL), None, "{sql}");
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
