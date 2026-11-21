//! Access to the request's database connection.

use std::{
    fmt,
    ops::{Deref, DerefMut},
    sync::Arc,
};

use sendproof_core::Enrollment;
use sqlx::{Pool, Transaction, pool::PoolConnection};
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::{
    backend::Backend,
    query::{NamedQuery, Rules},
};

/// The connection a preview or observed send holds for the handler.
pub(crate) enum Slot<B: Backend> {
    Tx(Transaction<'static, B>),
    Conn(PoolConnection<B>),
    Closed,
}

/// The enrolled unit of work, shared between the provider and the handler through request extensions.
pub(crate) struct Scope<B: Backend> {
    pub(crate) slot: Arc<Mutex<Slot<B>>>,
    pub(crate) capture: Arc<B::Capture>,
    /// What the statement guard knows of the preview (`query::Rules`).
    pub(crate) safe: Arc<Rules>,
}

impl<B: Backend> Clone for Scope<B> {
    fn clone(&self) -> Self {
        Self { slot: self.slot.clone(), capture: self.capture.clone(), safe: self.safe.clone() }
    }
}

/// Errors from [`Db`].
#[derive(Debug)]
pub enum DbError {
    /// A SQLx error.
    Sqlx(sqlx::Error),
    /// The request is a preview, but this route was not enrolled by the Sendproof gate.
    /// Nothing was executed.
    NotEnrolled,
    /// The preview connection is already held by another part of the request.
    Busy,
    /// A named query is malformed or lacks a value.
    Query(String),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlx(error) => write!(f, "{error}"),
            Self::NotEnrolled => f.write_str("this preview request was not enrolled by the Sendproof gate"),
            Self::Busy => f.write_str("the request's database connection is already in use; acquire it once per request"),
            Self::Query(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for DbError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sqlx(error) => Some(error),
            _ => None,
        }
    }
}

impl From<sqlx::Error> for DbError {
    fn from(error: sqlx::Error) -> Self {
        Self::Sqlx(error)
    }
}

macro_rules! db_struct {
    ($($default:tt)*) => {
        /// Hands a handler the right connection: the preview transaction, the observed connection,
        /// or an ordinary pooled connection.
        ///
        /// `Db` alone is `Db<Sqlite>`; write `Db<Postgres>` or `Db<MySql>` for the other backends.
        pub struct Db<B: Backend $($default)*> {
            pool: Pool<B>,
            scope: Option<Scope<B>>,
        }
    };
}

#[cfg(feature = "sqlite")]
db_struct!(= sqlx::Sqlite);
#[cfg(not(feature = "sqlite"))]
db_struct!();

impl<B: Backend> Clone for Db<B> {
    fn clone(&self) -> Self {
        Self { pool: self.pool.clone(), scope: self.scope.clone() }
    }
}

impl<B: Backend> Db<B> {
    /// Resolves the connection source for a request.
    ///
    /// `enrollment` is what the Sendproof gate stored in the request, and `required` says the
    /// request is a preview or observed send (the adapter inserted
    /// [`PreviewRequired`](sendproof_core::PreviewRequired)). A request that the gate did not enroll
    /// fails with [`DbError::NotEnrolled`], so an undeclared route can never commit during a preview.
    pub fn from_enrollment(pool: Pool<B>, enrollment: Option<&Enrollment>, required: bool) -> Result<Self, DbError> {
        let scope = enrollment.and_then(|enrollment| enrollment.0.get::<Scope<B>>()).cloned();
        if scope.is_none() && required {
            return Err(DbError::NotEnrolled);
        }
        Ok(Self { pool, scope })
    }

    /// An ordinary pooled source, outside any request scope. Useful in tests and background work.
    pub fn from_pool(pool: Pool<B>) -> Self {
        Self { pool, scope: None }
    }

    /// Acquires the connection. In a preview this is the transaction's connection, and it can be
    /// held by one caller at a time.
    pub async fn acquire(&self) -> Result<DbConn<B>, DbError> {
        match &self.scope {
            Some(scope) => {
                let guard = scope.slot.clone().try_lock_owned().map_err(|_| DbError::Busy)?;
                if matches!(*guard, Slot::Closed) {
                    return Err(DbError::NotEnrolled);
                }
                Ok(DbConn { inner: Inner::Scoped(guard), capture: Some(scope.capture.clone()), safe: scope.safe.clone() })
            }
            None => Ok(DbConn { inner: Inner::Pool(self.pool.acquire().await?), capture: None, safe: Arc::default() }),
        }
    }
}

/// A database connection. Dereferences to the backend's connection (for example
/// [`SqliteConnection`](sqlx::SqliteConnection)); pass `&mut *conn` to SQLx.
pub struct DbConn<B: Backend> {
    inner: Inner<B>,
    capture: Option<Arc<B::Capture>>,
    safe: Arc<Rules>,
}

enum Inner<B: Backend> {
    /// An ordinary pooled connection.
    Pool(PoolConnection<B>),
    /// The connection of a preview transaction or an observed send.
    Scoped(OwnedMutexGuard<Slot<B>>),
}

impl<B: Backend> DbConn<B> {
    /// Starts a named-parameter query on this connection.
    pub fn query(&mut self, sql: &str) -> NamedQuery<'_, B> {
        let (capture, safe) = (self.capture.clone(), self.safe.clone());
        NamedQuery::new(&mut **self, capture, safe, sql)
    }

    /// Begins a transaction, or a savepoint inside the preview's transaction.
    ///
    /// Rolling it back (or dropping it uncommitted) also drops the changes it made from the capture.
    pub async fn begin(&mut self) -> Result<DbTransaction<'_, B>, DbError> {
        let (capture, safe) = (self.capture.clone(), self.safe.clone());
        let mark = capture.as_deref().map_or(0, B::mark);
        let transaction = sqlx::Connection::begin(&mut **self).await?;
        Ok(DbTransaction { transaction: Some(transaction), capture, safe, mark })
    }
}

