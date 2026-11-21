//! PostgreSQL: row triggers that call a session-temporary function record every row change.
//!
//! When a capture begins, every table in the connection's `search_path` that it may add triggers
//! to gets an `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW` trigger named
//! `sendproof_capture_<pid>`. The trigger fires only in the session that set the capture's random
//! token (`WHEN (current_setting('sendproof.capture', true) = '<token>')`) and calls
//! `pg_temp.sendproof_capture`, which appends `to_jsonb(OLD)` and `to_jsonb(NEW)` to the temporary
//! table `pg_temp.sendproof_changes`. A sequence orders the rows. Because the audit rows live in the
//! same transaction as the writes, a savepoint that rolls back also drops its audit rows.
//!
//! * In a **preview** the triggers are created inside the preview transaction, so the rollback
//!   removes them with everything else: nothing is ever committed, and other sessions never see
//!   them. The cost is that creating them takes `SHARE ROW EXCLUSIVE` locks, so concurrent writers
//!   to those tables wait until the preview ends.
//! * A preview also installs a deferred constraint trigger that fails any `COMMIT` of the preview
//!   transaction (see [`COMMIT_GUARD`]), so handler code cannot make the preview's writes permanent.
//! * In an **observed send** the handler must commit normally, so the triggers are committed in a
//!   short transaction before the handler runs and dropped after it. Other sessions keep writing
//!   (the `WHEN` clause skips them, and their rows are never captured). Each trigger depends on the
//!   temporary function, so PostgreSQL normally drops them with the session if the process dies;
//!   if that cleanup cannot run, the leftover trigger never fires (no other session has the token)
//!   and the next capture removes triggers whose session has ended.

use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Instant,
};

use sendproof_core::{BoxError, BoxFuture, Changes, capture, limits, model::Change};
use serde_json::Value;
use sqlx::{
    Connection, PgConnection, Postgres, Row,
    postgres::{PgQueryResult, PgRow},
    query::Query,
    types::Json,
};

use crate::{
    backend::{Backend, Driver, Fetch, Output, RowsAffected},
    db::DbError,
    log::ChangeLog,
    query::{Dialect, SqlValue, Statement, dialects, record, run_plain},
};

/// How long installing or removing the triggers may wait for a table lock.
const LOCK_TIMEOUT: &str = "5s";

