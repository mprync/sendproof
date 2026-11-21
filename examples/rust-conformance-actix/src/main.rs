//! The Actix Web conformance fixture, described in `spec/conformance/fixture.md`.
//! Configure it with `PORT`, `BENCH_PATH_BASE`, `BENCH_SCENARIO`, `BENCH_DATABASE` (`sqlite`, the
//! default, `postgresql` or `mysql`) and, for a server database, `BENCH_DATABASE_URL`. Behavior lives in
//! `rust-conformance-common`; this file is routing and request plumbing.

use std::sync::Arc;

use actix_web::{
    App, HttpMessage, HttpRequest, HttpResponse, HttpServer, Responder,
    body::MessageBody,
    dev::{ServiceRequest, ServiceResponse},
    http::StatusCode,
    middleware::{Next, from_fn},
    web::{self, Data, Json, Path, Query},
};
use rust_conformance_common::{
    auth::{self, Sessions},
    items::{self, Outbox, Outcome, RawCommit},
    openapi,
    scenario::Scenario,
    setup::{self, Database},
    stores::Stores,
};
use serde_json::Value;
use sqlx::Pool;
use sendproof_actix::Sendproof;
use sendproof_core::{Enrollment, Headers, PreviewRequired};
use sendproof_mongodb::Mongo;
use sendproof_redis::Redis;
use sendproof_sqlx::{Backend, Db, DbError};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

struct Fixture {
    sessions: Arc<Sessions>,
    outbox: Outbox,
    base: String,
    stores: Arc<Stores>,
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

async fn create_account<B: Backend>(db: Db<B>, body: Json<Value>) -> Result<HttpResponse, DbError> {
    items::create_account(&db, &body).await.map(reply)
}

async fn read_account<B: Backend>(db: Db<B>, id: Path<String>) -> Result<HttpResponse, DbError>
where
    String: for<'r> sqlx::Decode<'r, B> + sqlx::Type<B>,
    usize: sqlx::ColumnIndex<B::Row>,
{
    items::read_account(&db, &id).await.map(reply)
}

async fn commit<B: RawCommit>(db: Db<B>, id: Path<String>, body: Json<Value>) -> Result<HttpResponse, DbError> {
    items::commit(&db, &id, &body).await.map(reply)
}

// ---- data stores: present only when the runner provisioned them ----

async fn document_get(fixture: Data<Fixture>, mongo: Mongo, id: Path<String>) -> HttpResponse {
    reply(fixture.stores.document_get(&mongo, &id).await)
}

async fn document_create(fixture: Data<Fixture>, mongo: Mongo, body: Json<Value>) -> HttpResponse {
    reply(fixture.stores.document_create(&mongo, &body).await)
}

async fn document_patch(fixture: Data<Fixture>, mongo: Mongo, id: Path<String>, body: Json<Value>) -> HttpResponse {
    reply(fixture.stores.document_patch(&mongo, &id, &body).await)
}

async fn document_archive(fixture: Data<Fixture>, mongo: Mongo) -> HttpResponse {
    reply(fixture.stores.document_archive(&mongo).await)
}

async fn document_delete(fixture: Data<Fixture>, mongo: Mongo, id: Path<String>) -> HttpResponse {
    reply(fixture.stores.document_delete(&mongo, &id).await)
}

async fn counter_get(fixture: Data<Fixture>, redis: Redis, key: Path<String>) -> HttpResponse {
    reply(fixture.stores.counter_get(&redis, &key).await)
}

async fn counter_incr(fixture: Data<Fixture>, redis: Redis, key: Path<String>) -> HttpResponse {
    reply(fixture.stores.counter_incr(&redis, &key).await)
}

async fn counter_take(fixture: Data<Fixture>, redis: Redis, key: Path<String>) -> HttpResponse {
    reply(fixture.stores.counter_take(&redis, &key).await)
}

async fn counter_delete(fixture: Data<Fixture>, redis: Redis, key: Path<String>) -> HttpResponse {
    reply(fixture.stores.counter_delete(&redis, &key).await)
}

async fn order_get(fixture: Data<Fixture>, id: Path<String>) -> HttpResponse {
    reply(fixture.stores.order_get(&id).await)
}

async fn order_touch(fixture: Data<Fixture>, id: Path<String>) -> HttpResponse {
    reply(fixture.stores.order_touch(&id).await)
}

async fn order_cancel(fixture: Data<Fixture>, id: Path<String>) -> HttpResponse {
    reply(fixture.stores.order_cancel(&id).await)
}

async fn order_delete(fixture: Data<Fixture>, id: Path<String>) -> HttpResponse {
    reply(fixture.stores.order_delete(&id).await)
}

/// `POST /items/{id}/remember?store=<store>`: inserts the item, then writes the named guarded store.
async fn remember<B: Backend>(
    fixture: Data<Fixture>,
    db: Db<B>,
    request: HttpRequest,
    id: Path<String>,
    query: Query<std::collections::HashMap<String, String>>,
    body: Json<Value>,
) -> Result<HttpResponse, DbError> {
    let Some(name) = body.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()) else {
        return Ok(status(400));
    };
    let store = query.get("store").map(String::as_str).unwrap_or_default();
    if store != "redis" && store != "dynamodb" {
        return Ok(status(400));
    }
    items::insert(&db, &id, name).await?;
    let redis = fixture.stores.redis.as_ref().and_then(|redis| {
        let extensions = request.extensions();
        redis.store.from_enrollment(extensions.get::<Enrollment>(), extensions.get::<PreviewRequired>().is_some()).ok()
    });
    Ok(match fixture.stores.remember(redis.as_ref(), store, &id).await {
        Some(Ok(())) => reply(Outcome::new(201, serde_json::json!({ "id": id.as_str(), "name": name }))),
        Some(Err(outcome)) => reply(outcome),
        None => status(400),
    })
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
        .with(sendproof_core::SendproofLayer::new())
        .init();

