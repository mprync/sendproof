//! [`sqlx::Executor`] for [`DbConn`](crate::DbConn) and [`DbTransaction`](crate::DbTransaction).
//!
//! Handlers never get the raw SQLx connection. Plain SQLx (`sqlx::query(..).execute(&mut conn)`,
//! `sqlx::raw_sql(..)`, `query_as`, `prepare`) goes through these impls instead, and in a preview
//! each statement passes the statement guard before it is sent: a statement that would end or escape
//! the preview transaction is refused and fails the preview, whichever SQLx API sends it
//! (spec/data-stores.md, "Transaction-control statements from the handler").

use std::sync::Arc;

use futures_util::{
    FutureExt, StreamExt, TryFutureExt, TryStreamExt,
    future::{self, BoxFuture},
    stream::{self, BoxStream},
};
use sqlx::{Database, Describe, Either, Execute, Executor, SqlStr, error::BoxDynError};

use crate::{backend::Backend, query::Rules};

/// One item of [`Executor::fetch_many`]: a statement's result or a row.
type Step<B> = Result<Either<<B as Database>::QueryResult, <B as Database>::Row>, sqlx::Error>;

/// The request's connection for one SQLx call, with the statement guard when it is a preview's.
pub(crate) struct Guarded<'c, B: Backend> {
    pub(crate) connection: &'c mut B::Connection,
    /// `Some` only in a preview; an ordinary or observed send sends every statement.
    pub(crate) rules: Option<Arc<Rules>>,
}

impl<'c, B> Guarded<'c, B>
where
    B: Backend,
    for<'e> &'e mut B::Connection: Executor<'e, Database = B>,
{
    fn fetch_many<'e, 'q: 'e, E>(self, query: E) -> BoxStream<'e, Step<B>>
    where
        'c: 'e,
        E: 'q + Execute<'q, B>,
    {
        let Some(rules) = self.rules else { return self.connection.fetch_many(query) };
        let query = Checked::take(query);
        if let Err(error) = admit::<B>(&rules, &query.sql) {
            return stream::once(future::ready(Err(error))).boxed();
        }
        self.connection.fetch_many(query).inspect_err(move |error| rules.witness::<B>(error)).boxed()
    }

    fn fetch_optional<'e, 'q: 'e, E>(self, query: E) -> BoxFuture<'e, Result<Option<B::Row>, sqlx::Error>>
    where
        'c: 'e,
        E: 'q + Execute<'q, B>,
    {
        let Some(rules) = self.rules else { return self.connection.fetch_optional(query) };
        let query = Checked::take(query);
        if let Err(error) = admit::<B>(&rules, &query.sql) {
            return future::ready(Err(error)).boxed();
        }
        self.connection.fetch_optional(query).inspect_err(move |error| rules.witness::<B>(error)).boxed()
    }

    fn prepare_with<'e>(self, sql: SqlStr, parameters: &'e [B::TypeInfo]) -> BoxFuture<'e, Result<B::Statement, sqlx::Error>>
    where
        'c: 'e,
    {
        if let Some(rules) = &self.rules
            && let Err(error) = admit::<B>(rules, &sql)
        {
            return future::ready(Err(error)).boxed();
        }
        self.connection.prepare_with(sql, parameters)
    }

    fn describe<'e>(self, sql: SqlStr) -> BoxFuture<'e, Result<Describe<B>, sqlx::Error>>
    where
        'c: 'e,
    {
        if let Some(rules) = &self.rules
            && let Err(error) = admit::<B>(rules, &sql)
        {
            return future::ready(Err(error)).boxed();
        }
        self.connection.describe(sql)
    }
}

/// Runs the statement guard on `sql`, as an SQLx error.
fn admit<B: Backend>(rules: &Rules, sql: &SqlStr) -> Result<(), sqlx::Error> {
    rules.admit::<B>(sql.as_str()).map_err(sqlx::Error::InvalidArgument)
}

/// A statement taken apart, so its SQL can be read before it is handed on to the connection.
struct Checked<DB: Database> {
    sql: SqlStr,
    statement: Option<DB::Statement>,
    /// Taken once by the connection; an encoding error is handed on to it unchanged.
    arguments: Option<Result<Option<DB::Arguments>, BoxDynError>>,
    persistent: bool,
}

impl<DB: Database> Checked<DB> {
    fn take<'q, E: Execute<'q, DB>>(mut query: E) -> Self {
        let arguments = Some(query.take_arguments());
        let persistent = query.persistent();
        let statement = query.statement().cloned();
        Self { sql: query.sql(), statement, arguments, persistent }
    }
}

impl<DB: Database> Execute<'_, DB> for Checked<DB> {
    fn sql(self) -> SqlStr {
        self.sql
    }

    fn statement(&self) -> Option<&DB::Statement> {
        self.statement.as_ref()
    }

    fn take_arguments(&mut self) -> Result<Option<DB::Arguments>, BoxDynError> {
        self.arguments.take().unwrap_or(Ok(None))
    }

    fn persistent(&self) -> bool {
        self.persistent
    }
}

/// Implements [`Executor`] for `&mut` a connection type that has a `guarded` method.
macro_rules! guarded_executor {
    (impl<$($lifetime:lifetime),*> for $connection:ty) => {
        impl<'c, $($lifetime,)* B> Executor<'c> for &'c mut $connection
        where
            B: Backend,
            for<'e> &'e mut B::Connection: Executor<'e, Database = B>,
        {
            type Database = B;

            fn fetch_many<'e, 'q: 'e, E>(self, query: E) -> BoxStream<'e, Step<B>>
            where
                'c: 'e,
                E: 'q + Execute<'q, B>,
            {
                self.guarded().fetch_many(query)
            }

            fn fetch_optional<'e, 'q: 'e, E>(self, query: E) -> BoxFuture<'e, Result<Option<B::Row>, sqlx::Error>>
            where
                'c: 'e,
                E: 'q + Execute<'q, B>,
            {
                self.guarded().fetch_optional(query)
            }

            fn prepare_with<'e>(self, sql: SqlStr, parameters: &'e [B::TypeInfo]) -> BoxFuture<'e, Result<B::Statement, sqlx::Error>>
            where
                'c: 'e,
            {
                self.guarded().prepare_with(sql, parameters)
            }

            fn describe<'e>(self, sql: SqlStr) -> BoxFuture<'e, Result<Describe<B>, sqlx::Error>>
            where
                'c: 'e,
            {
                self.guarded().describe(sql)
            }
        }
    };
}

guarded_executor!(impl<> for crate::DbConn<B>);
guarded_executor!(impl<'t> for crate::DbTransaction<'t, B>);
