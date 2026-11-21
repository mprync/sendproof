//! MySQL: primary-key-scoped before/after reads around the statements run through
//! [`DbConn::query`](crate::DbConn::query).
//!
//! MySQL triggers cannot be created inside a transaction (DDL commits implicitly), so rows are
//! captured per statement instead. For each recognized single-table write (see [`statement`]):
//!
//! 1. the rows it will touch are read with `SELECT ... FOR UPDATE`, which locks them;
//! 2. the statement runs;
//! 3. the same rows are read again by primary key.
//!
//! Row images come from `JSON_OBJECT(...)`, so every column type arrives as JSON. Outside a
//! transaction (an observed send in autocommit) the three steps run in a transaction of their own,
//! so a concurrent writer cannot change the rows between the reads. Statements that are not
//! recognized, raw SQLx statements and writes made by MySQL triggers or foreign-key actions are not
//! captured. The list is marked incomplete when one of them changed rows: unrecognized statements
//! by their rows affected, raw statements through the tracing layer, and triggers and foreign-key
//! actions from `information_schema` (a recognized write on a table with a trigger for that event,
//! or referenced by a foreign key whose action writes child rows).

mod statement;

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde_json::Value;
use sqlx::{
    Connection, MySql, MySqlConnection, Row,
    mysql::{MySqlQueryResult, MySqlRow},
    query::Query,
    types::Json,
};
use sendproof_core::{BoxError, BoxFuture, Changes, capture, capture::Recorder, model::Change};

use crate::{
    backend::{Backend, Driver, Fetch, Output, RowsAffected},
    db::DbError,
    log::ChangeLog,
    query::{Dialect, SqlValue, Statement, dialects, record, run_plain},
};

use self::statement::{Expr, TableName, Write};

/// Keys per `IN (...)` lookup.
const KEYS_PER_LOOKUP: usize = 500;

/// Column layout of one table.
struct Table {
    name: TableName,
    columns: Vec<String>,
    /// Primary key columns in key order.
    key: Vec<String>,
    /// The auto-increment column, if any.
    auto: Option<String>,
    /// Writes MySQL makes by itself when this table changes.
    effects: SideEffects,
}

/// Rows MySQL writes on its own when a table changes, which the per-statement reads cannot see:
/// trigger bodies and foreign-key actions. A write that sets one off makes the list incomplete.
#[derive(Debug, Default)]
struct SideEffects {
    /// Events with a trigger on the table: `INSERT`, `UPDATE`, `DELETE`.
    triggers: HashSet<String>,
    /// A foreign key referencing the table deletes or updates child rows when a row is deleted.
    delete_action: bool,
    /// Referenced columns whose update makes a foreign key update or delete child rows.
    update_action: Vec<String>,
}

impl SideEffects {
    /// Whether `event` on the table may write rows elsewhere. `assigned` lists the columns an
    /// `UPDATE` sets, or `None` when unknown (an upsert).
    fn writes_elsewhere(&self, event: &str, assigned: Option<&[String]>) -> bool {
        if self.triggers.contains(event) {
            return true;
        }
        match event {
            "DELETE" => self.delete_action,
            "UPDATE" => match assigned {
                Some(columns) => columns.iter().any(|column| self.update_action.iter().any(|c| c.eq_ignore_ascii_case(column))),
                None => !self.update_action.is_empty(),
            },
            _ => false,
        }
    }
}

/// Foreign-key rules that write child rows (`RESTRICT` and `NO ACTION` only refuse).
fn writes_rows(rule: &str) -> bool {
    matches!(rule.to_ascii_uppercase().as_str(), "CASCADE" | "SET NULL" | "SET DEFAULT")
}

/// The capture of one MySQL connection.
pub struct Capture {
    /// The capture belongs to a rollback preview.
    rollback: bool,
    /// The request's recorder, which counts raw statements that changed rows.
    recorder: Option<Arc<Recorder>>,
    log: ChangeLog,
    tables: Mutex<HashMap<TableName, Option<Arc<Table>>>>,
}

impl RowsAffected for MySqlQueryResult {
    fn rows_affected(&self) -> u64 {
        MySqlQueryResult::rows_affected(self)
    }
}

