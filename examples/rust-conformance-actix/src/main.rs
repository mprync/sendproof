//! The Actix Web conformance fixture, described in `spec/conformance/fixture.md`.
//! Configure it with `PORT`, `BENCH_PATH_BASE`, `BENCH_SCENARIO`, `BENCH_DATABASE` (`sqlite`, the
//! default, `postgresql` or `mysql`) and, for a server database, `BENCH_DATABASE_URL`. Behavior lives in
//! `rust-conformance-common`; this file is routing and request plumbing.

use std::sync::Arc;

use actix_web::{
    App, HttpRequest, HttpResponse, HttpServer, Responder,
    body::MessageBody,
    dev::{ServiceRequest, ServiceResponse},
    http::StatusCode,
    middleware::{Next, from_fn},
    web::{self, Data, Json, Path, Query},
};
use rust_conformance_common::{
    auth::{self, Sessions},
    items::{self, Outbox, Outcome},
    openapi,
    scenario::Scenario,
    setup::{self, Database},
};
use serde_json::Value;
use sqlx::Pool;
use testbench_actix::TestBench;
use testbench_core::Headers;
use testbench_sqlx::{Backend, Db, DbError};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

struct Fixture {
    sessions: Arc<Sessions>,
    outbox: Outbox,
    base: String,
}

