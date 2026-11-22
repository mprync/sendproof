//! The Axum routes of the fixture. Behavior lives in `rust-conformance-common`.
//!
//! The router is generic over the SQLx backend, so one set of routes serves SQLite, PostgreSQL and
//! MySQL; `main` picks the backend from `BENCH_DATABASE`.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::Request,
    extract::{FromRef, Path, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    middleware::{Next, from_fn_with_state},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rust_conformance_common::{
    auth::{self, Sessions},
    items::{self, Outbox, Outcome, RawCommit},
    openapi,
    scenario::Scenario,
    setup,
    stores::{Handles, Stores},
};
use sendproof_axum::{Sendproof, SendproofRouterExt};
use sendproof_cassandra::{Cassandra, CassandraStore};
use sendproof_core::{Enrollment, Headers, PreviewRequired};
use sendproof_elasticsearch::{OpenSearch, OpenSearchStore};
use sendproof_mongodb::{Mongo, MongoStore};
use sendproof_redis::{Redis, RedisStore};
use sendproof_sqlx::{Backend, Db, DbError};
use serde_json::Value;
use sqlx::Pool;

pub struct AppState<B: Backend> {
    pool: Pool<B>,
    sessions: Arc<Sessions>,
    outbox: Outbox,
    base: Arc<str>,
    stores: Arc<Stores>,
}

impl<B: Backend> Clone for AppState<B> {
    fn clone(&self) -> Self {
        Self {
            pool: self.pool.clone(),
            sessions: self.sessions.clone(),
            outbox: self.outbox.clone(),
            base: self.base.clone(),
            stores: self.stores.clone(),
        }
    }
}

// The store extractors read their store from the state. A store's routes exist only when the runner
// provisioned it, so these are never asked for an absent store.
impl<B: Backend> FromRef<AppState<B>> for MongoStore {
    fn from_ref(state: &AppState<B>) -> Self {
        state
            .stores
            .mongo
            .clone()
            .expect("MongoDB routes exist only when MongoDB is hooked")
    }
}

impl<B: Backend> FromRef<AppState<B>> for RedisStore {
    fn from_ref(state: &AppState<B>) -> Self {
        state
            .stores
            .redis
            .as_ref()
            .expect("Redis routes exist only when Redis is hooked")
            .store
            .clone()
    }
}

impl<B: Backend> FromRef<AppState<B>> for CassandraStore {
    fn from_ref(state: &AppState<B>) -> Self {
        state
            .stores
            .cassandra
            .as_ref()
            .expect("Cassandra routes exist only when Cassandra is hooked")
            .store
            .clone()
    }
}

impl<B: Backend> FromRef<AppState<B>> for OpenSearchStore {
    fn from_ref(state: &AppState<B>) -> Self {
        state
            .stores
            .opensearch
            .as_ref()
            .expect("OpenSearch routes exist only when OpenSearch is hooked")
            .store
            .clone()
    }
}

impl<B: Backend> FromRef<AppState<B>> for Pool<B> {
    fn from_ref(state: &AppState<B>) -> Self {
        state.pool.clone()
    }
}

fn reply(outcome: Outcome) -> Response {
    let status = StatusCode::from_u16(outcome.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = match outcome.body {
        Some(Value::Null) | None => status.into_response(),
        Some(body) => (status, Json(body)).into_response(),
    };
    for (name, value) in outcome.headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(name), HeaderValue::from_str(&value)) {
            response.headers_mut().insert(name, value);
        }
    }
    response
}

fn status(code: u16) -> Response {
    StatusCode::from_u16(code)
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
        .into_response()
}