    let database = Database::open().await?;
    let label = database.label();
    // MongoDB, Redis and DynamoDB are hooked only when the runner provisions them.
    let stores = Stores::from_env().await?;
    match &database {
        Database::Sqlite { pool, .. } => serve(pool.clone(), label, port, base, scenario, stores).await?,
        Database::Postgres(pool) => serve(pool.clone(), label, port, base, scenario, stores).await?,
        Database::MySql(pool) => serve(pool.clone(), label, port, base, scenario, stores).await?,
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
    stores: Stores,
) -> Result<(), Box<dyn std::error::Error>>
where
    B: RawCommit,
    String: for<'r> sqlx::Decode<'r, B> + sqlx::Type<B>,
    usize: sqlx::ColumnIndex<B::Row>,
{
    let sessions = Arc::new(Sessions::default());
    let stores = Arc::new(stores);
    let bench = Sendproof::new(setup::config(
        scenario,
        &base,
        pool.clone(),
        label,
        sessions.clone(),
        &stores,
    )?);
    let fixture = Data::new(Fixture {
        sessions,
        outbox: Outbox::default(),
        base: base.clone(),
        stores: stores.clone(),
    });

    eprintln!(
        "rust-conformance (actix, {label}) listening on http://127.0.0.1:{port}{base} ({scenario:?})"
    );
    HttpServer::new({
        let (bench, pool, fixture, base, stores) =
            (bench.clone(), pool.clone(), fixture.clone(), base.clone(), stores.clone());
        move || {
            // Each item resource is gated, then wrapped by authorization (the last `wrap` runs first),
            // so a preview is only enrolled once the request is authorized.
            let stores = stores.clone();
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
                .service(item("/items/{id}/ordinary").route(web::post().to(ordinary::<B>)))
                // The shared security rules.
                .service(item("/accounts").route(web::post().to(create_account::<B>)))
                .service(item("/accounts/{id}").route(web::get().to(read_account::<B>)))
                .service(item("/items/{id}/commit").route(web::post().to(commit::<B>)));
            let mut mount = mount;
            if stores.mongo.is_some() {
                mount = mount
                    .service(item("/documents").route(web::post().to(document_create)))
                    .service(item("/documents/archive").route(web::post().to(document_archive)))
                    .service(
                        item("/documents/{id}")
                            .route(web::get().to(document_get))
                            .route(web::patch().to(document_patch))
                            .route(web::delete().to(document_delete)),
                    );
            }
            if stores.redis.is_some() {
                mount = mount
                    .service(item("/counters/{key}/take").route(web::post().to(counter_take)))
                    .service(
                        item("/counters/{key}")
                            .route(web::get().to(counter_get))
                            .route(web::post().to(counter_incr))
                            .route(web::delete().to(counter_delete)),
                    );
            }
            if stores.dynamo.is_some() {
                mount = mount
                    .service(item("/orders/{id}/touch").route(web::post().to(order_touch)))
                    .service(item("/orders/{id}/cancel").route(web::post().to(order_cancel)))
                    .service(item("/orders/{id}").route(web::get().to(order_get)).route(web::delete().to(order_delete)));
            }
            if stores.redis.is_some() || stores.dynamo.is_some() {
                mount = mount.service(item("/items/{id}/remember").route(web::post().to(remember::<B>)));
            }
            let mut app = App::new()
                .wrap(bench.middleware())
                .app_data(fixture.clone())
                .app_data(Data::new(pool.clone()))
                .service(mount);
            // The extractors find their store in `app_data`.
            if let Some(mongo) = &stores.mongo {
                app = app.app_data(Data::new(mongo.clone()));
            }
            if let Some(redis) = &stores.redis {
                app = app.app_data(Data::new(redis.store.clone()));
            }
            app
        }
    })
    .workers(2)
    .bind(("127.0.0.1", port))?
    .run()
    .await?;
    Ok(())
}
