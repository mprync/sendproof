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
    items::{self, Outbox, Outcome},
    openapi,
    scenario::Scenario,
    setup,
};
use serde_json::Value;
use sqlx::Pool;
use sendproof_axum::{Sendproof, SendproofRouterExt};
use sendproof_core::Headers;
use sendproof_sqlx::{Backend, Db, DbError};

pub struct AppState<B: Backend> {
    pool: Pool<B>,
    sessions: Arc<Sessions>,
    outbox: Outbox,
    base: Arc<str>,
}

impl<B: Backend> Clone for AppState<B> {
    fn clone(&self) -> Self {
        Self {
            pool: self.pool.clone(),
            sessions: self.sessions.clone(),
            outbox: self.outbox.clone(),
            base: self.base.clone(),
        }
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

pub fn build<B: Backend>(
    pool: Pool<B>,
    label: &str,
    base: &str,
    scenario: Scenario,
) -> Result<Router, Box<dyn std::error::Error>>
where
    String: for<'r> sqlx::Decode<'r, B> + sqlx::Type<B>,
    usize: sqlx::ColumnIndex<B::Row>,
{
    let sessions = Arc::new(Sessions::default());
    let state = AppState {
        pool: pool.clone(),
        sessions: sessions.clone(),
        outbox: Outbox::default(),
        base: base.into(),
    };
    let bench = Sendproof::new(setup::config(scenario, base, pool, label, sessions)?);

    let items = Router::new()
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