/// Creates the session-temporary audit table and trigger function, and empties the table.
const SETUP: &str = r#"
CREATE TEMP TABLE IF NOT EXISTS sendproof_changes (
    seq bigserial PRIMARY KEY,
    op text NOT NULL,
    sch text NOT NULL,
    tbl text NOT NULL,
    old jsonb,
    new jsonb
);
CREATE OR REPLACE FUNCTION pg_temp.sendproof_capture() RETURNS trigger LANGUAGE plpgsql AS $sendproof$
BEGIN
    -- Reached from another session only through a leftover trigger: do nothing there.
    IF to_regclass('pg_temp.sendproof_changes') IS NULL THEN
        RETURN NULL;
    END IF;
    INSERT INTO pg_temp.sendproof_changes (op, sch, tbl, old, new)
    VALUES (TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME,
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
    RETURN NULL;
END
$sendproof$;
DELETE FROM pg_temp.sendproof_changes;
"#;

/// Makes the preview transaction impossible to commit. A deferred constraint trigger on a temporary
/// table raises at `COMMIT`, which turns a handler's raw `COMMIT` (or `END`) into a failure that rolls
/// everything back instead of making the preview's writes permanent. It is created inside the
/// preview transaction, before the guard savepoint, so the final rollback removes it and a handler's
/// `ROLLBACK TO SAVEPOINT` cannot.
const COMMIT_GUARD: &str = r#"
CREATE TEMP TABLE sendproof_commit_guard (armed boolean NOT NULL) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.sendproof_refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $sendproof$
BEGIN
    RAISE EXCEPTION 'Sendproof: a preview transaction cannot be committed' USING ERRCODE = '2D000';
END
$sendproof$;
CREATE CONSTRAINT TRIGGER sendproof_refuse_commit AFTER INSERT ON pg_temp.sendproof_commit_guard
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.sendproof_refuse_commit();
INSERT INTO pg_temp.sendproof_commit_guard VALUES (true);
"#;

/// The tables of the `search_path` that can carry a capture trigger, with their primary key columns
/// in key order. Partitions are covered by the trigger of their partitioned table.
const TABLES: &str = r#"
SELECT c.oid::int8 AS oid, n.nspname::text AS schema, c.relname::text AS name,
       ARRAY(SELECT a.attname::text
             FROM pg_index i
             CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             WHERE i.indrelid = c.oid AND i.indisprimary
             ORDER BY k.ord) AS key
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND n.nspname = ANY(current_schemas(false)) AND n.nspname NOT LIKE 'pg\_%'
  AND has_table_privilege(c.oid, 'TRIGGER')
ORDER BY c.oid
"#;

/// Tables written in the current transaction that carry no capture trigger.
const UNCOVERED: &str = r#"
SELECT count(*) FROM pg_stat_xact_user_tables s
JOIN pg_class c ON c.oid = s.relid
WHERE s.n_tup_ins + s.n_tup_upd + s.n_tup_del > 0
  AND NOT c.relispartition
  AND s.schemaname NOT LIKE 'pg\_%'
  AND s.relid::int8 <> ALL($1)
"#;

struct Table {
    schema: String,
    name: String,
    key: Vec<String>,
}

/// The capture installed on one PostgreSQL connection.
pub struct Capture {
    rollback: bool,
    trigger: String,
    current_schema: String,
    tables: HashMap<(String, String), Vec<String>>,
    oids: Vec<i64>,
    log: ChangeLog,
    /// The triggers may still exist (only tracked for observed sends; a preview's rollback drops them).
    installed: AtomicBool,
}

impl RowsAffected for PgQueryResult {
    fn rows_affected(&self) -> u64 {
        PgQueryResult::rows_affected(self)
    }
}

/// Quotes an identifier.
fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Quotes a string literal.
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn raw(sql: String) -> sqlx::RawSql {
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
}

/// Drops the capture triggers named `trigger`, and those of sessions that have ended.
async fn drop_triggers(connection: &mut PgConnection, trigger: &str) -> Result<(), sqlx::Error> {
    let tables: Vec<(String, String)> = sqlx::query_as(
        r"SELECT tgname::text, tgrelid::regclass::text FROM pg_trigger
          WHERE NOT tgisinternal AND tgparentid = 0 AND tgname LIKE 'sendproof\_capture\_%'
            AND (tgname = $1 OR substr(tgname, 19) !~ '^[0-9]+$'
                 OR substr(tgname, 19)::int NOT IN (SELECT pid FROM pg_stat_activity WHERE pid IS NOT NULL))",
    )
    .bind(trigger)
    .persistent(false)
    .fetch_all(&mut *connection)
    .await?;
    if tables.is_empty() {
        return Ok(());
    }
    let mut batch = format!("SET LOCAL lock_timeout = {};", literal(LOCK_TIMEOUT));
    for (name, table) in tables {
        // `regclass::text` is already quoted where needed.
        batch.push_str(&format!("DROP TRIGGER IF EXISTS {} ON {table};", ident(&name)));
    }
    let mut transaction = connection.begin().await?;
    raw(batch).execute(&mut *transaction).await?;
    transaction.commit().await
}

async fn load_tables(connection: &mut PgConnection) -> Result<Vec<(i64, Table)>, sqlx::Error> {
    let rows = sqlx::query(TABLES).persistent(false).fetch_all(&mut *connection).await?;
    rows.iter()
        .map(|row| {
            Ok((row.try_get("oid")?, Table { schema: row.try_get("schema")?, name: row.try_get("name")?, key: row.try_get("key")? }))
        })
        .collect()
}

/// The SQL that creates one capture trigger per table.
fn trigger_ddl(trigger: &str, token: &str, tables: &[(i64, Table)]) -> String {
    tables
        .iter()
        .map(|(_, table)| {
            format!(
                "CREATE TRIGGER {} AFTER INSERT OR UPDATE OR DELETE ON {}.{} FOR EACH ROW \
                 WHEN (current_setting('sendproof.capture', true) = {}) EXECUTE FUNCTION pg_temp.sendproof_capture();\n",
                ident(trigger),
                ident(&table.schema),
                ident(&table.name),
                literal(token)
            )
        })
        .collect()
}

/// A token no other session holds: the capture's triggers fire only where it is set.
fn token(pid: i32) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos());
    format!("{pid}-{}-{nanos}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::SeqCst))
}