/// Quotes an identifier.
fn ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// Quotes a string literal.
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

fn qualified(table: &TableName) -> String {
    match &table.schema {
        Some(schema) => format!("{}.{}", ident(schema), ident(&table.name)),
        None => ident(&table.name),
    }
}

/// Converts a JSON key value back into a bindable value.
fn from_json(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Int(i64::from(*flag)),
        Value::Number(number) => match (number.as_i64(), number.as_f64()) {
            (Some(int), _) => SqlValue::Int(int),
            (None, Some(_)) if number.is_u64() => SqlValue::Text(number.to_string()),
            (None, Some(real)) => SqlValue::Real(real),
            _ => SqlValue::Text(number.to_string()),
        },
        Value::String(text) => SqlValue::Text(text.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

/// A comparable form of a key, so `5` and `"5"` match the way MySQL compares them.
fn canonical(values: &[Value]) -> String {
    let parts: Vec<Option<String>> = values
        .iter()
        .map(|value| match value {
            Value::String(text) => Some(text.clone()),
            Value::Null => None,
            Value::Bool(flag) => Some(u8::from(*flag).to_string()),
            other => Some(other.to_string()),
        })
        .collect();
    // JSON keeps the parts apart whatever they contain.
    serde_json::to_string(&parts).unwrap_or_default()
}

impl Table {
    fn image_sql(&self) -> String {
        let pairs: Vec<String> = self.columns.iter().map(|column| format!("{}, {}", literal(column), ident(column))).collect();
        format!("JSON_OBJECT({})", pairs.join(", "))
    }

    fn key_of(&self, image: &Value) -> Vec<Value> {
        self.key.iter().map(|column| image.get(column).cloned().unwrap_or(Value::Null)).collect()
    }

    fn key_json(&self, image: &Value) -> Value {
        Value::Object(self.key.iter().map(|column| (column.clone(), image.get(column).cloned().unwrap_or(Value::Null))).collect())
    }

    fn change(&self, operation: &str, before: Option<Value>, after: Option<Value>) -> Change {
        let image = after.as_ref().or(before.as_ref()).cloned().unwrap_or(Value::Null);
        Change { operation: operation.into(), table: self.name.name.clone(), key: Some(self.key_json(&image)), before, after, ..Change::default() }
    }
}

fn images(rows: &[MySqlRow]) -> Result<Vec<Value>, sqlx::Error> {
    rows.iter().map(|row| row.try_get::<Json<Value>, _>(0).map(|json| json.0)).collect()
}

/// Reads the rows a `WHERE ... ORDER BY ... LIMIT ...` tail selects, locking them.
async fn select_where(
    connection: &mut MySqlConnection,
    table: &Table,
    alias: Option<&str>,
    tail: &str,
    statement: &Statement,
) -> Result<Vec<Value>, DbError> {
    let alias = alias.map(|alias| format!(" AS {}", ident(alias))).unwrap_or_default();
    // `FOR UPDATE` goes on a line of its own: a `--` or `#` comment ending the tail would hide it.
    let sql = format!("SELECT {} FROM {}{alias} {tail}\nFOR UPDATE", table.image_sql(), qualified(&table.name));
    let mut read = Statement::new(&sql, dialects::MYSQL);
    read.values = statement.values.clone();
    match run_plain::<MySql>(connection, &read, Fetch::All).await? {
        Output::Rows(rows) => Ok(images(&rows)?),
        _ => Ok(Vec::new()),
    }
}

/// Reads rows by primary key, locking them. Answers images by canonical key.
async fn select_keys(connection: &mut MySqlConnection, table: &Table, keys: &[Vec<Value>]) -> Result<HashMap<String, Value>, sqlx::Error> {
    let mut found = HashMap::new();
    let columns = table.key.iter().map(|column| ident(column)).collect::<Vec<_>>().join(", ");
    let tuple = format!("({})", vec!["?"; table.key.len()].join(", "));
    for chunk in keys.chunks(KEYS_PER_LOOKUP) {
        let sql = format!(
            "SELECT {} FROM {} WHERE ({columns}) IN ({}) FOR UPDATE",
            table.image_sql(),
            qualified(&table.name),
            vec![tuple.as_str(); chunk.len()].join(", ")
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for value in chunk.iter().flatten() {
            query = MySql::bind(query, from_json(value));
        }
        for image in images(&query.fetch_all(&mut *connection).await?)? {
            found.insert(canonical(&table.key_of(&image)), image);
        }
    }
    Ok(found)
}

impl Capture {
    /// The layout of `name`, read once per capture. `None` when it is unknown or has no primary key.
    async fn table(&self, connection: &mut MySqlConnection, name: &TableName) -> Result<Option<Arc<Table>>, sqlx::Error> {
        if let Some(known) = self.tables.lock().unwrap_or_else(|p| p.into_inner()).get(name) {
            return Ok(known.clone());
        }
        let columns: Vec<(String, String)> = sqlx::query_as(
            "SELECT CAST(COLUMN_NAME AS CHAR), CAST(EXTRA AS CHAR) FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        )
        .bind(name.schema.as_deref())
        .bind(&name.name)
        .fetch_all(&mut *connection)
        .await?;
        let key: Vec<String> = sqlx::query_scalar(
            "SELECT CAST(COLUMN_NAME AS CHAR) FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION",
        )
        .bind(name.schema.as_deref())
        .bind(&name.name)
        .fetch_all(&mut *connection)
        .await?;
        let table = if columns.is_empty() || key.is_empty() {
            None
        } else {
            Some(Arc::new(Table {
                name: name.clone(),
                auto: columns.iter().find(|(_, extra)| extra.to_ascii_lowercase().contains("auto_increment")).map(|(c, _)| c.clone()),
                columns: columns.into_iter().map(|(column, _)| column).collect(),
                key,
                effects: side_effects(connection, name).await?,
            }))
        };
        self.tables.lock().unwrap_or_else(|p| p.into_inner()).insert(name.clone(), table.clone());
        Ok(table)
    }
}

/// The triggers on `name` and the foreign-key actions that reference it, from `information_schema`.
async fn side_effects(connection: &mut MySqlConnection, name: &TableName) -> Result<SideEffects, sqlx::Error> {
    let triggers: Vec<String> = sqlx::query_scalar(
        "SELECT CAST(EVENT_MANIPULATION AS CHAR) FROM information_schema.TRIGGERS \
         WHERE EVENT_OBJECT_SCHEMA = COALESCE(?, DATABASE()) AND EVENT_OBJECT_TABLE = ?",
    )
    .bind(name.schema.as_deref())
    .bind(&name.name)
    .fetch_all(&mut *connection)
    .await?;
    let actions: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT CAST(r.DELETE_RULE AS CHAR), CAST(r.UPDATE_RULE AS CHAR), CAST(k.REFERENCED_COLUMN_NAME AS CHAR) \
         FROM information_schema.REFERENTIAL_CONSTRAINTS r \
         JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = r.CONSTRAINT_SCHEMA \
             AND k.CONSTRAINT_NAME = r.CONSTRAINT_NAME AND k.TABLE_NAME = r.TABLE_NAME \
         WHERE r.UNIQUE_CONSTRAINT_SCHEMA = COALESCE(?, DATABASE()) AND r.REFERENCED_TABLE_NAME = ?",
    )
    .bind(name.schema.as_deref())
    .bind(&name.name)
    .fetch_all(&mut *connection)
    .await?;
    Ok(SideEffects {
        triggers: triggers.into_iter().map(|event| event.to_ascii_uppercase()).collect(),
        delete_action: actions.iter().any(|(delete, _, _)| writes_rows(delete)),
        update_action: actions.into_iter().filter(|(_, update, _)| writes_rows(update)).map(|(_, _, column)| column).collect(),
    })
}

/// Runs a recognized write with its before and after reads, and logs its changes.
/// Answers the statement's result and how long the statement itself took.
async fn captured(
    connection: &mut MySqlConnection,
    capture: &Capture,
    statement: &Statement,
    write: &Write,
) -> Result<(Output<MySql>, Duration), DbError> {
    let name = match write {
        Write::Insert { table, .. } | Write::Update { table, .. } | Write::Delete { table, .. } => table,
    };
    let Some(table) = capture.table(connection, name).await? else {
        return uncaptured(connection, capture, statement).await;
    };
    match write {
        Write::Update { alias, assigned, tail, .. } => {
            let before = select_where(connection, &table, alias.as_deref(), tail, statement).await?;
            let (output, elapsed) = timed(connection, statement).await?;
            let keys: Vec<Vec<Value>> = before.iter().map(|image| table.key_of(image)).collect();
            let after = select_keys(connection, &table, &keys).await?;
            let mut missing = assigned.iter().any(|column| table.key.contains(column));
            for (image, key) in before.into_iter().zip(&keys) {
                match after.get(&canonical(key)) {
                    Some(updated) => capture.log.push(table.change("update", Some(image), Some(updated.clone()))),
                    None => missing = true,
                }
            }
            let elsewhere = !keys.is_empty() && table.effects.writes_elsewhere("UPDATE", Some(assigned));
            if missing || elsewhere || output.rows_affected().unwrap_or(0) > keys.len() as u64 {
                capture.log.mark_incomplete();
            }
            Ok((output, elapsed))
        }
        Write::Delete { alias, tail, .. } => {
            let before = select_where(connection, &table, alias.as_deref(), tail, statement).await?;
            let (output, elapsed) = timed(connection, statement).await?;
            let elsewhere = !before.is_empty() && table.effects.writes_elsewhere("DELETE", None);
            if elsewhere || output.rows_affected().unwrap_or(0) != before.len() as u64 {
                capture.log.mark_incomplete();
            }
            for image in before {
                capture.log.push(table.change("delete", Some(image), None));
            }
            Ok((output, elapsed))
        }
        Write::Insert { columns, rows, replace, upsert, ignore, .. } => {
            let columns = columns.as_ref().unwrap_or(&table.columns);
            // The key of each row: known before the statement runs, or generated by auto-increment.
            let mut keys: Vec<Option<Vec<Value>>> = Vec::with_capacity(rows.len());
            for row in rows {
                let mut key = Vec::with_capacity(table.key.len());
                let mut generated = false;
                for column in &table.key {
                    let expr = columns.iter().position(|c| c.eq_ignore_ascii_case(column)).map_or(&Expr::Default, |at| &row[at]);
                    let value = match expr {
                        Expr::Param(name) => statement.values.get(name).map(SqlValue::to_json),
                        Expr::Literal(value) => Some(value.clone()),
                        Expr::Default => None,
                        Expr::Other => return uncaptured(connection, capture, statement).await,
                    };
                    match value.filter(|value| !value.is_null()) {
                        Some(value) => key.push(value),
                        None if table.auto.as_deref() == Some(column.as_str()) && table.key.len() == 1 => generated = true,
                        None => return uncaptured(connection, capture, statement).await,
                    }
                }
                keys.push((!generated).then_some(key));
            }
            let known: Vec<Vec<Value>> = keys.iter().flatten().cloned().collect();
            let before = if *replace || *upsert || *ignore { select_keys(connection, &table, &known).await? } else { HashMap::new() };
            let (output, elapsed) = timed(connection, statement).await?;
            // Generated keys follow LAST_INSERT_ID() in steps of auto_increment_increment.
            let first = match &output {
                Output::Executed(result) => result.last_insert_id(),
                _ => 0,
            };
            if first > 0 && keys.iter().any(Option::is_none) {
                // Read for every statement: the session may change it between statements.
                let step: u64 =
                    sqlx::query_scalar("SELECT CAST(@@session.auto_increment_increment AS UNSIGNED)").fetch_one(&mut *connection).await?;
                let step = step.max(1);
                let mut next = first;
                for key in keys.iter_mut().filter(|key| key.is_none()) {
                    *key = Some(vec![Value::from(next)]);
                    next += step;
                }
            }
            let resolved: Vec<Vec<Value>> = keys.into_iter().flatten().collect();
            let after = select_keys(connection, &table, &resolved).await?;
            let mut expected = 0u64;
            let mut events = HashSet::new();
            let mut seen = HashSet::new();
            for key in resolved {
                let id = canonical(&key);
                if !seen.insert(id.clone()) {
                    continue;
                }
                match (before.get(&id), after.get(&id)) {
                    (None, Some(inserted)) => {
                        expected += 1;
                        events.insert("INSERT");
                        capture.log.push(table.change("insert", None, Some(inserted.clone())));
                    }
                    (Some(old), Some(new)) if *replace => {
                        expected += 2;
                        events.extend(["DELETE", "INSERT"]);
                        capture.log.push(table.change("delete", Some(old.clone()), None));
                        capture.log.push(table.change("insert", None, Some(new.clone())));
                    }
                    (Some(old), Some(new)) if *upsert => {
                        expected += 2;
                        if old != new {
                            events.insert("UPDATE");
                            capture.log.push(table.change("update", Some(old.clone()), Some(new.clone())));
                        }
                    }
                    _ => {}
                }
            }
            let elsewhere = events.iter().any(|event| table.effects.writes_elsewhere(event, None));
            if elsewhere || output.rows_affected().unwrap_or(0) > expected {
                capture.log.mark_incomplete();
            }
            Ok((output, elapsed))
        }
    }
}

/// Runs a statement whose rows cannot be captured, and says so when it changed rows.
async fn uncaptured(
    connection: &mut MySqlConnection,
    capture: &Capture,
    statement: &Statement,
) -> Result<(Output<MySql>, Duration), DbError> {
    let (output, elapsed) = timed(connection, statement).await?;
    if output.rows_affected().unwrap_or(0) > 0 {
        capture.log.mark_incomplete();
    }
    Ok((output, elapsed))
}

async fn timed(connection: &mut MySqlConnection, statement: &Statement) -> Result<(Output<MySql>, Duration), DbError> {
    let started = Instant::now();
    let output = run_plain::<MySql>(connection, statement, Fetch::Execute).await?;
    Ok((output, started.elapsed()))
}

/// Runs a write with capture, in a transaction of its own when the connection has none, so that no
/// concurrent writer can change the rows between the reads.
async fn run_write(
    connection: &mut MySqlConnection,
    capture: &Capture,
    statement: &Statement,
    write: &Write,
) -> Result<(Output<MySql>, Duration), DbError> {
    if connection.is_in_transaction() {
        return captured(connection, capture, statement, write).await;
    }
    let mut transaction = connection.begin().await?;
    let mark = capture.log.mark();
    match captured(&mut transaction, capture, statement, write).await {
        Ok(result) => {
            transaction.commit().await?;
            Ok(result)
        }
        Err(error) => {
            capture.log.rewind(mark);
            Err(error)
        }
    }
}

impl Backend for MySql {}

impl Driver for MySql {
    type Capture = Capture;

    const DIALECT: Dialect = dialects::MYSQL;
    // Nothing is installed on the connection.
    const CLOSE_UNFINISHED: bool = false;
    const SYSTEM: &'static str = "mysql";
    const SERIAL_PREVIEWS: bool = true;

    fn bind(query: Query<'static, Self, Self::Arguments>, value: SqlValue) -> Query<'static, Self, Self::Arguments> {
        match value {
            SqlValue::Null => query.bind(Option::<String>::None),
            SqlValue::Int(v) => query.bind(v),
            SqlValue::Real(v) => query.bind(v),
            SqlValue::Text(v) => query.bind(v),
            SqlValue::Blob(v) => query.bind(v),
        }
    }

    fn run_raw<'a>(connection: &'a mut MySqlConnection, sql: &'static str) -> BoxFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(async move { sqlx::raw_sql(sql).execute(connection).await.map(drop) })
    }

    fn run<'a>(
        connection: &'a mut MySqlConnection,
        capture: Option<&'a Capture>,
        statement: &'a Statement,
        fetch: Fetch,
    ) -> BoxFuture<'a, Result<Output<Self>, DbError>> {
        Box::pin(async move {
            let Some(capture) = capture else { return run_plain::<MySql>(connection, statement, fetch).await };
            let recorder = capture::current();
            // Recorded below with its parameters; the reads around it are bookkeeping.
            let _mute = recorder.as_ref().map(|recorder| recorder.mute_sqlx_events());
            let write = (fetch == Fetch::Execute).then(|| statement::analyze(&statement.original)).flatten();
            let (output, elapsed) = match &write {
                Some(write) => run_write(connection, capture, statement, write).await?,
                None if fetch == Fetch::Execute && statement::may_write(&statement.original) => {
                    uncaptured(connection, capture, statement).await?
                }
                None => {
                    let started = Instant::now();
                    let output = run_plain::<MySql>(connection, statement, fetch).await?;
                    (output, started.elapsed())
                }
            };
            if let Some(recorder) = &recorder {
                record(recorder, elapsed, statement, output.rows_affected());
            }
            Ok(output)
        })
    }

    fn begin<'a>(_connection: &'a mut MySqlConnection, rollback: bool) -> BoxFuture<'a, Result<Capture, BoxError>> {
        Box::pin(async move { Ok(Capture { rollback, recorder: capture::current(), log: ChangeLog::default(), tables: Mutex::new(HashMap::new()) }) })
    }

    fn finish<'a>(_connection: &'a mut MySqlConnection, capture: &'a Capture) -> BoxFuture<'a, Result<(), BoxError>> {
        Box::pin(async move {
            // Raw SQLx statements bypass the per-statement reads. The tracing layer counts the ones
            // that changed rows; any such write makes the list incomplete.
            if capture.recorder.as_ref().is_some_and(|recorder| recorder.unattributed_writes() > 0) {
                capture.log.mark_incomplete();
            }
            Ok(())
        })
    }

    fn abandon<'a>(_connection: &'a mut MySqlConnection, _capture: &'a Capture) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }

    fn rolls_back(capture: &Capture) -> bool {
        capture.rollback
    }

    fn changes(capture: &Capture) -> Changes {
        capture.log.take()
    }

    fn mark(capture: &Capture) -> usize {
        capture.log.mark()
    }

    fn rewind(capture: &Capture, mark: usize) {
        capture.log.rewind(mark);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_compare_the_way_mysql_compares_them() {
        assert_eq!(canonical(&[Value::from(5)]), canonical(&[Value::from("5")]));
        assert_ne!(canonical(&[Value::from("a"), Value::from("b")]), canonical(&[Value::from("a\u{1f}b")]));
        assert_eq!(from_json(&Value::from(u64::MAX)), SqlValue::Text(u64::MAX.to_string()));
        assert_eq!(from_json(&Value::from(true)), SqlValue::Int(1));
    }

    #[test]
    fn side_effects_depend_on_the_event_and_the_columns() {
        let effects = SideEffects { triggers: ["INSERT".to_owned()].into(), delete_action: true, update_action: vec!["id".into()] };
        assert!(effects.writes_elsewhere("INSERT", None));
        assert!(effects.writes_elsewhere("DELETE", None));
        assert!(effects.writes_elsewhere("UPDATE", Some(&["ID".into()])));
        assert!(!effects.writes_elsewhere("UPDATE", Some(&["name".into()])));
        assert!(effects.writes_elsewhere("UPDATE", None), "an upsert may assign anything");
        assert!(!SideEffects::default().writes_elsewhere("DELETE", None));
        assert!(writes_rows("set null") && !writes_rows("RESTRICT") && !writes_rows("NO ACTION"));
    }

    #[test]
    fn builds_json_images_with_quoted_names() {
        let table = Table {
            name: TableName { schema: Some("shop".into()), name: "it`ems".into() },
            columns: vec!["id".into(), "o'k".into()],
            key: vec!["id".into()],
            auto: None,
            effects: SideEffects::default(),
        };
        assert_eq!(table.image_sql(), "JSON_OBJECT('id', `id`, 'o''k', `o'k`)");
        assert_eq!(qualified(&table.name), "`shop`.`it``ems`");
        let change = table.change("insert", None, Some(serde_json::json!({"id": 1, "o'k": true})));
        assert_eq!(change.key, Some(serde_json::json!({"id": 1})));
    }
}
