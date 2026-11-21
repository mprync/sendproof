//! End-to-end tests of previews and observed sends through a real Axum router and SQLite.

use std::sync::atomic::{AtomicUsize, Ordering};

use axum::{
    Json, Router,
    body::Body,
    extract::FromRef,
    http::{Request, StatusCode},
    routing::post,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use testbench_axum::{Config, Identity, TestBench, TestBenchRouterExt};
use testbench_core::TestBenchLayer;
use testbench_sqlx::{Db, DbError, SqliteProvider};
use tower::ServiceExt;
use tracing_subscriber::layer::SubscriberExt;

#[derive(Clone)]
struct State {
    pool: SqlitePool,
}

impl FromRef<State> for SqlitePool {
    fn from_ref(state: &State) -> Self {
        state.pool.clone()
    }
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

async fn pool() -> SqlitePool {
    let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry().with(TestBenchLayer::new()));
    let file =
        std::env::temp_dir().join(format!("testbench-sqlx-test-{}-{}.db", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
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

async fn create(db: Db, Json(body): Json<Value>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    // Plain SQLx: the tracing layer records the SQL, the pre-update hook records the rows.
    sqlx::query("INSERT INTO items (id, name) VALUES (?1, ?2)")
        .bind(body["id"].as_str().unwrap())
        .bind(body["name"].as_str().unwrap())
        .execute(&mut *conn)
        .await?;
    Ok(StatusCode::CREATED)
}

async fn bulk(db: Db) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    sqlx::query(
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5) INSERT INTO items SELECT 'b' || x, 'bulk' FROM c",
    )
    .execute(&mut *conn)
    .await?;
    Ok(StatusCode::OK)
}

async fn boom(db: Db) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    sqlx::query("INSERT INTO items (id, name) VALUES ('boom', 'x')").execute(&mut *conn).await?;
    panic!("handler failure after writing");
}

/// Reads before it writes, the shape that fails at once with `database is locked` when a deferred transaction upgrades.
async fn bump(db: Db, Json(body): Json<Value>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    let seen: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items").fetch_one(&mut *conn).await?;
    sqlx::query("INSERT INTO items (id, name) VALUES (?1, ?2)")
        .bind(body["id"].as_str().unwrap())
        .bind(format!("seen {seen}"))
        .execute(&mut *conn)
        .await?;
    Ok(StatusCode::CREATED)
}

async fn ungated(db: Db) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    sqlx::query("INSERT INTO items (id, name) VALUES ('ungated', 'x')").execute(&mut *conn).await?;
    Ok(StatusCode::CREATED)
}

fn app(pool: SqlitePool, enabled: bool) -> Router {
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
    for path in ["/items", "/bulk", "/boom", "/bump", "/ungated"] {
        config = config.preview_operation("POST", path);
    }
    let bench = TestBench::new(config.build().unwrap());
    let api = Router::new()
        .route("/items", post(create))
        .route("/bulk", post(bulk))
        .route("/boom", post(boom))
        .route("/bump", post(bump))
        .bench_gate(&bench)
        // Declared for preview but deliberately not gated.
        .route("/ungated", post(ungated))
        .with_state(State { pool });
    bench.wrap(api)
}

fn preview(path: &str, body: Value) -> Request<Body> {
    Request::post(format!("/bench/_preview{path}"))
        .header("prefer", "tx=rollback")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn json_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap_or(Value::Null)
}

async fn count(pool: &SqlitePool, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}"))).fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn preview_rolls_back_and_reports_rows_including_trigger_changes() {
    let pool = pool().await;
    let response = app(pool.clone(), true).oneshot(preview("/items", json!({"id": "a", "name": "Bolt"}))).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let envelope = json_body(response).await;
    assert_eq!(envelope["status"], 201);
    assert_eq!(envelope["rolledBack"], true);
    let changes = envelope["changes"].as_array().unwrap();
    let tables: Vec<_> = changes.iter().map(|c| c["table"].as_str().unwrap()).collect();
    assert!(tables.contains(&"items") && tables.contains(&"audit"), "trigger writes are captured: {tables:?}");
    let item = changes.iter().find(|c| c["table"] == "items").unwrap();
    assert_eq!(item["key"], json!({"id": "a"}));
    assert_eq!(item["after"], json!({"id": "a", "name": "Bolt"}));
    assert!(item["before"].is_null());
    let sql: Vec<_> = envelope["logs"].as_array().unwrap().iter().filter(|l| l["level"] == "Sql").collect();
    assert_eq!(sql.len(), 1, "plain SQLx statements are logged once: {sql:?}");
    assert_eq!(sql[0]["sql"]["rowsAffected"], 1);
    assert!(sql[0]["sql"]["text"].as_str().unwrap().starts_with("INSERT INTO items"));
    assert_eq!(count(&pool, "items").await, 0);
    assert_eq!(count(&pool, "audit").await, 0);
}

