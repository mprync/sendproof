//! Elasticsearch and OpenSearch write guard for [Sendproof](https://github.com/mprync/sendproof)
//! (`spec/data-stores.md`, `guard` mode).
//!
//! Neither engine can roll back, so a Preview reads the cluster normally and is stopped **before the
//! first write is sent**. One shared classification table covers both engines: the unit is the HTTP
//! method and path, so `POST /<index>/_search` is a read and `POST /<index>/_update_by_query` is a write.
//!
//! # The hook, and why it is a wrapper
//!
//! Both official Rust clients send every request through one concrete `Transport` struct with no
//! middleware, and the typed builders (`client.search()...send()`) call it directly, so nothing between
//! the application and the socket can be intercepted. (The first thing tried was a custom `reqwest`
//! client through `TransportBuilder`; neither crate takes one, and a `reqwest` layer can't see requests.)
//! The guard is therefore a wrapper over the client's own raw `send`: the store owns the client and
//! hands out only [`GuardedElasticsearch`] / [`GuardedOpenSearch`], whose [`send`](GuardedOpenSearch::send)
//! has the same signature as the client's. Every request goes through it and is classified before the
//! client sees it. The typed builders aren't available through the guard; build the request by method
//! and path.
//!
//! ```no_run
//! # #[cfg(feature = "opensearch")]
//! # async fn demo() -> Result<(), Box<dyn std::error::Error>> {
//! use opensearch::{OpenSearch, http::{Method, headers::HeaderMap, request::JsonBody, transport::Transport}};
//! use sendproof_elasticsearch::OpenSearchStore;
//!
//! let client = OpenSearch::new(Transport::single_node("http://127.0.0.1:9200")?);
//! // The store owns the client; keep only the store in application state.
//! let store = OpenSearchStore::new(client).name("articles")?;
//! // Register it: Config::builder("Inventory").data_store(store.clone())
//!
//! // In a handler, take the `OpenSearch` extractor and use its guarded client:
//! # async fn handler(search: sendproof_elasticsearch::OpenSearch) -> Result<(), Box<dyn std::error::Error>> {
//! let reply = search
//!     .client()
//!     .send(Method::Post, "/articles/_search", HeaderMap::new(), None::<&()>, Some(JsonBody::new(serde_json::json!({ "size": 1 }))), None)
//!     .await?;
//! # let _ = reply;
//! # Ok(()) }
//! # Ok(()) }
//! ```
//!
//! In a Preview:
//!
//! * a read (`GET` and `HEAD`, `_search`, `_count`, `_msearch`, `_mget`, `_field_caps`, the template
//!   searches, SQL that is one `SELECT`/`SHOW`/`DESCRIBE`, and the others the table lists) runs and
//!   becomes a `Db` log entry: the index as its target and the body with every literal replaced by `?`;
//! * the first write is refused with an error from the client (its source is a
//!   [`PreviewWriteBlocked`](sendproof_core::PreviewWriteBlocked), see [`blocked_by`]) and marks the
//!   Preview blocked, which then answers 409 whatever the handler does with the error. Writes are
//!   `_bulk`, `_update_by_query`, `_delete_by_query`, `_reindex`, every document `PUT`, `POST` and
//!   `DELETE`, stored scripts, index, alias and template changes, any SQL that is not a single read, and
//!   anything the table doesn't list that isn't a `GET` or `HEAD`;
//! * point-in-time, scroll, async-search and SQL-cursor handles are session state: they run and are
//!   not logged.
//!
//! # Coverage
//!
//! Only the client given to the store is covered, and only through the handles it hands out; the store
//! never gives the raw client back. There is no command monitoring to fall back on, so a second client
//! the application builds itself is not seen: its writes are neither blocked nor logged, and the
//! Preview is still confirmed. Keep every client inside the store.
//!
//! A handle taken in a handler keeps its Preview in tasks the handler spawns. A handle from the store's
//! `detached()` has no request: its write while a Preview is open can't be told from a Preview's, and has
//! already been sent, so every Preview open on the store answers 500. Use
//! [`detached`](sendproof_core::detached) for background work that writes.

#[cfg(any(feature = "axum", feature = "actix"))]
mod extractors;

#[cfg(feature = "actix")]
pub use extractors::SearchRejection;
#[cfg(feature = "axum")]
pub use extractors::NotEnrolledResponse;

use std::{collections::HashSet, error::Error, io, sync::Arc, time::Instant};

use sendproof_core::{
    DbEntry, PreviewWriteBlocked, StoreScope,
    stores::{CommandKind, OpenPreviews, classify_search, sanitize_search_body, search_target},
};

