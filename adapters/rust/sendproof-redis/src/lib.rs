//! Redis write guard for [Sendproof](https://github.com/mprync/sendproof) (`spec/data-stores.md`, `guard` mode).
//!
//! Redis can't roll back, so a Preview reads Redis normally and is stopped **before the first write is
//! sent**. [`GuardedConnection`] wraps any [`redis::aio::ConnectionLike`] connection (a
//! `MultiplexedConnection`, a `ConnectionManager`, a pooled connection) and classifies every command
//! before it is packed onto the socket:
//!
//! * a read runs, and becomes a `Db` log entry whose statement keeps the command name and key
//!   arguments only (`SET session:42 ? ? ?`);
//! * in a Preview the first write is refused with a [`RedisError`](redis::RedisError) and marks the
//!   Preview blocked, which then answers 409 whatever the handler does with the error;
//! * `AUTH`, `HELLO`, `PING`, `SELECT` and the other session commands are never guarded or logged;
//! * a pipeline (including `atomic()`) is classified **as a whole** before anything is written, so a
//!   refused write means no command of the pipeline, and no `EXEC`, reaches Redis.
//!
//! ```no_run
//! # async fn demo() -> redis::RedisResult<()> {
//! use sendproof_redis::{Redis, RedisStore};
//!
//! let client = redis::Client::open("redis://127.0.0.1/")?;
//! let connection = client.get_multiplexed_async_connection().await?;
//! // The store owns the connection; keep only the store in application state.
//! let store = RedisStore::new().connection(connection).name("cache").expect("a display label");
//! // Register it: Config::builder("Inventory").data_store(store.clone())
//!
//! // In a handler, take the `Redis` extractor and use its guarded connection:
//! # fn handler(redis: Redis) -> impl std::future::Future<Output = redis::RedisResult<i64>> {
//! # async move {
//! let mut conn = redis.connection();
//! redis::cmd("INCR").arg("counter:a").query_async(&mut conn).await
//! # } }
//! # Ok(()) }
//! ```
//!
//! A connection the store doesn't own, such as one checked out of a deadpool or bb8 pool, is guarded
//! with [`Redis::guard`].
//!
//! # Coverage
//!
//! Only connections handed out by [`Redis::connection`] or passed through [`Redis::guard`] are
//! covered. Redis has no command monitoring to fall back on, so a raw connection used directly, a
//! second client, a pub/sub connection, or a raw socket is not guarded and not logged: its writes are
//! neither blocked nor rolled back, and the Preview is still confirmed. Keep the raw connection out
//! of handler reach: give it to the store and use [`Redis::connection`]. Anything a Lua script or function writes is guarded as a write (`EVAL`,
//! `EVALSHA` and `FCALL` are writes; their `_RO` forms are reads).

#[cfg(feature = "actix")]
mod actix_extractor;
#[cfg(feature = "axum")]
mod axum_extractor;
mod describe;

#[cfg(feature = "actix")]
pub use actix_extractor::RedisRejection;
#[cfg(feature = "axum")]
pub use axum_extractor::NotEnrolledResponse;

use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};

use redis::{Arg, Cmd, ErrorKind, Pipeline, RedisError, RedisFuture, Value, aio::ConnectionLike};
use sendproof_core::{
    BoxFuture, CommandKind, ConfigError, DataStore, DbEntry, Enrollment, NotEnrolled, PreviewSession, StoreDescription, StoreMode,
    StoreScope,
    stores::{OpenPreviews, classify_redis, exact_names, store_label},
};

/// The store id used in capabilities, `Db` entries and the blocked response.
pub const SYSTEM: &str = "redis";

#[derive(Clone, Default)]
struct Settings {
    name: Option<String>,
    reads: HashSet<String>,
    connection: Option<SharedConnection>,
    /// The Previews open on this store: a write no request sent is refused while one is open.
    open: OpenPreviews,
}

/// A connection that can be cloned for each request and shared across threads.
trait CloneConnection: ConnectionLike + Send + Sync {
    fn clone_box(&self) -> Box<dyn CloneConnection>;
}

impl<C: ConnectionLike + Clone + Send + Sync + 'static> CloneConnection for C {
    fn clone_box(&self) -> Box<dyn CloneConnection> {
        Box::new(self.clone())
    }
}

/// The connection a [`RedisStore`] owns (a `MultiplexedConnection`, a `ConnectionManager`, a cluster
/// connection), cloned for each request. Only ever handed out guarded: see [`Redis::connection`].
pub struct SharedConnection(Box<dyn CloneConnection>);

impl Clone for SharedConnection {
    fn clone(&self) -> Self {
        Self(self.0.clone_box())
    }
}

impl ConnectionLike for SharedConnection {
    fn req_packed_command<'a>(&'a mut self, cmd: &'a Cmd) -> RedisFuture<'a, Value> {
        self.0.req_packed_command(cmd)
    }

    fn req_packed_commands<'a>(&'a mut self, pipeline: &'a Pipeline, offset: usize, count: usize) -> RedisFuture<'a, Vec<Value>> {
        self.0.req_packed_commands(pipeline, offset, count)
    }