#[tokio::test]
async fn bulk_statements_are_captured_row_by_row() {
    let pool = pool().await;
    let response = app(pool.clone(), true).oneshot(preview("/bulk", json!({}))).await.unwrap();
    let envelope = json_body(response).await;
    let items = envelope["changes"].as_array().unwrap().iter().filter(|c| c["table"] == "items").count();
    assert_eq!(items, 5);
    assert_eq!(count(&pool, "items").await, 0);
}

#[tokio::test]
async fn a_panicking_handler_is_unconfirmed_and_rolled_back() {
    let pool = pool().await;
    let response = app(pool.clone(), true).oneshot(preview("/boom", json!({}))).await.unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(response.headers().get("preference-applied").is_none());
    assert_eq!(count(&pool, "items").await, 0);
    // The connection returned to the pool: the next preview still works.
    let again = app(pool.clone(), true).oneshot(preview("/items", json!({"id": "a", "name": "n"}))).await.unwrap();
    assert_eq!(again.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_declared_route_without_the_gate_never_commits() {
    let pool = pool().await;
    let response = app(pool.clone(), true).oneshot(preview("/ungated", json!({}))).await.unwrap();
    assert_ne!(response.status(), StatusCode::OK);
    assert!(response.headers().get("preference-applied").is_none());
    assert_eq!(count(&pool, "items").await, 0, "the data layer refuses an unenrolled preview");
}

#[tokio::test]
async fn undeclared_targets_and_bad_transport_do_not_execute() {
    let pool = pool().await;
    let app = app(pool.clone(), true);
    let unknown = app.clone().oneshot(preview("/missing", json!({}))).await.unwrap();
    assert_eq!(unknown.status(), StatusCode::CONFLICT);
    let no_preference = Request::post("/bench/_preview/items").body(Body::empty()).unwrap();
    assert_eq!(app.clone().oneshot(no_preference).await.unwrap().status(), StatusCode::BAD_REQUEST);
    let traversal = app.clone().oneshot(preview("/%2e%2e/items", json!({}))).await.unwrap();
    assert_eq!(traversal.status(), StatusCode::BAD_REQUEST);
    let rollback_on_normal_url = Request::post("/items").header("prefer", "tx=rollback").body(Body::empty()).unwrap();
    assert_eq!(app.oneshot(rollback_on_normal_url).await.unwrap().status(), StatusCode::BAD_REQUEST);
    assert_eq!(count(&pool, "items").await, 0);
}

#[tokio::test]
async fn off_by_default_outside_enabled_environments() {
    let pool = pool().await;
    let app = app(pool.clone(), false);
    assert_eq!(app.clone().oneshot(preview("/items", json!({"id": "a", "name": "n"}))).await.unwrap().status(), StatusCode::NOT_FOUND);
    let workbench = Request::get("/bench/_api/capabilities").body(Body::empty()).unwrap();
    assert_eq!(app.clone().oneshot(workbench).await.unwrap().status(), StatusCode::NOT_FOUND);
    let send = Request::post("/items")
        .header("content-type", "application/json")
        .header("prefer", "trace")
        .header("x-user", "u")
        .body(Body::from(json!({"id": "a", "name": "n"}).to_string()))
        .unwrap();
    let response = app.oneshot(send).await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert!(response.headers().get("x-testbench-trace").is_none());
}

#[tokio::test]
async fn observed_send_commits_and_serves_an_owner_only_trace() {
    let pool = pool().await;
    let app = app(pool.clone(), true);
    let send = |user: &str| {
        Request::post("/items")
            .header("content-type", "application/json")
            .header("prefer", "trace")
            .header("x-user", user)
            .body(Body::from(json!({"id": "a", "name": "Bolt"}).to_string()))
            .unwrap()
    };
    let response = app.clone().oneshot(send("alex")).await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let id = response.headers().get("x-testbench-trace").expect("a trace id").to_str().unwrap().to_owned();
    assert_eq!(count(&pool, "items").await, 1, "an observed send commits");

    let read = |user: Option<&str>| {
        let mut request = Request::get(format!("/bench/_api/traces/{id}"));
        if let Some(user) = user {
            request = request.header("x-user", user);
        }
        request.body(Body::empty()).unwrap()
    };
    let own = app.clone().oneshot(read(Some("alex"))).await.unwrap();
    assert_eq!(own.status(), StatusCode::OK);
    assert!(own.headers()["cache-control"].to_str().unwrap().contains("no-store"));
    let trace = json_body(own).await;
    assert!(trace["changes"].as_array().unwrap().iter().any(|c| c["table"] == "items" && c["operation"] == "insert"));
    assert!(trace["timing"]["queryCount"].is_number());
    assert_eq!(app.clone().oneshot(read(Some("sam"))).await.unwrap().status(), StatusCode::NOT_FOUND);
    assert_eq!(app.clone().oneshot(read(None)).await.unwrap().status(), StatusCode::NOT_FOUND);

    // An anonymous send is not observed.
    let anonymous = Request::post("/items")
        .header("content-type", "application/json")
        .header("prefer", "trace")
        .body(Body::from(json!({"id": "b", "name": "n"}).to_string()))
        .unwrap();
    assert!(app.oneshot(anonymous).await.unwrap().headers().get("x-testbench-trace").is_none());
}

#[tokio::test]
async fn named_parameters_are_captured_once_and_secrets_are_redacted() {
    let pool = pool().await;
    let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry());
    async fn named(db: Db) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        conn.query("INSERT INTO items (id, name) VALUES (:id, :name)").bind("id", "n1").bind("name", "Named").execute().await?;
        conn.query("SELECT :api_key AS echoed").bind("api_key", "hunter2").fetch_optional().await?;
        Ok(StatusCode::OK)
    }
    let bench = TestBench::new(
        Config::builder("Tests")
            .environment("Development")
            .enable_in(["Development"])
            .include_sql_parameter_values(true)
            .provider(SqliteProvider::new(pool.clone()))
            .preview_operation("POST", "/named")
            .build()
            .unwrap(),
    );
    let app = bench.wrap(Router::new().route("/named", post(named)).bench_gate(&bench).with_state(State { pool: pool.clone() }));
    let envelope = json_body(app.oneshot(preview("/named", json!({}))).await.unwrap()).await;
    let sql: Vec<_> = envelope["logs"].as_array().unwrap().iter().filter(|l| l["level"] == "Sql").collect();
    assert_eq!(sql.len(), 2, "{sql:?}");
    assert_eq!(
        sql[0]["sql"]["parameters"],
        json!([
            {"name": "id", "value": "n1", "dbType": "String"},
            {"name": "name", "value": "Named", "dbType": "String"}
        ])
    );
    assert_eq!(sql[1]["sql"]["parameters"][0]["value"], "[REDACTED]");
    assert!(!envelope.to_string().contains("hunter2"));
    assert_eq!(count(&pool, "items").await, 0);
}

