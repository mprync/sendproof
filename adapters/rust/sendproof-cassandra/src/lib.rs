//! Cassandra write guard for [Sendproof](https://github.com/mprync/sendproof) (`spec/data-stores.md`, `guard` mode).
//!
//! Cassandra has no rollback, so a Preview reads Cassandra normally and is stopped **before the first
//! write is sent**. The `scylla` driver (which also speaks to Apache Cassandra) has no hook that runs
//! before a request is sent, and its `Session` is a concrete struct, so the guard is a wrapper:
//! [`CassandraStore`] owns the `Session`, and every handler gets a [`GuardedSession`] that classifies
//! each statement's text before it calls the driver.
//!
//! ```no_run
//! # async fn demo() -> Result<(), Box<dyn std::error::Error>> {
//! use sendproof_cassandra::{Cassandra, CassandraStore};
//!
//! let session = scylla::client::session_builder::SessionBuilder::new().known_node("127.0.0.1:9042").build().await?;
//! // The store owns the session; keep only the store in application state.
//! let store = CassandraStore::new(session).name("tickets")?;
//! // Register it: Config::builder("Inventory").data_store(store.clone())
//!
//! // In a handler, take the `Cassandra` extractor and use its guarded session:
//! # async fn handler(cassandra: Cassandra) -> Result<(), Box<dyn std::error::Error>> {
//! let session = cassandra.session();
//! let result = session.query_unpaged("SELECT id, status FROM tickets WHERE id = ?", ("a",)).await?;
//! # let _ = result;
//! # Ok(()) }
//! # Ok(()) }
//! ```
//!
//! In a Preview:
//!
//! * a read (`SELECT`, `USE`, `DESCRIBE`, `LIST ...`) runs and becomes a `Db` log entry whose statement
//!   has every literal replaced by `?`;
//! * the first write is refused with [`CassandraError::Blocked`] and marks the Preview blocked, which
//!   then answers 409 whatever the handler does with the error. Writes are `INSERT`, `UPDATE`,
//!   `DELETE`, DDL, `GRANT`, every batch (a `BATCH` is refused even if it holds only a read, and even
//!   when it is empty), any statement with a lightweight-transaction condition, a text holding a second
//!   statement, and any text the table doesn't list;
//! * a prepared statement is classified by the text it was prepared from, which the driver keeps in
//!   the [`PreparedStatement`] itself, so an execution can never be mistaken for a read;
//! * `prepare` and `prepare_batch` only parse, so they run and are not logged.
//!
//! # Coverage
//!
//! Only the session given to the store is covered, and only through the handles it hands out. The
//! store never gives the raw `Session` back. Cassandra has no command monitoring to fall back on, so a
//! second `Session` the application builds itself is not seen: its writes are neither blocked nor
//! logged, and the Preview is still confirmed. Keep every Cassandra session inside the store.
//!
//! The store finds the Preview through the handler's extractor, so a [`GuardedSession`] taken in a
//! handler keeps its Preview in tasks the handler spawns. A handle from [`CassandraStore::detached`]
//! has no request: its write while a Preview is open can't be told from a Preview's, and has already
//! been sent, so every Preview open on the store answers 500. Use
//! [`detached`](sendproof_core::detached) for background work that writes.

#[cfg(feature = "actix")]
mod actix_extractor;
#[cfg(feature = "axum")]
mod axum_extractor;

#[cfg(feature = "actix")]
pub use actix_extractor::CassandraRejection;
#[cfg(feature = "axum")]
pub use axum_extractor::NotEnrolledResponse;

use std::{
    collections::HashSet,
    error::Error,
    fmt,
    sync::Arc,
    time::Instant,
};

use scylla::{
    client::{pager::QueryPager, session::Session},
    errors::{ExecutionError, PagerExecutionError, PrepareError, RequestAttemptError, UseKeyspaceError},
    response::{PagingState, PagingStateResponse, query_result::QueryResult},
    serialize::{batch::BatchValues, row::SerializeRow},
    statement::{
        Statement,
        batch::{Batch, BatchStatement},
        bound::BoundStatement,
        prepared::PreparedStatement,
    },
};
use sendproof_core::{
    BoxError, BoxFuture, CommandKind, ConfigError, DataStore, DbEntry, Enrollment, NotEnrolled, PreviewSession, PreviewWriteBlocked,
    StoreDescription, StoreMode, StoreScope,
    stores::{OpenPreviews, classify_cql, cql_target, exact_names, sanitize_cql, store_label},
};

