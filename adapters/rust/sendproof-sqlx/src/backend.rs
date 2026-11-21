//! The contract each supported database implements.
//!
//! [`Backend`] is public and sealed. Its working parts live in the private [`Driver`] trait, so the
//! generic types of this crate ([`Db`](crate::Db), [`DbConn`](crate::DbConn),
//! [`SqlxProvider`](crate::SqlxProvider)) can call them without exposing them.

use sqlx::{Database, Executor, query::Query};
use sendproof_core::{BoxError, BoxFuture, Changes};

use crate::{
    db::DbError,
    query::{Dialect, SqlValue, Statement},
};

/// A database supported by the Sendproof SQLx data layer: [`sqlx::Sqlite`] (feature `sqlite`),
/// [`sqlx::Postgres`] (feature `postgres`) or [`sqlx::MySql`] (feature `mysql`).
///
/// This trait is sealed: it cannot be implemented outside this crate.
pub trait Backend: Driver {}

/// The number of rows a statement changed, for the query result of any [`Backend`].
///
/// Useful in code that is generic over the backend; concrete result types also have an inherent
/// `rows_affected` method.
pub trait RowsAffected {
    /// The rows the statement inserted, updated or deleted.
    fn rows_affected(&self) -> u64;
}

/// What a named query asks of the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fetch {
    Execute,
    All,
    Optional,
}

/// What the database answered.
pub enum Output<B: Database> {
    Executed(B::QueryResult),
    Rows(Vec<B::Row>),
    Row(Option<B::Row>),
}

impl<B: Database> Output<B>
where
    B::QueryResult: RowsAffected,
{
    /// Rows changed by an executed statement; `None` for queries that fetched rows.
    #[cfg_attr(not(any(feature = "postgres", feature = "mysql")), allow(dead_code))]
    pub(crate) fn rows_affected(&self) -> Option<u64> {
        match self {
            Self::Executed(result) => Some(result.rows_affected()),
            _ => None,
        }
    }
}

/// The working parts of a [`Backend`]. Public in a private module, which seals [`Backend`].
pub trait Driver: Database<QueryResult: RowsAffected> + Sized {
    /// The capture state of one enrolled connection.
    type Capture: Send + Sync + 'static;

    /// How named placeholders are rewritten for this database.
    const DIALECT: Dialect;

    /// Whether a connection whose capture could not be removed must be closed rather than reused.
    const CLOSE_UNFINISHED: bool;

    /// The SQL provider id the workbench shows a mark for (capabilities `database.system`).
    const SYSTEM: &'static str;

    /// The statement that opens a preview's transaction. SQLite overrides it with `BEGIN IMMEDIATE`: a deferred
    /// transaction takes only a read lock first, so two concurrent previews that read and then write both hold it
    /// and one fails at once with `database is locked`. Taking the write lock up front makes them queue instead.
    const PREVIEW_BEGIN: &'static str = "BEGIN";

    /// Whether previews through one provider take turns. MySQL sets it: InnoDB checks a new key for duplicates under
    /// a shared lock, so when three or more transactions insert the same key and the first rolls back, as every
    /// preview does, the waiters each hold that lock and each need the exclusive one, and InnoDB aborts all but one
    /// with a deadlock (error 1213). Sent for real, the first insert commits and the others get a duplicate-key error
    /// instead. Taking turns keeps previews from waiting on one another's rolled-back rows.
    const SERIAL_PREVIEWS: bool = false;

    /// Binds one value.
    fn bind(query: Query<'static, Self, Self::Arguments>, value: SqlValue) -> Query<'static, Self, Self::Arguments>;

    /// Runs a statement without capturing it.
    fn run_raw<'a>(connection: &'a mut Self::Connection, sql: &'static str) -> BoxFuture<'a, Result<(), sqlx::Error>>;

    /// Runs a named statement, reporting it (and, where the backend needs it, its rows) to `capture`.
    fn run<'a>(
        connection: &'a mut Self::Connection,
        capture: Option<&'a Self::Capture>,
        statement: &'a Statement,
        fetch: Fetch,
    ) -> BoxFuture<'a, Result<Output<Self>, DbError>>;

    /// Installs the capture on `connection`. `rollback` is `true` inside a preview transaction and
    /// `false` for an observed send that commits.
    fn begin<'a>(connection: &'a mut Self::Connection, rollback: bool) -> BoxFuture<'a, Result<Self::Capture, BoxError>>;

    /// Collects what is still in the database and removes the capture. In a preview this runs
    /// before the rollback; for an observed send, after the handler.
    fn finish<'a>(connection: &'a mut Self::Connection, capture: &'a Self::Capture) -> BoxFuture<'a, Result<(), BoxError>>;

    /// Removes the capture on a failure path, as far as possible.
    fn abandon<'a>(connection: &'a mut Self::Connection, capture: &'a Self::Capture) -> BoxFuture<'a, ()>;

    /// Whether the capture belongs to a rollback preview (and not to an observed send).
    fn rolls_back(capture: &Self::Capture) -> bool;

    /// The changes collected so far.
    fn changes(capture: &Self::Capture) -> Changes;

    /// The position a nested transaction rewinds to.
    fn mark(capture: &Self::Capture) -> usize;

    /// Forgets the changes after `mark`.
    fn rewind(capture: &Self::Capture, mark: usize);
}

/// Runs a prepared query. Each backend calls this with its concrete types.
pub(crate) async fn fetch<B>(
    connection: &mut B::Connection,
    query: Query<'static, B, B::Arguments>,
    fetch: Fetch,
) -> Result<Output<B>, sqlx::Error>
where
    B: Database,
    B::Arguments: sqlx::IntoArguments<B>,
    for<'c> &'c mut B::Connection: Executor<'c, Database = B>,
{
    Ok(match fetch {
        Fetch::Execute => Output::Executed(connection.execute(query).await?),
        Fetch::All => Output::Rows(connection.fetch_all(query).await?),
        Fetch::Optional => Output::Row(connection.fetch_optional(query).await?),
    })
}

/// Builds the SQLx query of a statement, binding its values in placeholder order.
pub(crate) fn prepare<B: Driver>(statement: &Statement) -> Result<Query<'static, B, B::Arguments>, DbError> {
    let mut query = sqlx::query(sqlx::AssertSqlSafe(statement.rewritten.clone()));
    for value in statement.ordered_values()? {
        query = B::bind(query, value);
    }
    Ok(query)
}