impl<B: Backend> Deref for DbConn<B> {
    type Target = B::Connection;

    fn deref(&self) -> &B::Connection {
        match &self.inner {
            Inner::Pool(connection) => connection,
            Inner::Scoped(slot) => match &**slot {
                Slot::Tx(transaction) => transaction,
                Slot::Conn(connection) => connection,
                // A guard is only created for an open slot, and the provider closes the slot
                // with `try_lock`, which cannot succeed while a guard exists.
                Slot::Closed => unreachable!("a closed scope never hands out a connection"),
            },
        }
    }
}

impl<B: Backend> DerefMut for DbConn<B> {
    fn deref_mut(&mut self) -> &mut B::Connection {
        match &mut self.inner {
            Inner::Pool(connection) => connection,
            Inner::Scoped(slot) => match &mut **slot {
                Slot::Tx(transaction) => transaction,
                Slot::Conn(connection) => connection,
                Slot::Closed => unreachable!("a closed scope never hands out a connection"),
            },
        }
    }
}

/// A transaction started with [`DbConn::begin`]. Dereferences to the backend's connection.
///
/// Dropping it without [`commit`](Self::commit) rolls it back, like a SQLx transaction.
pub struct DbTransaction<'c, B: Backend> {
    transaction: Option<Transaction<'c, B>>,
    capture: Option<Arc<B::Capture>>,
    safe: Arc<Rules>,
    mark: usize,
}

impl<B: Backend> DbTransaction<'_, B> {
    /// Starts a named-parameter query inside the transaction.
    pub fn query(&mut self, sql: &str) -> NamedQuery<'_, B> {
        let (capture, safe) = (self.capture.clone(), self.safe.clone());
        NamedQuery::new(&mut **self, capture, safe, sql)
    }

    /// Commits the transaction (releases the savepoint when nested).
    pub async fn commit(mut self) -> Result<(), DbError> {
        if let Some(transaction) = self.transaction.take() {
            transaction.commit().await?;
        }
        Ok(())
    }

    /// Rolls the transaction back and drops its changes from the capture.
    pub async fn rollback(mut self) -> Result<(), DbError> {
        self.forget();
        if let Some(transaction) = self.transaction.take() {
            transaction.rollback().await?;
        }
        Ok(())
    }

    fn forget(&self) {
        if let Some(capture) = &self.capture {
            B::rewind(capture, self.mark);
        }
    }
}

impl<B: Backend> Drop for DbTransaction<'_, B> {
    fn drop(&mut self) {
        // Still open: SQLx rolls it back when the transaction is dropped.
        if self.transaction.is_some() {
            self.forget();
        }
    }
}

impl<B: Backend> Deref for DbTransaction<'_, B> {
    type Target = B::Connection;

    fn deref(&self) -> &B::Connection {
        self.transaction.as_deref().expect("an open transaction")
    }
}

impl<B: Backend> DerefMut for DbTransaction<'_, B> {
    fn deref_mut(&mut self) -> &mut B::Connection {
        self.transaction.as_deref_mut().expect("an open transaction")
    }
}

#[cfg(feature = "axum")]
mod extractor {
    use axum::{
        extract::{FromRef, FromRequestParts},
        http::{StatusCode, request::Parts},
        response::{IntoResponse, Response},
    };

    use sendproof_core::PreviewRequired;

    use super::*;

    impl<S, B> FromRequestParts<S> for Db<B>
    where
        B: Backend,
        Pool<B>: FromRef<S>,
        S: Send + Sync,
    {
        type Rejection = DbError;

        async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
            Db::from_enrollment(
                Pool::<B>::from_ref(state),
                parts.extensions.get::<Enrollment>(),
                parts.extensions.get::<PreviewRequired>().is_some(),
            )
        }
    }

    impl IntoResponse for DbError {
        fn into_response(self) -> Response {
            let status = match self {
                Self::NotEnrolled => StatusCode::CONFLICT,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (status, self.to_string()).into_response()
        }
    }
}

#[cfg(feature = "actix")]
mod actix_extractor {
    use std::future::{Ready, ready};

    use actix_web::{FromRequest, HttpMessage, HttpRequest, HttpResponse, ResponseError, dev::Payload, http::StatusCode, web};
    use sendproof_core::PreviewRequired;

    use super::*;

    impl<B: Backend> FromRequest for Db<B> {
        type Error = DbError;
        type Future = Ready<Result<Self, Self::Error>>;

        fn from_request(request: &HttpRequest, _: &mut Payload) -> Self::Future {
            let Some(pool) = request.app_data::<web::Data<Pool<B>>>() else {
                return ready(Err(DbError::Query("register the pool with `app_data(web::Data::new(pool))`".into())));
            };
            let extensions = request.extensions();
            ready(Db::from_enrollment(
                pool.get_ref().clone(),
                extensions.get::<Enrollment>(),
                extensions.get::<PreviewRequired>().is_some(),
            ))
        }
    }

    impl ResponseError for DbError {
        fn status_code(&self) -> StatusCode {
            match self {
                Self::NotEnrolled => StatusCode::CONFLICT,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            }
        }

        fn error_response(&self) -> HttpResponse {
            HttpResponse::build(self.status_code()).body(self.to_string())
        }
    }
}