/// The store id used in capabilities, `Db` entries and the blocked response.
pub const SYSTEM: &str = "cassandra";

struct Settings {
    name: Option<String>,
    reads: Arc<HashSet<String>>,
    session: Arc<Session>,
    open: OpenPreviews,
}

/// A hooked Cassandra, ready for [`ConfigBuilder::data_store`](sendproof_core::ConfigBuilder::data_store).
///
/// Cheap to clone. Keep one in application state so handlers can take the [`Cassandra`] extractor.
#[derive(Clone)]
pub struct CassandraStore {
    settings: Arc<Settings>,
}

impl CassandraStore {
    /// A Cassandra store that owns `session` and hands it out only guarded. It takes the `Session`
    /// itself, which can't be cloned, so no unguarded copy stays in application reach:
    ///
    /// ```compile_fail
    /// # fn keep(session: std::sync::Arc<scylla::client::session::Session>) {
    /// // A shared session would leave a raw handle behind; the store doesn't take one.
    /// let store = sendproof_cassandra::CassandraStore::new(session.clone());
    /// # }
    /// ```
    ///
    /// Run schema setup before handing the session over, or through `store.detached().session()`.
    pub fn new(session: Session) -> Self {
        Self { settings: Arc::new(Settings { name: None, reads: Arc::default(), session: Arc::new(session), open: OpenPreviews::new() }) }
    }

    fn with(self, change: impl FnOnce(&mut Settings)) -> Self {
        // Settings are shared by clones; building the store happens before the first clone.
        let mut settings = Arc::try_unwrap(self.settings).unwrap_or_else(|shared| Settings {
            name: shared.name.clone(),
            reads: shared.reads.clone(),
            session: shared.session.clone(),
            open: shared.open.clone(),
        });
        change(&mut settings);
        Self { settings: Arc::new(settings) }
    }

    /// The display label shown in capabilities, such as `tickets`. A label that looks like a URL,
    /// host or connection string is refused: discovery is visible to anyone who can open the workbench.
    pub fn name(self, label: &str) -> Result<Self, ConfigError> {
        let name = store_label(label)?;
        Ok(self.with(|settings| settings.name = Some(name)))
    }

    /// Statement keywords the host states never write, matched exactly in upper case (`"LIST CUSTOM"`
    /// for a two-word `LIST` key). No wildcards.
    ///
    /// **This is the host's statement that the statement never writes.** One wrongly listed here is
    /// not blocked in a Preview.
    pub fn treat_as_read<I, S>(self, names: I) -> Result<Self, ConfigError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let reads = exact_names(names, str::to_ascii_uppercase)?;
        Ok(self.with(|settings| settings.reads = Arc::new(reads)))
    }

    /// The handle for a request: [`Cassandra`] from the request's enrollment. `required` says the
    /// request is a preview (the adapter inserted [`PreviewRequired`](sendproof_core::PreviewRequired));
    /// a preview that the gate did not enroll fails, so an undeclared route can never write.
    pub fn from_enrollment(&self, enrollment: Option<&Enrollment>, required: bool) -> Result<Cassandra, NotEnrolled> {
        Ok(Cassandra { scope: StoreScope::from_enrollment(enrollment, required)?, settings: self.settings.clone() })
    }

    /// The handle outside any request scope: guards through the task-local capture, if one is active.
    /// Useful in tests and background work (see the crate's coverage notes).
    pub fn detached(&self) -> Cassandra {
        Cassandra { scope: StoreScope::current(), settings: self.settings.clone() }
    }
}

impl DataStore for CassandraStore {
    fn describe(&self) -> BoxFuture<'_, StoreDescription> {
        let name = self.settings.name.clone();
        Box::pin(async move { StoreDescription { system: SYSTEM.into(), name, mode: StoreMode::Guard, reason: None } })
    }

    /// Registers the Preview as open on this store until it finishes, so a write no request sent
    /// fails it. Nothing is started on Cassandra.
    fn begin_preview<'a>(&'a self, extensions: &'a mut http::Extensions) -> BoxFuture<'a, Result<Option<Box<dyn PreviewSession>>, BoxError>> {
        let begun = self.settings.open.begin(extensions).map(Some);
        Box::pin(async move { begun })
    }
}