    fn get_db(&self) -> i64 {
        self.0.get_db()
    }
}

/// A hooked Redis, ready for [`ConfigBuilder::data_store`](sendproof_core::ConfigBuilder::data_store).
///
/// Cheap to clone. Keep one in application state so handlers can take the [`Redis`] extractor.
#[derive(Clone)]
pub struct RedisStore {
    settings: Arc<Settings>,
}

impl Default for RedisStore {
    fn default() -> Self {
        Self::new()
    }
}

impl RedisStore {
    /// A Redis store with no connection, no display label and no host-declared reads.
    pub fn new() -> Self {
        Self { settings: Arc::new(Settings::default()) }
    }

    fn with(self, change: impl FnOnce(&mut Settings)) -> Self {
        let mut settings = Settings::clone(&self.settings);
        change(&mut settings);
        Self { settings: Arc::new(settings) }
    }

    /// The connection [`Redis::connection`] hands to each request, guarded. Any cloneable async
    /// connection works: a `MultiplexedConnection`, a `ConnectionManager` or a cluster connection.
    /// Give the store the connection instead of keeping it in application state, so a handler can't
    /// reach it unguarded.
    pub fn connection<C: ConnectionLike + Clone + Send + Sync + 'static>(self, connection: C) -> Self {
        self.with(|settings| settings.connection = Some(SharedConnection(Box::new(connection))))
    }

    /// The display label shown in capabilities, such as `cache`. A label that looks like a URL,
    /// host or connection string is refused: discovery is visible to anyone who can open the workbench.
    pub fn name(self, label: &str) -> Result<Self, ConfigError> {
        let name = store_label(label)?;
        Ok(self.with(|settings| settings.name = Some(name)))
    }

    /// Commands the host states never write, such as a custom module read `MYMODULE.GET`. Exact
    /// names (compared in upper case, `CONTAINER|SUB` for a subcommand), no wildcards.
    ///
    /// **This is the host's statement that the command never writes.** A command wrongly listed here
    /// is not blocked in a Preview.
    pub fn treat_as_read<I, S>(self, names: I) -> Result<Self, ConfigError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let reads = exact_names(names, str::to_ascii_uppercase)?;
        Ok(self.with(|settings| settings.reads = reads))
    }

    /// The handle for a request: [`Redis`] from the request's enrollment. `required` says the request
    /// is a preview (the adapter inserted [`PreviewRequired`](sendproof_core::PreviewRequired)); a
    /// preview that the gate did not enroll fails, so an undeclared route can never write.
    pub fn from_enrollment(&self, enrollment: Option<&Enrollment>, required: bool) -> Result<Redis, NotEnrolled> {
        Ok(Redis { scope: StoreScope::from_enrollment(enrollment, required)?, settings: self.settings.clone() })
    }

    /// The handle outside any request scope: guards through the task-local capture, if one is active.
    /// Useful in tests and background work.
    pub fn detached(&self) -> Redis {
        Redis { scope: StoreScope::current(), settings: self.settings.clone() }
    }
}

impl DataStore for RedisStore {
    fn describe(&self) -> BoxFuture<'_, StoreDescription> {
        let name = self.settings.name.clone();
        Box::pin(async move { StoreDescription { system: SYSTEM.into(), name, mode: StoreMode::Guard, reason: None } })
    }

    /// Registers the Preview as open on this store until it finishes, so a write no request sent (a
    /// spawned task, a connection used from background work) is refused. Nothing is started on Redis.
    fn begin_preview<'a>(
        &'a self,
        extensions: &'a mut http::Extensions,
    ) -> BoxFuture<'a, Result<Option<Box<dyn PreviewSession>>, sendproof_core::BoxError>> {
        let begun = self.settings.open.begin(extensions).map(Some);
        Box::pin(async move { begun })
    }
}

/// The Redis handle of one request. Take it as a handler argument, then use
/// [`connection`](Self::connection), or [`guard`](Self::guard) a connection the store doesn't own.
#[derive(Clone)]
pub struct Redis {
    scope: StoreScope,
    settings: Arc<Settings>,
}

impl Redis {
    /// The store's connection, guarded for this request.
    ///
    /// # Panics
    ///
    /// When the store was built without [`RedisStore::connection`]: a setup mistake, found on the first
    /// request that uses it.
    pub fn connection(&self) -> GuardedConnection<SharedConnection> {
        let connection = self.settings.connection.clone().expect("give the RedisStore a connection with `RedisStore::connection`");
        self.guard(connection)
    }

    /// Wraps a connection so every command is classified before it is sent. Outside a Preview the
    /// wrapper only logs; it never changes a reply.
    pub fn guard<C: ConnectionLike>(&self, connection: C) -> GuardedConnection<C> {
        GuardedConnection { inner: connection, scope: self.scope.clone(), settings: self.settings.clone(), in_multi: false }
    }
}