/// One-route app over `pool` whose `/op` route is declared and gated.
fn single(pool: SqlitePool, route: axum::routing::MethodRouter<State>, policy: bool) -> Router {
    let mut config = Config::builder("Tests")
        .environment("Development")
        .enable_in(["Development"])
        .provider(SqliteProvider::new(pool.clone()))
        .preview_operation("POST", "/op")
        .identity(|headers| async move {
            headers.get("x-user").map(|user| Identity { name: Some(user.into()), subject: Some(user.into()), ..Identity::default() })
        });
    if policy {
        config = config.workbench_policy(|identity| identity.and_then(|i| i.name.as_deref()) == Some("admin"));
    }
    let bench = TestBench::new(config.build().unwrap());
    bench.wrap(Router::new().route("/op", route).bench_gate(&bench).with_state(State { pool }))
}

#[tokio::test]
async fn a_raw_commit_inside_a_preview_never_persists_anything() {
    async fn escape(db: Db) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        sqlx::query("INSERT INTO items (id, name) VALUES ('before', 'x')").execute(&mut *conn).await?;
        // Ignore the refusal and keep writing, as careless handler code might.
        let _ = sqlx::raw_sql("COMMIT").execute(&mut *conn).await;
        let _ = sqlx::query("INSERT INTO items (id, name) VALUES ('after', 'x')").execute(&mut *conn).await;
        Ok(StatusCode::OK)
    }
    let pool = pool().await;
    let app = single(pool.clone(), post(escape), false);
    let response = app.clone().oneshot(preview("/op", json!({}))).await.unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(response.headers().get("preference-applied").is_none());
    assert_eq!(count(&pool, "items").await, 0, "the commit hook turned every commit into a rollback");
    // The connection commits normally again once the preview is over.
    sqlx::query("INSERT INTO items (id, name) VALUES ('later', 'x')").execute(&pool).await.unwrap();
    assert_eq!(count(&pool, "items").await, 1);
}