/// The Cassandra handle of one request. Take it as a handler argument, then use
/// [`session`](Self::session).
#[derive(Clone)]
pub struct Cassandra {
    scope: StoreScope,
    settings: Arc<Settings>,
}

impl Cassandra {
    /// The store's session, guarded for this request.
    pub fn session(&self) -> GuardedSession {
        GuardedSession {
            session: self.settings.session.clone(),
            hook: Hook { scope: self.scope.clone(), reads: self.settings.reads.clone(), open: self.settings.open.clone() },
        }
    }
}

/// What a guarded call returns when it fails: the guard refused it, or the driver did.
#[derive(Debug)]
pub enum CassandraError<E> {
    /// The statement is a write and the request is a Preview. Nothing was sent.
    Blocked(PreviewWriteBlocked),
    /// The driver's own error.
    Driver(E),
}

impl<E> CassandraError<E> {
    /// The refusal, when the guard refused the call.
    pub fn blocked(&self) -> Option<&PreviewWriteBlocked> {
        match self {
            Self::Blocked(blocked) => Some(blocked),
            Self::Driver(_) => None,
        }
    }
}

impl<E: fmt::Display> fmt::Display for CassandraError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Blocked(blocked) => blocked.fmt(f),
            Self::Driver(error) => error.fmt(f),
        }
    }
}

impl<E: Error + 'static> Error for CassandraError<E> {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Blocked(blocked) => Some(blocked),
            Self::Driver(error) => Some(error),
        }
    }
}

impl<E> From<PreviewWriteBlocked> for CassandraError<E> {
    fn from(blocked: PreviewWriteBlocked) -> Self {
        Self::Blocked(blocked)
    }
}

/// What the guard noted about a statement in flight, until it finishes and can be logged.
struct Pending {
    operation: String,
    target: Option<String>,
    statement: String,
    started: Instant,
}

/// The decision point of every guarded call: classify, refuse or let through, then log.
#[derive(Clone)]
struct Hook {
    scope: StoreScope,
    reads: Arc<HashSet<String>>,
    open: OpenPreviews,
}

impl Hook {
    /// Classifies one statement's text before it is sent. `Err` is a refusal (the Preview is marked);
    /// `Ok(None)` is a statement that is allowed and not logged.
    fn check(&self, text: &str) -> Result<Option<Pending>, PreviewWriteBlocked> {
        let classified = classify_cql(text, Some(&self.reads));
        self.admit(&classified.operation, classified.kind, text, None)
    }

    /// A batch is always a write. `texts` are its statements, for the log entry.
    fn check_batch(&self, texts: &[&str]) -> Result<Option<Pending>, PreviewWriteBlocked> {
        let joined = format!("BEGIN BATCH {}; APPLY BATCH", texts.join("; "));
        self.admit("BATCH", CommandKind::Write, &joined, texts.first().copied())
    }

    fn admit(&self, operation: &str, kind: CommandKind, text: &str, target_of: Option<&str>) -> Result<Option<Pending>, PreviewWriteBlocked> {
        // A write no request sent, while a Preview is open, is refused before it is sent.
        self.open.block_unattributed(&self.scope, SYSTEM, operation, kind)?;
        self.scope.guard(SYSTEM, operation, kind, None)?;
        if matches!(kind, CommandKind::Session | CommandKind::Transaction) {
            return Ok(None);
        }
        Ok(Some(Pending {
            operation: operation.to_owned(),
            target: cql_target(target_of.unwrap_or(text)),
            statement: sanitize_cql(text),
            started: Instant::now(),
        }))
    }

    fn finish(&self, pending: Option<Pending>, keyspace: Option<Arc<String>>, rows: Option<u64>, error: Option<String>) {
        let Some(pending) = pending else { return };
        self.scope.log(DbEntry {
            system: SYSTEM.into(),
            operation: pending.operation,
            target: pending.target,
            namespace: keyspace.map(|keyspace| keyspace.to_string()),
            statement: Some(pending.statement),
            rows_affected: rows,
            error,
            elapsed: pending.started.elapsed(),
            ..DbEntry::default()
        });
    }
}

