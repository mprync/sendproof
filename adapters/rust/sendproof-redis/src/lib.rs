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
//! let store = RedisStore::new().name("cache").expect("a display label");
//! // Register it: Config::builder("Inventory").data_store(store.clone())
//!
//! // In a handler, take the `Redis` extractor and guard the connection you already use:
//! # fn handler(redis: Redis, connection: redis::aio::MultiplexedConnection) -> impl std::future::Future<Output = redis::RedisResult<i64>> {
//! # async move {
//! let mut conn = redis.guard(connection);
//! redis::cmd("INCR").arg("counter:a").query_async(&mut conn).await
//! # } }
//! # Ok(()) }
//! ```
//!
//! # Coverage
//!
//! Only connections passed through [`Redis::guard`] are covered. A connection used directly, a second
//! client, a pub/sub connection, or a raw socket is not guarded and not logged: its writes are neither
//! blocked nor rolled back. Anything a Lua script or function writes is guarded as a write (`EVAL`,
//! `EVALSHA` and `FCALL` are writes; their `_RO` forms are reads).

mod describe;
#[cfg(feature = "actix")]
mod actix_extractor;
#[cfg(feature = "axum")]
mod axum_extractor;

#[cfg(feature = "actix")]
pub use actix_extractor::RedisRejection;
#[cfg(feature = "axum")]
pub use axum_extractor::NotEnrolledResponse;

use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};

use redis::{
    Arg, Cmd, ErrorKind, Pipeline, RedisError, RedisFuture, Value,
    aio::ConnectionLike,
};
use sendproof_core::{
    BoxFuture, CommandKind, ConfigError, DataStore, DbEntry, Enrollment, NotEnrolled, StoreDescription, StoreMode, StoreScope,
    stores::{classify_redis, exact_names, store_label},
};

/// The store id used in capabilities, `Db` entries and the blocked response.
pub const SYSTEM: &str = "redis";

struct Settings {
    name: Option<String>,
    reads: HashSet<String>,
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
    /// A Redis store with no display label and no host-declared reads.
    pub fn new() -> Self {
        Self { settings: Arc::new(Settings { name: None, reads: HashSet::new() }) }
    }

    /// The display label shown in capabilities, such as `cache`. A label that looks like a URL,
    /// host or connection string is refused: discovery is visible to anyone who can open the workbench.
    pub fn name(self, label: &str) -> Result<Self, ConfigError> {
        let name = store_label(label)?;
        Ok(Self { settings: Arc::new(Settings { name: Some(name), reads: self.settings.reads.clone() }) })
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
        Ok(Self { settings: Arc::new(Settings { name: self.settings.name.clone(), reads }) })
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
}

/// The Redis handle of one request. Take it as a handler argument, then [`guard`](Self::guard) the
/// connection you use.
#[derive(Clone)]
pub struct Redis {
    scope: StoreScope,
    settings: Arc<Settings>,
}

impl Redis {
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
        self.scope.guard(SYSTEM, &command.name, kind, None).map_err(|blocked| {
            // The mark is recorded; the handler sees an ordinary client error.
            RedisError::from((ErrorKind::Client, "Preview unavailable", blocked.detail))
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
                    Err(refusal) => return Err(refusal),
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