/// The largest request body a `Db` entry's statement is built from. A larger one is classified but its
/// statement is not shown.
const STATEMENT_BODY_LIMIT: usize = 256 * 1024;

/// The refusal in `error`'s chain, when the guard refused the request: the client's `Error` wraps an
/// I/O error that carries the [`PreviewWriteBlocked`].
pub fn blocked_by<'a>(error: &'a (dyn Error + 'static)) -> Option<&'a PreviewWriteBlocked> {
    let mut current: Option<&'a (dyn Error + 'static)> = Some(error);
    while let Some(error) = current {
        if let Some(blocked) = error.downcast_ref::<PreviewWriteBlocked>() {
            return Some(blocked);
        }
        if let Some(inner) = error.downcast_ref::<io::Error>().and_then(io::Error::get_ref)
            && let Some(blocked) = inner.downcast_ref::<PreviewWriteBlocked>()
        {
            return Some(blocked);
        }
        current = error.source();
    }
    None
}

/// What the guard noted about a request in flight, until it finishes and can be logged.
pub(crate) struct Pending {
    operation: String,
    target: Option<String>,
    statement: Option<String>,
    started: Instant,
}

/// The decision point of every guarded request: classify, refuse or let through, then log.
#[derive(Clone)]
pub(crate) struct Hook {
    pub(crate) system: &'static str,
    pub(crate) scope: StoreScope,
    pub(crate) reads: Arc<HashSet<String>>,
    pub(crate) open: OpenPreviews,
}

impl Hook {
    /// Classifies one request before it is sent. `Err` is a refusal (the Preview is marked);
    /// `Ok(None)` is a request that is allowed and not logged.
    pub(crate) fn check(&self, method: &str, path: &str, body: Option<&[u8]>) -> Result<Option<Pending>, PreviewWriteBlocked> {
        let classified = classify_search(method, path, body, Some(&self.reads));
        self.open.refuse_unattributed(&self.scope, self.system, &classified.operation, classified.kind);
        self.scope.guard(self.system, &classified.operation, classified.kind, None)?;
        if matches!(classified.kind, CommandKind::Session | CommandKind::Transaction) {
            return Ok(None);
        }
        Ok(Some(Pending {
            operation: classified.operation,
            target: search_target(path),
            statement: body.filter(|body| body.len() <= STATEMENT_BODY_LIMIT).and_then(sanitize_search_body),
            started: Instant::now(),
        }))
    }

    /// Logs a request that was sent. `status` is the HTTP status when the cluster answered; `failed` is
    /// set when it could not be reached.
    pub(crate) fn finish(&self, pending: Option<Pending>, status: Option<u16>, failed: bool) {
        let Some(pending) = pending else { return };
        let error = match status {
            Some(status) if status >= 400 => Some(status.to_string()),
            None if failed => Some("Error".to_owned()),
            _ => None,
        };
        self.scope.log(DbEntry {
            system: self.system.into(),
            operation: pending.operation,
            target: pending.target,
            statement: pending.statement,
            error,
            elapsed: pending.started.elapsed(),
            ..DbEntry::default()
        });
    }
}

/// Validates host-declared reads: exact operation names, as the `Db` entry shows them. A name is a
/// table endpoint (`search`) or, for a path the table doesn't list, `METHOD /path` with `{}` for each
/// segment that doesn't start with an underscore (`POST /{}/_future`), so it holds one space. Wildcards,
/// empty names and stray whitespace are refused.
pub(crate) fn exact_operations<I, S>(names: I) -> Result<HashSet<String>, sendproof_core::ConfigError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    names
        .into_iter()
        .map(|name| {
            let name = name.as_ref();
            if name.is_empty() || name.contains(['*', '?']) || name.trim() != name || name.matches(' ').count() > 1 || name.chars().any(char::is_control) {
                Err(sendproof_core::ConfigError(format!(
                    "treat-as-read takes exact operation names, without wildcards (got `{name}`): an endpoint name such as `search`, or `METHOD /path` such as `POST /{{}}/_future`"
                )))
            } else {
                Ok(name.to_owned())
            }
        })
        .collect()
}

/// The client's error for a refusal: an I/O error whose payload is the [`PreviewWriteBlocked`].
pub(crate) fn refusal(blocked: PreviewWriteBlocked) -> io::Error {
    io::Error::other(blocked)
}

