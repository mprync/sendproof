//! End-to-end tests of previews and observed sends through a real Actix Web app and SQLite.

use std::sync::atomic::{AtomicUsize, Ordering};

use actix_web::{
    App, HttpResponse,
    body::MessageBody,
    dev::{ServiceRequest, ServiceResponse},
    http::StatusCode,
    middleware::from_fn,
    test, web,
};
use serde_json::{Value, json};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use sendproof_actix::{Config, Identity, Sendproof, SendproofLayer};
use sendproof_sqlx::{Db, DbError, SqliteProvider};
use tracing_subscriber::layer::SubscriberExt;

static COUNTER: AtomicUsize = AtomicUsize::new(0);

async fn pool() -> SqlitePool {
    let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry().with(SendproofLayer::new()));
    let file =
        std::env::temp_dir().join(format!("sendproof-actix-test-{}-{}.db", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_file(&file);
    let options = SqliteConnectOptions::new().filename(&file).create_if_missing(true).journal_mode(SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new().max_connections(4).connect_with(options).await.unwrap();
    for statement in [
        "CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL)",
        "CREATE TABLE audit (n INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL)",
        "CREATE TRIGGER audit_items AFTER INSERT ON items BEGIN INSERT INTO audit (item) VALUES (NEW.id); END",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    pool
}

async fn create(db: Db, body: web::Json<Value>) -> Result<HttpResponse, DbError> {
    let mut conn = db.acquire().await?;
    sqlx::query("INSERT INTO items (id, name) VALUES (?1, ?2)")
        .bind(body["id"].as_str().unwrap())
        .bind(body["name"].as_str().unwrap())
        .execute(&mut conn)
        .await?;
    Ok(HttpResponse::Created().finish())
}

async fn boom(db: Db) -> Result<HttpResponse, DbError> {
    let mut conn = db.acquire().await?;
    sqlx::query("INSERT INTO items (id, name) VALUES ('boom', 'x')").execute(&mut conn).await?;
    panic!("handler failure after writing");
}

async fn ungated(db: Db) -> Result<HttpResponse, DbError> {
    let mut conn = db.acquire().await?;
    sqlx::query("INSERT INTO items (id, name) VALUES ('ungated', 'x')").execute(&mut conn).await?;
    Ok(HttpResponse::Created().finish())
}

/// A viewer header named `x-role: viewer` may not write: authorization that must run before the gate.
async fn authorize(
    request: ServiceRequest,
    next: actix_web::middleware::Next<impl MessageBody + 'static>,
) -> Result<ServiceResponse<impl MessageBody>, actix_web::Error> {
    if request.headers().get("x-role").is_some_and(|role| role == "viewer") {
        return Ok(request.into_response(HttpResponse::Forbidden().finish()).map_into_boxed_body());
    }
    next.call(request).await.map(ServiceResponse::map_into_boxed_body)
}

fn bench(pool: &SqlitePool, enabled: bool) -> Sendproof {
    let mut config = Config::builder("Tests")
        .environment(if enabled { "Development" } else { "Production" })
        .enable_in(["Development"])
        .provider(SqliteProvider::new(pool.clone()).database("test.db"))
        .identity(|headers| async move {
            headers.get("x-user").map(|user| Identity {
                name: Some(user.into()),
                subject: Some(user.into()),
                authentication_type: Some("test".into()),
                ..Identity::default()
            })
        });
    for path in ["/items", "/boom", "/ungated"] {
        config = config.preview_operation("POST", path);
    }
    Sendproof::new(config.build().unwrap())
}

macro_rules! app {
    ($pool:expr, $bench:expr) => {{
        let bench = $bench;
        test::init_service(
            App::new()
                .wrap(bench.middleware())
                .app_data(web::Data::new($pool.clone()))
                .service(web::resource("/items").wrap(bench.gate()).wrap(from_fn(authorize)).route(web::post().to(create)))
                .service(web::resource("/boom").wrap(bench.gate()).route(web::post().to(boom)))
                // Declared for preview but deliberately not gated.
                .service(web::resource("/ungated").route(web::post().to(ungated))),
        )
        .await
    }};
}

fn preview(path: &str, body: Value) -> test::TestRequest {
    test::TestRequest::post().uri(&format!("/sendproof/_preview{path}")).insert_header(("prefer", "tx=rollback")).set_json(body)
}

async fn count(pool: &SqlitePool, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}"))).fetch_one(pool).await.unwrap()
}

#[actix_web::test]
async fn preview_rolls_back_and_reports_rows_including_trigger_changes() {
    let pool = pool().await;
    let app = app!(pool, bench(&pool, true));
    let response = test::call_service(&app, preview("/items", json!({"id": "a", "name": "Bolt"})).to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers().get("preference-applied").unwrap(), "tx=rollback");
    let envelope: Value = test::read_body_json(response).await;
    assert_eq!(envelope["status"], 201);
    assert_eq!(envelope["rolledBack"], true);
    let changes = envelope["changes"].as_array().unwrap();
    let tables: Vec<_> = changes.iter().map(|c| c["table"].as_str().unwrap()).collect();
    assert!(tables.contains(&"items") && tables.contains(&"audit"), "trigger writes are captured: {tables:?}");
    let item = changes.iter().find(|c| c["table"] == "items").unwrap();
    assert_eq!(item["key"], json!({"id": "a"}));
    assert_eq!(item["after"], json!({"id": "a", "name": "Bolt"}));
    let sql: Vec<_> = envelope["logs"].as_array().unwrap().iter().filter(|l| l["level"] == "Sql").collect();
    assert_eq!(sql.len(), 1, "{sql:?}");
    assert_eq!(count(&pool, "items").await, 0);
    assert_eq!(count(&pool, "audit").await, 0);
}

#[actix_web::test]
async fn authorization_wraps_the_gate_so_a_denied_preview_is_never_enrolled() {
    let pool = pool().await;
    let app = app!(pool, bench(&pool, true));
    let denied = preview("/items", json!({"id": "a", "name": "n"})).insert_header(("x-role", "viewer")).to_request();
    let response = test::call_service(&app, denied).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(response.headers().get("preference-applied").is_none());
    assert_eq!(count(&pool, "items").await, 0);
}

#[actix_web::test]
async fn a_panicking_handler_is_unconfirmed_and_rolled_back() {
    let pool = pool().await;
    let app = app!(pool, bench(&pool, true));
    // No request survives a panic, so the service answers with an error that Actix renders as the reply.
    let error = test::try_call_service(&app, preview("/boom", json!({})).to_request()).await.expect_err("an unconfirmed result");
    let response = error.error_response();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(response.headers().get("preference-applied").is_none());
    assert_eq!(count(&pool, "items").await, 0);
    let again = test::call_service(&app, preview("/items", json!({"id": "a", "name": "n"})).to_request()).await;
    assert_eq!(again.status(), StatusCode::OK, "the connection returned to the pool");
}

#[actix_web::test]
async fn a_declared_route_without_the_gate_never_commits() {
    let pool = pool().await;
    let app = app!(pool, bench(&pool, true));
    let response = test::call_service(&app, preview("/ungated", json!({})).to_request()).await;
    assert_ne!(response.status(), StatusCode::OK);
    assert!(response.headers().get("preference-applied").is_none());
    assert_eq!(count(&pool, "items").await, 0, "the data layer refuses an unenrolled preview");
}

#[actix_web::test]
async fn undeclared_targets_and_bad_transport_do_not_execute() {
    let pool = pool().await;
    let app = app!(pool, bench(&pool, true));
    let unknown = test::call_service(&app, preview("/missing", json!({})).to_request()).await;
    assert_eq!(unknown.status(), StatusCode::CONFLICT);
    let no_preference = test::TestRequest::post().uri("/sendproof/_preview/items").to_request();
    assert_eq!(test::call_service(&app, no_preference).await.status(), StatusCode::BAD_REQUEST);
    let traversal = test::call_service(&app, preview("/%2e%2e/items", json!({})).to_request()).await;
    assert_eq!(traversal.status(), StatusCode::BAD_REQUEST);
    let normal_url = test::TestRequest::post().uri("/items").insert_header(("prefer", "tx=rollback")).to_request();
    assert_eq!(test::call_service(&app, normal_url).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(count(&pool, "items").await, 0);
}

#[actix_web::test]
async fn off_by_default_outside_enabled_environments() {
    let pool = pool().await;
    let app = app!(pool, bench(&pool, false));
    let response = test::call_service(&app, preview("/items", json!({"id": "a", "name": "n"})).to_request()).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let workbench = test::TestRequest::get().uri("/sendproof/_api/capabilities").to_request();
    assert_eq!(test::call_service(&app, workbench).await.status(), StatusCode::NOT_FOUND);
    let send = test::TestRequest::post()
        .uri("/items")
        .insert_header(("prefer", "trace"))
        .insert_header(("x-user", "u"))
        .set_json(json!({"id": "a", "name": "n"}))
        .to_request();
    let response = test::call_service(&app, send).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert!(response.headers().get("x-sendproof-trace").is_none());
}

#[actix_web::test]
async fn observed_send_commits_and_serves_an_owner_only_trace() {
    let pool = pool().await;
    let app = app!(pool, bench(&pool, true));
    let send = test::TestRequest::post()
        .uri("/items")
        .insert_header(("prefer", "trace"))
        .insert_header(("x-user", "alex"))
        .set_json(json!({"id": "a", "name": "Bolt"}));
    let response = test::call_service(&app, send.to_request()).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let id = response.headers().get("x-sendproof-trace").unwrap().to_str().unwrap().to_owned();
    assert_eq!(count(&pool, "items").await, 1, "an observed send commits");

    let read = |user: Option<&str>| {
        let mut request = test::TestRequest::get().uri(&format!("/sendproof/_api/traces/{id}"));
        if let Some(user) = user {
            request = request.insert_header(("x-user", user));
        }
        request.to_request()
    };
    let own = test::call_service(&app, read(Some("alex"))).await;
    assert_eq!(own.status(), StatusCode::OK);
    assert!(own.headers().get("cache-control").unwrap().to_str().unwrap().contains("no-store"));
    let trace: Value = test::read_body_json(own).await;
    assert!(trace["changes"].as_array().unwrap().iter().any(|c| c["table"] == "items" && c["operation"] == "insert"));
    assert_eq!(test::call_service(&app, read(Some("sam"))).await.status(), StatusCode::NOT_FOUND);
    assert_eq!(test::call_service(&app, read(None)).await.status(), StatusCode::NOT_FOUND);
}

/// An ordinary request is attributed: its store writes never fail a Preview open at the same time.
#[actix_web::test]
async fn an_ordinary_request_is_attributed_for_the_store_hooks() {
    let pool = pool().await;
    let bench = bench(&pool, true);
    let app = test::init_service(
        App::new()
            .wrap(bench.middleware())
            .service(web::resource("/attributed").route(web::get().to(|| async { HttpResponse::Ok().body(sendproof_core::stores::is_attributed().to_string()) }))),
    )
    .await;
    let response = test::call_service(&app, test::TestRequest::get().uri("/attributed").to_request()).await;
    assert_eq!(test::read_body(response).await, "true");
}