async fn begin(connection: &mut PgConnection, rollback: bool) -> Result<Capture, sqlx::Error> {
    let (pid, current_schema): (i32, String) =
        sqlx::query_as("SELECT pg_backend_pid(), current_schema()::text").persistent(false).fetch_one(&mut *connection).await?;
    let trigger = format!("sendproof_capture_{pid}");
    // A pooled session can carry triggers of an earlier capture that could not be removed. Inside a
    // preview this runs in a savepoint and is undone by the rollback, which is harmless.
    drop_triggers(connection, &trigger).await?;
    let tables = load_tables(connection).await?;
    let token = token(pid);
    let ddl = trigger_ddl(&trigger, &token, &tables);
    if rollback {
        // Inside the preview transaction: bound the lock wait, then restore the caller's setting.
        let previous: String =
            sqlx::query_scalar("SELECT current_setting('lock_timeout')").persistent(false).fetch_one(&mut *connection).await?;
        let batch = format!(
            "SELECT set_config('lock_timeout', {}, true);{SETUP}{COMMIT_GUARD}{ddl}SELECT set_config('lock_timeout', {}, true);\
             SELECT set_config('sendproof.capture', {}, true);",
            literal(LOCK_TIMEOUT),
            literal(&previous),
            literal(&token)
        );
        raw(batch).execute(&mut *connection).await?;
    } else {
        let mut transaction = connection.begin().await?;
        raw(format!(
            "SET LOCAL lock_timeout = {};{SETUP}{ddl}SELECT set_config('sendproof.capture', {}, false);",
            literal(LOCK_TIMEOUT),
            literal(&token)
        ))
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
    }
    let mut map = HashMap::new();
    let mut oids = Vec::new();
    for (oid, table) in tables {
        oids.push(oid);
        map.insert((table.schema, table.name), table.key);
    }
    Ok(Capture { rollback, trigger, current_schema, tables: map, oids, log: ChangeLog::default(), installed: AtomicBool::new(!rollback) })
}

impl Capture {
    fn describe(&self, row: &PgRow) -> Result<Change, sqlx::Error> {
        let operation: String = row.try_get("op")?;
        let schema: String = row.try_get("sch")?;
        let table: String = row.try_get("tbl")?;
        let before = row.try_get::<Option<Json<Value>>, _>("old")?.map(|json| json.0);
        let after = row.try_get::<Option<Json<Value>>, _>("new")?.map(|json| json.0);
        let key = self.tables.get(&(schema.clone(), table.clone())).filter(|key| !key.is_empty()).and_then(|columns| {
            let image = after.as_ref().or(before.as_ref())?.as_object()?;
            Some(Value::Object(columns.iter().map(|column| (column.clone(), image.get(column).cloned().unwrap_or(Value::Null))).collect()))
        });
        Ok(Change {
            operation: operation.to_ascii_lowercase(),
            table: if schema == self.current_schema { table } else { format!("{schema}.{table}") },
            key,
            before,
            after,
            ..Change::default()
        })
    }

    /// Reads the audit rows into the log. One row past the cap tells whether more exist.
    async fn collect(&self, connection: &mut PgConnection) -> Result<(), sqlx::Error> {
        let rows = sqlx::query("SELECT op, sch, tbl, old, new FROM pg_temp.sendproof_changes ORDER BY seq LIMIT $1")
            .bind(i64::try_from(limits::CHANGES + 1).unwrap_or(i64::MAX))
            .persistent(false)
            .fetch_all(&mut *connection)
            .await?;
        for row in &rows {
            self.log.push(self.describe(row)?);
        }
        if self.rollback {
            // Writes to tables without a capture trigger (created by the handler, or without the
            // TRIGGER privilege) cannot be listed: say the list is incomplete.
            let uncovered: i64 = sqlx::query_scalar(UNCOVERED).bind(&self.oids).persistent(false).fetch_one(&mut *connection).await?;
            if uncovered > 0 {
                self.log.mark_incomplete();
            }
        }
        Ok(())
    }

    /// Drops the committed triggers of an observed send and empties the audit table.
    async fn remove(&self, connection: &mut PgConnection) -> Result<(), sqlx::Error> {
        if !self.installed.load(Ordering::SeqCst) {
            return Ok(());
        }
        raw("RESET sendproof.capture; DELETE FROM pg_temp.sendproof_changes;".into()).execute(&mut *connection).await?;
        drop_triggers(connection, &self.trigger).await?;
        self.installed.store(false, Ordering::SeqCst);
        Ok(())
    }
}

/// Whether `error` says the transaction is aborted (SQLSTATE 25P02).
fn is_aborted(error: &sqlx::Error) -> bool {
    error.as_database_error().and_then(|error| error.code()).is_some_and(|code| code == "25P02")
}

impl Backend for Postgres {}

impl Driver for Postgres {
    type Capture = Capture;

    const DIALECT: Dialect = dialects::POSTGRES;
    const CLOSE_UNFINISHED: bool = true;
    const SYSTEM: &'static str = "postgresql";