/// Generates the store, handle and guarded client of one engine. The two official crates have the same
/// shape and different types, so one definition serves both.
macro_rules! engine {
    (
        feature = $feature:literal,
        krate = $krate:ident,
        module = $module:ident,
        client = $Client:ident,
        store = $Store:ident,
        handle = $Handle:ident,
        guarded = $Guarded:ident,
        system = $system:literal,
        display = $display:literal $(,)?
    ) => {
        #[cfg(feature = $feature)]
        mod $module {
            use std::{collections::HashSet, sync::Arc, time::Duration};

            use $krate::{
                Error,
                http::{Method, headers::HeaderMap, request::Body, response::Response},
            };
            use bytes::{Bytes, BytesMut};
            use sendproof_core::{
                BoxError, BoxFuture, ConfigError, DataStore, Enrollment, NotEnrolled, PreviewSession, StoreDescription, StoreMode, StoreScope,
                stores::{OpenPreviews, store_label},
            };
            use serde::Serialize;

            use crate::{Hook, exact_operations, refusal};

            /// The store id used in capabilities, `Db` entries and the blocked response.
            pub const SYSTEM: &str = $system;

            struct Settings {
                name: Option<String>,
                reads: Arc<HashSet<String>>,
                client: Arc<$krate::$Client>,
                open: OpenPreviews,
            }

            #[doc = concat!("A hooked ", $display, ", ready for [`ConfigBuilder::data_store`](sendproof_core::ConfigBuilder::data_store).")]
            ///
            /// Cheap to clone. Keep one in application state so handlers can take the handle extractor.
            #[derive(Clone)]
            pub struct $Store {
                settings: Arc<Settings>,
            }

            impl $Store {
                #[doc = concat!("A store that owns `client`. It hands the client out only guarded, so give it the client instead of keeping one in application state.")]
                pub fn new(client: $krate::$Client) -> Self {
                    Self {
                        settings: Arc::new(Settings { name: None, reads: Arc::default(), client: Arc::new(client), open: OpenPreviews::new() }),
                    }
                }

                fn with(self, change: impl FnOnce(&mut Settings)) -> Self {
                    // Settings are shared by clones; building the store happens before the first clone.
                    let mut settings = Arc::try_unwrap(self.settings).unwrap_or_else(|shared| Settings {
                        name: shared.name.clone(),
                        reads: shared.reads.clone(),
                        client: shared.client.clone(),
                        open: shared.open.clone(),
                    });
                    change(&mut settings);
                    Self { settings: Arc::new(settings) }
                }

                /// The display label shown in capabilities, such as `articles`. A label that looks like a
                /// URL, host or connection string is refused: discovery is visible to anyone who can open
                /// the workbench.
                pub fn name(self, label: &str) -> Result<Self, ConfigError> {
                    let name = store_label(label)?;
                    Ok(self.with(|settings| settings.name = Some(name)))
                }

                /// Operations the host states never write, matched exactly by the name the `Db` entry
                /// shows (the table's endpoint name, such as `search`, or `POST /{}/_future` for an
                /// unlisted path). No wildcards.
                ///
                /// **This is the host's statement that the operation never writes.** One wrongly listed
                /// here is not blocked in a Preview.
                pub fn treat_as_read<I, S>(self, names: I) -> Result<Self, ConfigError>
                where
                    I: IntoIterator<Item = S>,
                    S: AsRef<str>,
                {
                    let reads = exact_operations(names)?;
                    Ok(self.with(|settings| settings.reads = Arc::new(reads)))
                }

                /// The handle for a request, from the request's enrollment. `required` says the request
                /// is a preview (the adapter inserted [`PreviewRequired`](sendproof_core::PreviewRequired));
                /// a preview that the gate did not enroll fails, so an undeclared route can never write.
                pub fn from_enrollment(&self, enrollment: Option<&Enrollment>, required: bool) -> Result<$Handle, NotEnrolled> {
                    Ok($Handle { scope: StoreScope::from_enrollment(enrollment, required)?, settings: self.settings.clone() })
                }

                /// The handle outside any request scope: guards through the task-local capture, if one
                /// is active. Useful in tests and background work (see the crate's coverage notes).
                pub fn detached(&self) -> $Handle {
                    $Handle { scope: StoreScope::current(), settings: self.settings.clone() }
                }
            }

            impl DataStore for $Store {
                fn describe(&self) -> BoxFuture<'_, StoreDescription> {
                    let name = self.settings.name.clone();
                    Box::pin(async move { StoreDescription { system: SYSTEM.into(), name, mode: StoreMode::Guard, reason: None } })
                }

                /// Registers the Preview as open on this store until it finishes, so a write no request
                /// sent fails it. Nothing is started on the cluster.
                fn begin_preview<'a>(
                    &'a self,
                    extensions: &'a mut http::Extensions,
                ) -> BoxFuture<'a, Result<Option<Box<dyn PreviewSession>>, BoxError>> {
                    let begun = self.settings.open.begin(extensions).map(Some);
                    Box::pin(async move { begun })
                }
            }

            #[doc = concat!("The ", $display, " handle of one request. Take it as a handler argument, then use [`client`](Self::client).")]
            #[derive(Clone)]
            pub struct $Handle {
                pub(crate) scope: StoreScope,
                settings: Arc<Settings>,
            }

            impl $Handle {
                /// The store's client, guarded for this request.
                pub fn client(&self) -> $Guarded {
                    $Guarded {
                        client: self.settings.client.clone(),
                        hook: Hook {
                            system: SYSTEM,
                            scope: self.scope.clone(),
                            reads: self.settings.reads.clone(),
                            open: self.settings.open.clone(),
                        },
                    }
                }
            }

            #[doc = concat!("The ", $display, " client of a store, with every request classified before it is sent. See [`", stringify!($Handle), "::client`].")]
            ///
            /// Its [`send`](Self::send) takes what the client's own `send` takes. The client's typed
            /// builders aren't reachable, which is the point: nothing can send around the guard.
            #[derive(Clone)]
            pub struct $Guarded {
                client: Arc<$krate::$Client>,
                hook: Hook,
            }

            impl $Guarded {
                /// Sends one request, after classifying it by its method and path (and, for the SQL
                /// endpoints, its body). It takes what the client's own `send` takes.
                ///
                /// A write in a Preview fails with an `Error` whose source is a
                /// [`PreviewWriteBlocked`](sendproof_core::PreviewWriteBlocked) (see [`crate::blocked_by`]);
                /// nothing was sent. A path may carry a query string; the `query_string` argument is
                /// sent as given.
                pub async fn send<B, Q>(
                    &self,
                    method: Method,
                    path: &str,
                    headers: HeaderMap,
                    query_string: Option<&Q>,
                    body: Option<B>,
                    timeout: Option<Duration>,
                ) -> Result<Response, Error>
                where
                    B: Body,
                    Q: Serialize + ?Sized,
                {
                    // The body is serialized once, so the same bytes are classified, logged (with every
                    // literal replaced by `?`) and sent.
                    let bytes: Option<Bytes> = match body {
                        Some(body) => Some(match body.bytes() {
                            Some(bytes) => bytes,
                            None => {
                                let mut buffer = BytesMut::new();
                                body.write(&mut buffer)?;
                                buffer.freeze()
                            }
                        }),
                        None => None,
                    };
                    #[allow(unreachable_patterns)]
                    let verb = match method {
                        Method::Get => "GET",
                        Method::Head => "HEAD",
                        Method::Post => "POST",
                        Method::Put => "PUT",
                        Method::Delete => "DELETE",
                        // A method a later version of the client adds is classified as a write.
                        _ => "UNKNOWN",
                    };
                    let pending = self.hook.check(verb, path, bytes.as_deref()).map_err(|blocked| Error::from(refusal(blocked)))?;
                    let reply = self.client.send(method, path, headers, query_string, bytes, timeout).await;
                    let status = reply.as_ref().ok().map(|response| response.status_code().as_u16());
                    self.hook.finish(pending, status, reply.is_err());
                    reply
                }
            }
        }

        #[cfg(feature = $feature)]
        pub use $module::{$Guarded, $Handle, $Store};

        #[cfg(all(feature = $feature, feature = "axum"))]
        crate::extractors::axum_extractor!($Handle, $Store);
        #[cfg(all(feature = $feature, feature = "actix"))]
        crate::extractors::actix_extractor!($Handle, $Store);
    };
}

engine! {
    feature = "elasticsearch",
    krate = elasticsearch,
    module = engine_elasticsearch,
    client = Elasticsearch,
    store = ElasticsearchStore,
    handle = Elasticsearch,
    guarded = GuardedElasticsearch,
    system = "elasticsearch",
    display = "Elasticsearch",
}

engine! {
    feature = "opensearch",
    krate = opensearch,
    module = engine_opensearch,
    client = OpenSearch,
    store = OpenSearchStore,
    handle = OpenSearch,
    guarded = GuardedOpenSearch,
    system = "opensearch",
    display = "OpenSearch",
}

#[cfg(test)]
mod tests;