/// A connection whose every command is classified before it is sent. See [`Redis::guard`].
pub struct GuardedConnection<C> {
    inner: C,
    scope: StoreScope,
    settings: Arc<Settings>,
    /// A `MULTI` was sent and neither `EXEC` nor `DISCARD` has followed.
    in_multi: bool,
}

/// One command as the guard sees it: the upper-case name and the arguments after it. A cursor
/// placeholder has no bytes.
struct Command<'a> {
    name: String,
    args: Vec<Option<&'a [u8]>>,
}

impl<'a> Command<'a> {
    fn of(cmd: &'a Cmd) -> Self {
        let mut parts = cmd.args_iter().map(|arg| match arg {
            Arg::Simple(bytes) => Some(bytes),
            // A cursor placeholder, or an argument kind a later version adds: no bytes, shown as `?`.
            _ => None,
        });
        let name = parts.next().flatten().map(|name| String::from_utf8_lossy(name).to_ascii_uppercase()).unwrap_or_default();
        Self { name, args: parts.collect() }
    }

    fn kind(&self, reads: &HashSet<String>) -> CommandKind {
        classify_redis(&self.name, self.args.first().copied().flatten(), Some(reads))
    }
}

impl<C> GuardedConnection<C> {
    /// Classifies a command and refuses it in a Preview when it is a write.
    fn check(&self, command: &Command<'_>) -> Result<CommandKind, RedisError> {
        let kind = command.kind(&self.settings.reads);
        // A write no request sent, while a Preview is open, is refused before it is packed.
        let unattributed = self.settings.open.block_unattributed(&self.scope, SYSTEM, &command.name, kind);
        unattributed.and_then(|()| self.scope.guard(SYSTEM, &command.name, kind, None)).map_err(|blocked| {
            // The mark is recorded; the handler sees an ordinary client error naming the store and command.
            RedisError::from((ErrorKind::Client, "Preview unavailable", blocked.to_string()))
        })?;
        Ok(kind)
    }

    fn log(&self, command: &Command<'_>, kind: CommandKind, namespace: i64, elapsed: Duration, error: Option<&RedisError>) {
        if matches!(kind, CommandKind::Session | CommandKind::Transaction) {
            return;
        }
        let (statement, target) = describe::describe(&command.name, &command.args);
        self.scope.log(DbEntry {
            system: SYSTEM.into(),
            operation: command.name.clone(),
            target,
            namespace: Some(namespace.to_string()),
            statement: Some(statement),
            error: error.map(|error| error.code().map_or_else(|| format!("{:?}", error.kind()), str::to_owned)),
            elapsed,
            ..DbEntry::default()
        });
    }
}

impl<C: ConnectionLike + Send> GuardedConnection<C> {
    /// A write queued after `MULTI` must never be followed by `EXEC`: discard the transaction.
    async fn discard_if_open(&mut self) {
        if std::mem::take(&mut self.in_multi) {
            let _ = self.inner.req_packed_command(&redis::cmd("DISCARD")).await;
        }
    }
}

impl<C: ConnectionLike + Send> ConnectionLike for GuardedConnection<C> {
    fn req_packed_command<'a>(&'a mut self, cmd: &'a Cmd) -> RedisFuture<'a, Value> {
        Box::pin(async move {
            let command = Command::of(cmd);
            let kind = match self.check(&command) {
                Ok(kind) => kind,
                Err(refusal) => {
                    self.discard_if_open().await;
                    return Err(refusal);
                }
            };
            match command.name.as_str() {
                "MULTI" => self.in_multi = true,
                "EXEC" | "DISCARD" => self.in_multi = false,
                _ => {}
            }
            let started = Instant::now();
            let reply = self.inner.req_packed_command(cmd).await;
            let namespace = self.inner.get_db();
            self.log(&command, kind, namespace, started.elapsed(), reply.as_ref().err());
            reply
        })
    }

    fn req_packed_commands<'a>(&'a mut self, pipeline: &'a Pipeline, offset: usize, count: usize) -> RedisFuture<'a, Vec<Value>> {
        Box::pin(async move {
            // The whole pipeline is classified before the first command is written: refusing one
            // command mid-pipeline would corrupt reply matching.
            let commands: Vec<Command<'_>> = pipeline.cmd_iter().map(Command::of).collect();
            let mut kinds = Vec::with_capacity(commands.len());
            for command in &commands {
                match self.check(command) {
                    Ok(kind) => kinds.push(kind),
                    Err(refusal) => {
                        self.discard_if_open().await;
                        return Err(refusal);
                    }
                }
            }
            let started = Instant::now();
            let replies = self.inner.req_packed_commands(pipeline, offset, count).await;
            let (namespace, elapsed) = (self.inner.get_db(), started.elapsed());
            for (command, kind) in commands.iter().zip(kinds) {
                self.log(command, kind, namespace, elapsed, replies.as_ref().err());
            }
            replies
        })
    }

    fn get_db(&self) -> i64 {
        self.inner.get_db()
    }
}

#[cfg(test)]
mod tests;