fn status(code: u16) -> HttpResponse {
    HttpResponse::new(StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
}

fn reply(outcome: Outcome) -> HttpResponse {
    let code = StatusCode::from_u16(outcome.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = HttpResponse::build(code);
    for (name, value) in outcome.headers {
        response.append_header((name, value));
    }
    match outcome.body {
        Some(Value::Null) | None => response.finish(),
        Some(body) => response.json(body),
    }
}

fn with_cookie(mut response: HttpResponse, cookie: String) -> HttpResponse {
    if let Ok(value) = actix_web::http::header::HeaderValue::from_str(&cookie) {
        response
            .headers_mut()
            .insert(actix_web::http::header::SET_COOKIE, value);
    }
    response
}

fn headers(request: &HttpRequest) -> Headers {
    request
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_owned(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect()
}

/// Anonymous callers get 401. A viewer may read; any other method needs the admin.
async fn authorize(
    request: ServiceRequest,
    next: Next<impl MessageBody + 'static>,
) -> Result<ServiceResponse<impl MessageBody>, actix_web::Error> {
    let sessions = request
        .app_data::<Data<Fixture>>()
        .map(|fixture| fixture.sessions.clone());
    let allowed = match sessions {
        Some(sessions) => {
            let headers: Headers = request
                .headers()
                .iter()
                .map(|(n, v)| {
                    (
                        n.as_str().to_owned(),
                        String::from_utf8_lossy(v.as_bytes()).into_owned(),
                    )
                })
                .collect();
            sessions.authorize(&headers, request.method().as_str())
        }
        None => Err(500),
    };
    match allowed {
        Ok(()) => next
            .call(request)
            .await
            .map(ServiceResponse::map_into_boxed_body),
        Err(code) => Ok(request.into_response(status(code)).map_into_boxed_body()),
    }
}

async fn sign_in(
    fixture: Data<Fixture>,
    body: Json<serde_json::Map<String, Value>>,
) -> HttpResponse {
    let field = |name: &str| {
        body.get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    if auth::credentials_ok(&field("email"), &field("password")) {
        with_cookie(
            HttpResponse::Ok().json(auth::ADMIN),
            fixture.sessions.start(auth::ADMIN),
        )
    } else {
        status(401)
    }
}

async fn personas(fixture: Data<Fixture>, request: HttpRequest) -> HttpResponse {
    match fixture.sessions.list_personas(&headers(&request)) {
        Ok(list) => HttpResponse::Ok().json(list),
        Err(code) => status(code),
    }
}

async fn switch_persona(
    fixture: Data<Fixture>,
    request: HttpRequest,
    email: Path<String>,
) -> HttpResponse {
    match fixture.sessions.switch(&headers(&request), &email) {
        Ok((persona, cookie)) => with_cookie(HttpResponse::Ok().json(persona), cookie),
        Err(code) => status(code),
    }
}

async fn create<B: Backend>(
    fixture: Data<Fixture>,
    db: Db<B>,
    body: Json<Value>,
) -> Result<HttpResponse, DbError> {
    items::create(&db, &fixture.outbox, &body).await.map(reply)
}

async fn read<B: Backend>(db: Db<B>, id: Path<String>) -> Result<HttpResponse, DbError>
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
    id: Path<String>,
    query: Query<std::collections::HashMap<String, String>>,
    body: Json<Rename>,
) -> Result<HttpResponse, DbError> {
    items::rename(&db, &id, &body.name, query.get("tag").map(String::as_str))
        .await
        .map(reply)
}

async fn delete<B: Backend>(db: Db<B>, id: Path<String>) -> Result<HttpResponse, DbError> {
    items::delete(&db, &id).await.map(reply)
}

async fn fail<B: Backend>(db: Db<B>, id: Path<String>) -> Result<HttpResponse, DbError> {
    items::fail(&db, &id).await.map(reply)
}

async fn large<B: Backend>(db: Db<B>, id: Path<String>) -> Result<HttpResponse, DbError> {
    items::large(&db, &id).await.map(reply)
}

async fn redirect<B: Backend>(
    fixture: Data<Fixture>,
    db: Db<B>,
    id: Path<String>,
) -> Result<HttpResponse, DbError> {
    items::redirect(&db, &id, &fixture.base).await.map(reply)
}

async fn capture_many<B: Backend>(
    fixture: Data<Fixture>,
    db: Db<B>,
    id: Path<String>,
) -> Result<HttpResponse, DbError> {
    items::capture_many(&db, &fixture.outbox, &id)
        .await
        .map(reply)
}

async fn ordinary<B: Backend>(db: Db<B>, id: Path<String>) -> Result<HttpResponse, DbError> {
    items::ordinary(&db, &id).await.map(reply)
}

async fn ready() -> impl Responder {
    "ready"
}

async fn openapi_document() -> HttpResponse {
    HttpResponse::Ok().json(openapi::document())
}

#[actix_web::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(5375);
    let base = std::env::var("BENCH_PATH_BASE").unwrap_or_default();
    let scenario =
        Scenario::parse(&std::env::var("BENCH_SCENARIO").unwrap_or_else(|_| "standard".into()))?;

    // Copy the events of preview and observed requests into their capture.
    tracing_subscriber::registry()
        .with(testbench_core::TestBenchLayer::new())
        .init();

    let database = Database::open().await?;
    let label = database.label();
    match &database {
        Database::Sqlite { pool, .. } => serve(pool.clone(), label, port, base, scenario).await?,
        Database::Postgres(pool) => serve(pool.clone(), label, port, base, scenario).await?,
        Database::MySql(pool) => serve(pool.clone(), label, port, base, scenario).await?,
    }
    database.close().await;
    Ok(())
}

/// Serves the fixture over `pool` until the server stops.
async fn serve<B: Backend>(
    pool: Pool<B>,
    label: &str,
    port: u16,
    base: String,
    scenario: Scenario,
) -> Result<(), Box<dyn std::error::Error>>
where
    String: for<'r> sqlx::Decode<'r, B> + sqlx::Type<B>,
    usize: sqlx::ColumnIndex<B::Row>,
{
    let sessions = Arc::new(Sessions::default());
    let bench = TestBench::new(setup::config(
        scenario,
        &base,
        pool.clone(),
        label,
        sessions.clone(),
    )?);
    let fixture = Data::new(Fixture {
        sessions,
        outbox: Outbox::default(),
        base: base.clone(),
    });

    eprintln!(
        "rust-conformance (actix, {label}) listening on http://127.0.0.1:{port}{base} ({scenario:?})"
    );
    HttpServer::new({
        let (bench, pool, fixture, base) =
            (bench.clone(), pool.clone(), fixture.clone(), base.clone());
        move || {
            // Each item resource is gated, then wrapped by authorization (the last `wrap` runs first),
            // so a preview is only enrolled once the request is authorized.
            let item = |path: &str| {
                web::resource(path.to_owned())
                    .wrap(bench.gate())
                    .wrap(from_fn(authorize))
            };
            let mount = web::scope(&base)
                .service(web::resource("/ready").route(web::get().to(ready)))
                .service(web::resource("/openapi.json").route(web::get().to(openapi_document)))
                .service(web::resource("/auth/sign-in").route(web::post().to(sign_in)))
                .service(web::resource("/auth/personas").route(web::get().to(personas)))
                .service(
                    web::resource("/auth/personas/{email}").route(web::post().to(switch_persona)),
                )
                .service(item("/items").route(web::post().to(create::<B>)))
                .service(
                    item("/items/{id}")
                        .route(web::get().to(read::<B>))
                        .route(web::patch().to(rename::<B>))
                        .route(web::delete().to(delete::<B>)),
                )
                .service(item("/items/{id}/fail").route(web::post().to(fail::<B>)))
                .service(item("/items/{id}/large").route(web::post().to(large::<B>)))
                .service(item("/items/{id}/redirect").route(web::post().to(redirect::<B>)))
                .service(item("/items/{id}/capture").route(web::post().to(capture_many::<B>)))
                .service(item("/items/{id}/ordinary").route(web::post().to(ordinary::<B>)));
            App::new()
                .wrap(bench.middleware())
                .app_data(fixture.clone())
                .app_data(Data::new(pool.clone()))
                .service(mount)
        }
    })
    .workers(2)
    .bind(("127.0.0.1", port))?
    .run()
    .await?;
    Ok(())
}