fn with_cookie(mut response: Response, cookie: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

pub fn build<B: Backend + RawCommit>(
    pool: Pool<B>,
    label: &str,
    base: &str,
    scenario: Scenario,
    stores: Stores,
) -> Result<Router, Box<dyn std::error::Error>>
where
    String: for<'r> sqlx::Decode<'r, B> + sqlx::Type<B>,
    usize: sqlx::ColumnIndex<B::Row>,
{
    let sessions = Arc::new(Sessions::default());
    let stores = Arc::new(stores);
    let state = AppState {
        pool: pool.clone(),
        sessions: sessions.clone(),
        outbox: Outbox::default(),
        base: base.into(),
        stores: stores.clone(),
    };
    let bench = Sendproof::new(setup::config(
        scenario, base, pool, label, sessions, &stores,
    )?);

    let mut items = Router::new()
        .route("/items", post(create::<B>))
        .route(
            "/items/{id}",
            get(read::<B>).patch(rename::<B>).delete(delete::<B>),
        )
        .route(
            "/items/{id}/fail",
            post(|db: Db<B>, Path(id): Path<String>| async move {
                items::fail(&db, &id).await.map(reply)
            }),
        )
        .route(
            "/items/{id}/large",
            post(|db: Db<B>, Path(id): Path<String>| async move {
                items::large(&db, &id).await.map(reply)
            }),
        )
        .route(
            "/items/{id}/redirect",
            post(
                |State(state): State<AppState<B>>, db: Db<B>, Path(id): Path<String>| async move {
                    items::redirect(&db, &id, &state.base).await.map(reply)
                },
            ),
        )
        .route(
            "/items/{id}/capture",
            post(
                |State(state): State<AppState<B>>, db: Db<B>, Path(id): Path<String>| async move {
                    items::capture_many(&db, &state.outbox, &id)
                        .await
                        .map(reply)
                },
            ),
        )
        .route(
            "/items/{id}/ordinary",
            post(|db: Db<B>, Path(id): Path<String>| async move {
                items::ordinary(&db, &id).await.map(reply)
            }),
        )
        // The shared security rules.
        .route(
            "/accounts",
            post(|db: Db<B>, Json(body): Json<Value>| async move {
                items::create_account(&db, &body).await.map(reply)
            }),
        )
        .route(
            "/accounts/{id}",
            get(|db: Db<B>, Path(id): Path<String>| async move {
                items::read_account(&db, &id).await.map(reply)
            }),
        )
        .route(
            "/items/{id}/commit",
            post(
                |db: Db<B>, Path(id): Path<String>, Json(body): Json<Value>| async move {
                    items::commit(&db, &id, &body).await.map(reply)
                },
            ),
        )
        .route(
            "/items/{id}/escape",
            post(
                |db: Db<B>, Path(id): Path<String>, Json(body): Json<Value>| async move {
                    items::escape(&db, &id, &body).await.map(reply)
                },
            ),
        );
    items = store_routes(items, &stores);
    let items = items
        // The gate first, so authorization wraps it and runs before a preview is enrolled.
        .bench_gate(&bench)
        .route_layer(from_fn_with_state(state.clone(), authorize::<B>));

    let api = Router::new()
        .route("/ready", get(|| async { "ready" }))
        .route("/openapi.json", get(|| async { Json(openapi::document()) }))
        .route("/auth/sign-in", post(sign_in::<B>))
        .route("/auth/personas", get(personas::<B>))
        .route("/auth/personas/{email}", post(switch_persona::<B>))
        .merge(items)
        .with_state(state);

    let mounted = if base.is_empty() {
        api
    } else {
        Router::new().nest(base, api)
    };
    Ok(bench.wrap(mounted))
}

async fn authorize<B: Backend>(
    State(state): State<AppState<B>>,
    request: Request,
    next: Next,
) -> Response {
    match state
        .sessions
        .authorize(&Headers::from(request.headers()), request.method().as_str())
    {
        Ok(()) => next.run(request).await,
        Err(code) => status(code),
    }
}

#[derive(serde::Deserialize)]
struct Credentials {
    email: String,
    password: String,
}

async fn sign_in<B: Backend>(
    State(state): State<AppState<B>>,
    Json(body): Json<Credentials>,
) -> Response {
    if auth::credentials_ok(&body.email, &body.password) {
        with_cookie(
            Json(auth::ADMIN).into_response(),
            &state.sessions.start(auth::ADMIN),
        )
    } else {
        status(401)
    }
}

async fn personas<B: Backend>(State(state): State<AppState<B>>, headers: HeaderMap) -> Response {
    match state.sessions.list_personas(&Headers::from(&headers)) {
        Ok(list) => Json(list).into_response(),
        Err(code) => status(code),
    }
}

async fn switch_persona<B: Backend>(
    State(state): State<AppState<B>>,
    headers: HeaderMap,
    Path(email): Path<String>,
) -> Response {
    match state.sessions.switch(&Headers::from(&headers), &email) {
        Ok((persona, cookie)) => with_cookie(Json(persona).into_response(), &cookie),
        Err(code) => status(code),
    }
}

async fn create<B: Backend>(
    State(state): State<AppState<B>>,
    db: Db<B>,
    Json(body): Json<Value>,
) -> Result<Response, DbError> {
    items::create(&db, &state.outbox, &body).await.map(reply)
}

async fn read<B: Backend>(db: Db<B>, Path(id): Path<String>) -> Result<Response, DbError>
where
    String: for<'r> sqlx::Decode<'r, B> + sqlx::Type<B>,
    usize: sqlx::ColumnIndex<B::Row>,
{
    items::read(&db, &id).await.map(reply)
}

#[derive(serde::Deserialize)]
struct Rename {
    name: String,
}

async fn rename<B: Backend>(
    db: Db<B>,
    Path(id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    Json(body): Json<Rename>,
) -> Result<Response, DbError> {
    items::rename(&db, &id, &body.name, query.get("tag").map(String::as_str))
        .await
        .map(reply)
}

async fn delete<B: Backend>(db: Db<B>, Path(id): Path<String>) -> Result<Response, DbError> {
    items::delete(&db, &id).await.map(reply)
}

/// The data-store routes, for the stores the runner provisioned.
fn store_routes<B: Backend>(
    mut router: Router<AppState<B>>,
    stores: &Stores,
) -> Router<AppState<B>> {
    if stores.mongo.is_some() {
        router = router
            .route("/documents", post(|State(state): State<AppState<B>>, mongo: Mongo, Json(body): Json<Value>| async move {
                reply(state.stores.document_create(&mongo, &body).await)
            }))
            .route("/documents/archive", post(|State(state): State<AppState<B>>, mongo: Mongo| async move {
                reply(state.stores.document_archive(&mongo).await)
            }))
            .route(
                "/documents/{id}",
                get(|State(state): State<AppState<B>>, mongo: Mongo, Path(id): Path<String>| async move {
                    reply(state.stores.document_get(&mongo, &id).await)
                })
                .patch(|State(state): State<AppState<B>>, mongo: Mongo, Path(id): Path<String>, Json(body): Json<Value>| async move {
                    reply(state.stores.document_patch(&mongo, &id, &body).await)
                })
                .delete(|State(state): State<AppState<B>>, mongo: Mongo, Path(id): Path<String>| async move {
                    reply(state.stores.document_delete(&mongo, &id).await)
                }),
            );
    }
    if stores.redis.is_some() {
        router =
            router
                .route(
                    "/counters/{key}/take",
                    post(
                        |State(state): State<AppState<B>>,
                         redis: Redis,
                         Path(key): Path<String>| async move {
                            reply(state.stores.counter_take(&redis, &key).await)
                        },
                    ),
                )
                .route(
                    "/counters/{key}",
                    get(
                        |State(state): State<AppState<B>>,
                         redis: Redis,
                         Path(key): Path<String>| async move {
                            reply(state.stores.counter_get(&redis, &key).await)
                        },
                    )
                    .post(
                        |State(state): State<AppState<B>>,
                         redis: Redis,
                         Path(key): Path<String>| async move {
                            reply(state.stores.counter_incr(&redis, &key).await)
                        },
                    )
                    .delete(
                        |State(state): State<AppState<B>>,
                         redis: Redis,
                         Path(key): Path<String>| async move {
                            reply(state.stores.counter_delete(&redis, &key).await)
                        },
                    ),
                );
    }
    if stores.dynamo.is_some() {
        router = router
            .route(
                "/orders/{id}/touch",
                post(
                    |State(state): State<AppState<B>>, Path(id): Path<String>| async move {
                        reply(state.stores.order_touch(&id).await)
                    },
                ),
            )
            .route(
                "/orders/{id}/cancel",
                post(
                    |State(state): State<AppState<B>>, Path(id): Path<String>| async move {
                        reply(state.stores.order_cancel(&id).await)
                    },
                ),
            )
            .route(
                "/orders/{id}",
                get(
                    |State(state): State<AppState<B>>, Path(id): Path<String>| async move {
                        reply(state.stores.order_get(&id).await)
                    },
                )
                .delete(
                    |State(state): State<AppState<B>>, Path(id): Path<String>| async move {
                        reply(state.stores.order_delete(&id).await)
                    },
                ),
            );
    }
    if stores.cassandra.is_some() {
        router = router
            .route(
                "/tickets/{id}/touch",
                post(
                    |State(state): State<AppState<B>>,
                     cassandra: Cassandra,
                     Path(id): Path<String>| async move {
                        reply(state.stores.ticket_touch(&cassandra, &id).await)
                    },
                ),
            )
            .route(
                "/tickets/{id}/close",
                post(
                    |State(state): State<AppState<B>>,
                     cassandra: Cassandra,
                     Path(id): Path<String>| async move {
                        reply(state.stores.ticket_close(&cassandra, &id).await)
                    },
                ),
            )
            .route(
                "/tickets/{id}",
                get(
                    |State(state): State<AppState<B>>,
                     cassandra: Cassandra,
                     Path(id): Path<String>| async move {
                        reply(state.stores.ticket_get(&cassandra, &id).await)
                    },
                )
                .delete(
                    |State(state): State<AppState<B>>,
                     cassandra: Cassandra,
                     Path(id): Path<String>| async move {
                        reply(state.stores.ticket_delete(&cassandra, &id).await)
                    },
                ),
            );
    }
    if stores.opensearch.is_some() {
        router = router
            .route(
                "/articles/{id}/touch",
                post(
                    |State(state): State<AppState<B>>,
                     search: OpenSearch,
                     Path(id): Path<String>| async move {
                        reply(state.stores.article_touch(&search, &id).await)
                    },
                ),
            )
            .route(
                "/articles/{id}/hide",
                post(
                    |State(state): State<AppState<B>>,
                     search: OpenSearch,
                     Path(id): Path<String>| async move {
                        reply(state.stores.article_hide(&search, &id).await)
                    },
                ),
            )
            .route(
                "/articles/{id}",
                get(
                    |State(state): State<AppState<B>>,
                     search: OpenSearch,
                     Path(id): Path<String>| async move {
                        reply(state.stores.article_get(&search, &id).await)
                    },
                )
                .delete(
                    |State(state): State<AppState<B>>,
                     search: OpenSearch,
                     Path(id): Path<String>| async move {
                        reply(state.stores.article_delete(&search, &id).await)
                    },
                ),
            );
    }
    if stores.redis.is_some()
        || stores.dynamo.is_some()
        || stores.cassandra.is_some()
        || stores.opensearch.is_some()
    {
        router = router.route("/items/{id}/remember", post(remember::<B>));
    }
    router
}

#[derive(serde::Deserialize)]
struct Store {
    store: String,
}

/// `POST /items/{id}/remember?store=<store>`: inserts the item, then writes the named guarded store.
async fn remember<B: Backend>(
    State(state): State<AppState<B>>,
    db: Db<B>,
    parts: axum::http::request::Parts,
    Path(id): Path<String>,
    Query(Store { store }): Query<Store>,
    Json(body): Json<Value>,
) -> Result<Response, DbError> {
    let Some(name) = body
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
    else {
        return Ok(status(400));
    };
    if !["redis", "dynamodb", "cassandra", "opensearch"].contains(&store.as_str()) {
        return Ok(status(400));
    }
    items::insert(&db, &id, name).await?;
    let enrollment = parts.extensions.get::<Enrollment>();
    let required = parts.extensions.get::<PreviewRequired>().is_some();
    let redis = state
        .stores
        .redis
        .as_ref()
        .and_then(|redis| redis.store.from_enrollment(enrollment, required).ok());
    let cassandra = state.stores.cassandra.as_ref().and_then(|cassandra| {
        cassandra.store.from_enrollment(enrollment, required).ok()
    });
    let opensearch = state.stores.opensearch.as_ref().and_then(|opensearch| {
        opensearch.store.from_enrollment(enrollment, required).ok()
    });
    let handles = Handles {
        redis: redis.as_ref(),
        cassandra: cassandra.as_ref(),
        opensearch: opensearch.as_ref(),
    };
    match state.stores.remember(handles, &store, &id).await {
        Some(Ok(())) => Ok(reply(Outcome::new(
            201,
            serde_json::json!({ "id": id, "name": name }),
        ))),
        Some(Err(outcome)) => Ok(reply(outcome)),
        None => Ok(status(400)),
    }
}
