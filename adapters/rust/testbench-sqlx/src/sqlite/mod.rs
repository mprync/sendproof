//! SQLite: the pre-update hook records every row change and `sqlite3_trace_v2` every statement.

mod changes;
mod trace;

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use sqlx::{Sqlite, SqliteConnection, query::Query, sqlite::SqliteQueryResult};
use testbench_core::{BoxError, BoxFuture, Changes, capture};

use crate::{
    backend::{Backend, Driver, Fetch, Output, RowsAffected},
    db::DbError,
    log::ChangeLog,
    query::{Dialect, SqlValue, Statement, dialects, run_plain},
};

use self::trace::{Pending, SqlTrace};

/// The capture installed on one SQLite connection.
pub struct Capture {
    log: Arc<ChangeLog>,
    sql: Option<Arc<SqlTrace>>,
    /// The hook and the trace callback are still installed.
    installed: AtomicBool,
}

impl Capture {
    async fn remove(&self, connection: &mut SqliteConnection) -> Result<(), sqlx::Error> {
        if !self.installed.swap(false, Ordering::SeqCst) {
            return Ok(());
        }
        let hook = changes::remove(connection).await;
        let sql = match &self.sql {
            Some(sql) => trace::remove(connection, sql).await,
            None => Ok(()),
        };
        hook.and(sql)
    }
}

impl RowsAffected for SqliteQueryResult {
    fn rows_affected(&self) -> u64 {
        SqliteQueryResult::rows_affected(self)
    }
}

impl Backend for Sqlite {}

impl Driver for Sqlite {
    type Capture = Capture;

    const DIALECT: Dialect = dialects::SQLITE;
    // An in-memory database lives in its connections, so never close one to clean up.
    const CLOSE_UNFINISHED: bool = false;

    fn bind(query: Query<'static, Self, Self::Arguments>, value: SqlValue) -> Query<'static, Self, Self::Arguments> {
        match value {
            SqlValue::Null => query.bind(Option::<String>::None),
            SqlValue::Int(v) => query.bind(v),
            SqlValue::Real(v) => query.bind(v),
            SqlValue::Text(v) => query.bind(v),
            SqlValue::Blob(v) => query.bind(v),
        }
    }

    fn run_raw<'a>(connection: &'a mut SqliteConnection, sql: &'static str) -> BoxFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(async move { sqlx::raw_sql(sql).execute(connection).await.map(drop) })
    }

    fn run<'a>(
        connection: &'a mut SqliteConnection,
        capture: Option<&'a Capture>,
        statement: &'a Statement,
        fetch: Fetch,
    ) -> BoxFuture<'a, Result<Output<Self>, DbError>> {
        Box::pin(async move {
            // The trace callback reports the statement; tell it the names and values first.
            let trace = capture.and_then(|capture| capture.sql.as_ref());
            if let Some(trace) = trace {
                trace.announce(Some(Pending { text: statement.original.clone(), parameters: statement.parameters() }));
            }
            let result = run_plain::<Sqlite>(connection, statement, fetch).await;
            if let Some(trace) = trace {
                trace.announce(None);
            }
            result
        })
    }

    fn begin<'a>(connection: &'a mut SqliteConnection, _rollback: bool) -> BoxFuture<'a, Result<Capture, BoxError>> {
        Box::pin(async move {
            let log = Arc::new(ChangeLog::default());
            changes::install(connection, log.clone()).await?;
            let sql = match capture::current() {
                Some(recorder) => match trace::install(connection, recorder).await {
                    Ok(sql) => Some(sql),
                    Err(error) => {
                        let _ = changes::remove(connection).await;
                        return Err(error.into());
                    }
                },
                None => None,
            };
            Ok(Capture { log, sql, installed: AtomicBool::new(true) })
        })
    }

    fn finish<'a>(connection: &'a mut SqliteConnection, capture: &'a Capture) -> BoxFuture<'a, Result<(), BoxError>> {
        Box::pin(async move { Ok(capture.remove(connection).await?) })
    }

    fn abandon<'a>(connection: &'a mut SqliteConnection, capture: &'a Capture) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let _ = capture.remove(connection).await;
        })
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