    fn bind(query: Query<'static, Self, Self::Arguments>, value: SqlValue) -> Query<'static, Self, Self::Arguments> {
        match value {
            SqlValue::Null => query.bind(Option::<String>::None),
            SqlValue::Int(v) => query.bind(v),
            SqlValue::Real(v) => query.bind(v),
            SqlValue::Text(v) => query.bind(v),
            SqlValue::Blob(v) => query.bind(v),
        }
    }

    fn run_raw<'a>(connection: &'a mut PgConnection, sql: &'static str) -> BoxFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(async move { sqlx::raw_sql(sql).execute(connection).await.map(drop) })
    }

    fn run<'a>(
        connection: &'a mut PgConnection,
        capture: Option<&'a Capture>,
        statement: &'a Statement,
        fetch: Fetch,
    ) -> BoxFuture<'a, Result<Output<Self>, DbError>> {
        Box::pin(async move {
            let Some(capture) = capture else { return run_plain::<Postgres>(connection, statement, fetch).await };
            let recorder = capture::current();
            // This statement is recorded below with its parameters; keep the tracing layer from
            // logging it again, along with the savepoint statements.
            let _mute = recorder.as_ref().map(|recorder| recorder.mute_sqlx_events());
            // In a preview, a failing statement would abort the whole transaction, where an ordinary
            // send in autocommit would carry on. A savepoint keeps the preview faithful.
            let guarded = capture.rollback;
            if guarded {
                Self::run_raw(connection, "SAVEPOINT sendproof_statement").await?;
            }
            let started = Instant::now();
            let result = run_plain::<Postgres>(connection, statement, fetch).await;
            let elapsed = started.elapsed();
            if guarded {
                let close: &'static str = if result.is_ok() {
                    "RELEASE SAVEPOINT sendproof_statement"
                } else {
                    "ROLLBACK TO SAVEPOINT sendproof_statement; RELEASE SAVEPOINT sendproof_statement"
                };
                Self::run_raw(connection, close).await?;
            }
            if let Some(recorder) = &recorder {
                record(recorder, elapsed, statement, result.as_ref().ok().and_then(Output::rows_affected));
            }
            result
        })
    }

    fn begin<'a>(connection: &'a mut PgConnection, rollback: bool) -> BoxFuture<'a, Result<Capture, BoxError>> {
        Box::pin(async move { Ok(begin(connection, rollback).await?) })
    }

    fn finish<'a>(connection: &'a mut PgConnection, capture: &'a Capture) -> BoxFuture<'a, Result<(), BoxError>> {
        Box::pin(async move {
            match capture.collect(connection).await {
                Ok(()) => {}
                // A raw statement failed and aborted the preview transaction: its audit rows are
                // unreadable, but the rollback still undoes everything.
                Err(error) if capture.rollback && is_aborted(&error) => capture.log.mark_incomplete(),
                Err(error) => return Err(error.into()),
            }
            Ok(capture.remove(connection).await?)
        })
    }

    fn abandon<'a>(connection: &'a mut PgConnection, capture: &'a Capture) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let _ = capture.remove(connection).await;
        })
    }

    fn rolls_back(capture: &Capture) -> bool {
        capture.rollback
    }

    fn changes(capture: &Capture) -> Changes {
        capture.log.take()
    }

    // The audit table is transactional: a rolled-back savepoint drops its own audit rows.
    fn mark(_: &Capture) -> usize {
        0
    }

    fn rewind(_: &Capture, _: usize) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_differ_between_captures() {
        assert_ne!(token(7), token(7));
        assert!(token(7).starts_with("7-"));
    }

    #[test]
    fn quotes_identifiers_and_literals() {
        assert_eq!(ident(r#"we"ird"#), r#""we""ird""#);
        assert_eq!(literal("it's"), "'it''s'");
    }

    #[test]
    fn creates_one_backend_filtered_trigger_per_table() {
        let tables = vec![
            (1, Table { schema: "public".into(), name: "items".into(), key: vec!["id".into()] }),
            (2, Table { schema: "sales".into(), name: "Order Lines".into(), key: vec![] }),
        ];
        let ddl = trigger_ddl("sendproof_capture_42", "42-t'ok", &tables);
        assert_eq!(ddl.lines().count(), 2);
        assert!(ddl.contains(r#"ON "public"."items" FOR EACH ROW WHEN (current_setting('sendproof.capture', true) = '42-t''ok')"#));
        assert!(ddl.contains(r#"ON "sales"."Order Lines""#));
        assert!(ddl.contains("EXECUTE FUNCTION pg_temp.sendproof_capture()"));
    }
}