/// The name of a driver error for a `Db` entry: the server's own error kind when it sent one, else the
/// error's type. It never includes the message, which may repeat a value.
fn error_name(error: &ExecutionError) -> String {
    match error {
        ExecutionError::LastAttemptError(RequestAttemptError::DbError(db, _)) => first_word(&format!("{db:?}")),
        other => first_word(&format!("{other:?}")),
    }
}

fn first_word(debug: &str) -> String {
    debug.split(|c: char| !(c.is_alphanumeric() || c == '_')).find(|word| !word.is_empty()).unwrap_or("Error").to_owned()
}

/// The `scylla` session of a [`CassandraStore`], with every statement classified before it is sent.
/// See [`Cassandra::session`].
///
/// It mirrors the driver's `Session` methods that send statements. A method it doesn't mirror is not
/// reachable, which is the point: nothing can send around the guard.
#[derive(Clone)]
pub struct GuardedSession {
    session: Arc<Session>,
    hook: Hook,
}

impl GuardedSession {
    /// The keyspace the session is using.
    pub fn get_keyspace(&self) -> Option<Arc<String>> {
        self.session.get_keyspace()
    }

    /// Runs one unprepared statement and returns all its rows ([`Session::query_unpaged`]).
    pub async fn query_unpaged(
        &self,
        statement: impl Into<Statement>,
        values: impl SerializeRow,
    ) -> Result<QueryResult, CassandraError<ExecutionError>> {
        let statement = statement.into();
        let pending = self.hook.check(&statement.contents)?;
        let result = self.session.query_unpaged(statement, values).await;
        self.hook.finish(pending, self.get_keyspace(), None,result.as_ref().err().map(error_name));
        result.map_err(CassandraError::Driver)
    }

    /// Runs one unprepared statement and returns one page ([`Session::query_single_page`]).
    pub async fn query_single_page(
        &self,
        statement: impl Into<Statement>,
        values: impl SerializeRow,
        paging_state: PagingState,
    ) -> Result<(QueryResult, PagingStateResponse), CassandraError<ExecutionError>> {
        let statement = statement.into();
        let pending = self.hook.check(&statement.contents)?;
        let result = self.session.query_single_page(statement, values, paging_state).await;
        self.hook.finish(pending, self.get_keyspace(), None,result.as_ref().err().map(error_name));
        result.map_err(CassandraError::Driver)
    }

    /// Runs one unprepared statement and returns a pager over every page ([`Session::query_iter`]).
    pub async fn query_iter(
        &self,
        statement: impl Into<Statement>,
        values: impl SerializeRow,
    ) -> Result<QueryPager, CassandraError<PagerExecutionError>> {
        let statement = statement.into();
        let pending = self.hook.check(&statement.contents)?;
        let result = self.session.query_iter(statement, values).await;
        self.hook.finish(pending, self.get_keyspace(), None, result.as_ref().err().map(|error| first_word(&format!("{error:?}"))));
        result.map_err(CassandraError::Driver)
    }

    /// Prepares a statement ([`Session::prepare`]). Preparing only parses the text, so it is allowed
    /// and not logged; the prepared statement is classified by its text when it is executed.
    pub async fn prepare(&self, statement: impl Into<Statement>) -> Result<PreparedStatement, PrepareError> {
        self.session.prepare(statement).await
    }

    /// Prepares every statement of a batch ([`Session::prepare_batch`]). Allowed and not logged.
    pub async fn prepare_batch(&self, batch: &Batch) -> Result<Batch, PrepareError> {
        self.session.prepare_batch(batch).await
    }

    /// Executes a prepared statement and returns all its rows ([`Session::execute_unpaged`]).
    pub async fn execute_unpaged(
        &self,
        prepared: &PreparedStatement,
        values: impl SerializeRow,
    ) -> Result<QueryResult, CassandraError<ExecutionError>> {
        let pending = self.hook.check(prepared.get_statement())?;
        let result = self.session.execute_unpaged(prepared, values).await;
        self.hook.finish(pending, self.get_keyspace(), None,result.as_ref().err().map(error_name));
        result.map_err(CassandraError::Driver)
    }