#[tokio::test]
async fn a_named_commit_is_refused_before_it_runs() {
    async fn named_commit(db: Db) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        conn.query("INSERT INTO items (id, name) VALUES (:id, 'x')").bind("id", "a").execute().await?;
        match conn.query("UPDATE items SET name = 'y'; COMMIT").execute().await {
            Err(DbError::Query(message)) if message.contains("COMMIT") => Ok(StatusCode::OK),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
    let pool = pool().await;
    let envelope = json_body(single(pool.clone(), post(named_commit), false).oneshot(preview("/op", json!({}))).await.unwrap()).await;
    assert_eq!(envelope["rolledBack"], true, "{envelope}");
    assert_eq!(envelope["status"], 200);
    assert_eq!(count(&pool, "items").await, 0);
}

#[tokio::test]
async fn the_workbench_policy_gates_previews() {
    async fn write(db: Db) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        conn.query("INSERT INTO items (id, name) VALUES ('p', 'x')").execute().await?;
        Ok(StatusCode::OK)
    }
    let pool = pool().await;
    let app = single(pool.clone(), post(write), true);
    let anonymous = app.clone().oneshot(preview("/op", json!({}))).await.unwrap();
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    let mut viewer = preview("/op", json!({}));
    viewer.headers_mut().insert("x-user", "viewer".parse().unwrap());
    assert_eq!(app.clone().oneshot(viewer).await.unwrap().status(), StatusCode::FORBIDDEN);
    let mut admin = preview("/op", json!({}));
    admin.headers_mut().insert("x-user", "admin".parse().unwrap());
    assert_eq!(app.oneshot(admin).await.unwrap().status(), StatusCode::OK);
    assert_eq!(count(&pool, "items").await, 0);
}

#[tokio::test]
async fn an_ungated_handler_reached_by_a_preview_cannot_deliver_effects() {
    use std::sync::atomic::AtomicBool;
    static DELIVERED: AtomicBool = AtomicBool::new(false);
    async fn notify() -> StatusCode {
        if !testbench_core::capture::record_effect("email", "Welcome", json!({"to": ["a@b"]})) {
            DELIVERED.store(true, Ordering::SeqCst);
        }
        StatusCode::OK
    }
    let pool = pool().await;
    let bench = TestBench::new(
        Config::builder("Tests")
            .environment("Development")
            .enable_in(["Development"])
            .provider(SqliteProvider::new(pool.clone()))
            .preview_operation("POST", "/notify")
            .build()
            .unwrap(),
    );
    // Added after the gate, so the gate never sees it.
    let app = bench.wrap(
        Router::new()
            .route("/other", post(|| async { StatusCode::OK }))
            .bench_gate(&bench)
            .route("/notify", post(notify))
            .with_state(State { pool }),
    );
    let response = app.oneshot(preview("/notify", json!({}))).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert!(!DELIVERED.load(Ordering::SeqCst), "a preview suppresses effects even when the handler was not enrolled");
}

#[tokio::test]
async fn secret_columns_are_redacted_in_change_snapshots() {
    async fn sign_up(db: Db) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        conn.query("INSERT INTO users (api_token, email, password_hash) VALUES (:token, :email, :hash)")
            .bind("token", "tok-123")
            .bind("email", "ann@example.test")
            .bind("hash", "argon2-secret")
            .execute()
            .await?;
        Ok(StatusCode::CREATED)
    }
    let pool = pool().await;
    sqlx::query("CREATE TABLE users (api_token TEXT PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL)")
        .execute(&pool)
        .await
        .unwrap();
    let envelope = json_body(single(pool.clone(), post(sign_up), false).oneshot(preview("/op", json!({}))).await.unwrap()).await;
    let change = envelope["changes"].as_array().unwrap().iter().find(|c| c["table"] == "users").expect("a users change").clone();
    assert_eq!(change["key"], json!({"api_token": "[REDACTED]"}));
    assert_eq!(change["after"], json!({"api_token": "[REDACTED]", "email": "ann@example.test", "password_hash": "[REDACTED]"}));
    let text = envelope.to_string();
    assert!(!text.contains("argon2-secret") && !text.contains("tok-123"), "{text}");
}

/// Previews that read and then write share one SQLite file. A deferred `BEGIN` made almost all of them fail at once with
/// `database is locked`; they must queue on the write lock instead, each roll back and leave the table empty.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_sqlite_previews_queue_for_the_write_lock_instead_of_failing() {
    let pool = pool().await;
    let router = app(pool.clone(), true);
    let tasks: Vec<_> = (0..16)
        .map(|index| {
            let router = router.clone();
            tokio::spawn(async move {
                let response = router.oneshot(preview("/bump", json!({"id": format!("c{index}")}))).await.unwrap();
                let status = response.status();
                (status, json_body(response).await)
            })
        })
        .collect();
    for task in tasks {
        let (status, envelope) = task.await.unwrap();
        assert_eq!(status, StatusCode::OK, "{envelope}");
        assert_eq!(envelope["status"], 201);
        assert_eq!(envelope["rolledBack"], true);
    }
    assert_eq!(count(&pool, "items").await, 0);
}