    /// Executes a prepared statement and returns one page ([`Session::execute_single_page`]).
    pub async fn execute_single_page(
        &self,
        prepared: &PreparedStatement,
        values: impl SerializeRow,
        paging_state: PagingState,
    ) -> Result<(QueryResult, PagingStateResponse), CassandraError<ExecutionError>> {
        let pending = self.hook.check(prepared.get_statement())?;
        let result = self.session.execute_single_page(prepared, values, paging_state).await;
        self.hook.finish(pending, self.get_keyspace(), None,result.as_ref().err().map(error_name));
        result.map_err(CassandraError::Driver)
    }

    /// Executes a prepared statement and returns a pager over every page ([`Session::execute_iter`]).
    pub async fn execute_iter(
        &self,
        prepared: impl Into<PreparedStatement>,
        values: impl SerializeRow,
    ) -> Result<QueryPager, CassandraError<PagerExecutionError>> {
        let prepared = prepared.into();
        let pending = self.hook.check(prepared.get_statement())?;
        let result = self.session.execute_iter(prepared, values).await;
        self.hook.finish(pending, self.get_keyspace(), None, result.as_ref().err().map(|error| first_word(&format!("{error:?}"))));
        result.map_err(CassandraError::Driver)
    }

    /// Executes a bound statement and returns all its rows ([`Session::execute_bound_unpaged`]).
    pub async fn execute_bound_unpaged(&self, bound: &BoundStatement) -> Result<QueryResult, CassandraError<ExecutionError>> {
        let pending = self.hook.check(bound.prepared().get_statement())?;
        let result = self.session.execute_bound_unpaged(bound).await;
        self.hook.finish(pending, self.get_keyspace(), None,result.as_ref().err().map(error_name));
        result.map_err(CassandraError::Driver)
    }

    /// Executes a bound statement and returns one page ([`Session::execute_bound_single_page`]).
    pub async fn execute_bound_single_page(
        &self,
        bound: &BoundStatement,
        paging_state: PagingState,
    ) -> Result<(QueryResult, PagingStateResponse), CassandraError<ExecutionError>> {
        let pending = self.hook.check(bound.prepared().get_statement())?;
        let result = self.session.execute_bound_single_page(bound, paging_state).await;
        self.hook.finish(pending, self.get_keyspace(), None,result.as_ref().err().map(error_name));
        result.map_err(CassandraError::Driver)
    }

    /// Executes a bound statement and returns a pager over every page ([`Session::execute_bound_iter`]).
    pub async fn execute_bound_iter(&self, bound: BoundStatement) -> Result<QueryPager, CassandraError<PagerExecutionError>> {
        let pending = self.hook.check(bound.prepared().get_statement())?;
        let result = self.session.execute_bound_iter(bound).await;
        self.hook.finish(pending, self.get_keyspace(), None, result.as_ref().err().map(|error| first_word(&format!("{error:?}"))));
        result.map_err(CassandraError::Driver)
    }

    /// Sends a batch ([`Session::batch`]). **A batch is always refused in a Preview**: its prepared
    /// statements can't be told apart from writes, and a logged batch can't be held back and discarded.
    /// An empty batch is refused too.
    pub async fn batch(&self, batch: &Batch, values: impl BatchValues) -> Result<QueryResult, CassandraError<ExecutionError>> {
        let texts: Vec<&str> = batch
            .statements
            .iter()
            .map(|statement| match statement {
                BatchStatement::Query(query) => query.contents.as_str(),
                BatchStatement::PreparedStatement(prepared) => prepared.get_statement(),
                // A statement kind a later driver adds: its text is unknown, the batch is refused anyway.
                _ => "",
            })
            .collect();
        let pending = self.hook.check_batch(&texts)?;
        let result = self.session.batch(batch, values).await;
        self.hook.finish(pending, self.get_keyspace(), None, result.as_ref().err().map(error_name));
        result.map_err(CassandraError::Driver)
    }

    /// Changes the session's keyspace ([`Session::use_keyspace`]). `USE` only changes the connection's
    /// keyspace, so it is allowed.
    pub async fn use_keyspace(&self, keyspace: impl Into<String>, case_sensitive: bool) -> Result<(), UseKeyspaceError> {
        self.session.use_keyspace(keyspace, case_sensitive).await
    }
}

#[cfg(test)]
mod tests;
