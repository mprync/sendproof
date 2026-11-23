//! Previews and observed sends against real PostgreSQL and MySQL servers, through a real Axum router.
//!
//! Set `BENCH_POSTGRES_URL` and/or `BENCH_MYSQL_URL` to a server the tests may create databases
//! on (for example `postgresql://bench:…@127.0.0.1:55432/postgres`). Each test works in its own
//! schema or database and drops it afterwards. Without the variable, that backend's tests print
//! that they were skipped and pass, so count them only when the variable was set.

use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::Body,
    extract::{FromRef, State},
    http::{Request, StatusCode},
    routing::post,
};
use http_body_util::BodyExt;
use sendproof_axum::{Config, Identity, Sendproof, SendproofRouterExt};
use sendproof_core::{BoxFuture, Enrollment, HeldStepError, PreviewProvider, SendproofLayer};
use sendproof_sqlx::{Backend, Db, DbConn, DbError, SqlxProvider};
use serde_json::{Value, json};
use sqlx::{MySql, MySqlPool, Pool, Postgres, postgres::PgPoolOptions};
use tokio::sync::{Barrier, Notify};
use tower::ServiceExt;
use tracing_subscriber::layer::SubscriberExt;

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn unique(prefix: &str) -> String {
    format!("{prefix}_{}_{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst))
}

/// What a test needs to know about a server backend.
trait Server: Backend {
    const ENV: &'static str;
    /// Opens an isolated database with the test schema. Answers the pool and a cleanup future.
    fn open(url: String) -> BoxFuture<'static, (Pool<Self>, BoxFuture<'static, ()>)>;
    /// Runs SQL on a pool connection, outside any capture.
    fn exec<'a>(pool: &'a Pool<Self>, sql: &'a str) -> BoxFuture<'a, ()>;
    fn count<'a>(pool: &'a Pool<Self>, sql: &'a str) -> BoxFuture<'a, i64>;
    /// Runs plain SQLx (`raw_sql`) on the handler's connection, bypassing [`DbConn::query`].
    fn raw<'a>(conn: &'a mut DbConn<Self>, sql: &'a str) -> BoxFuture<'a, Result<(), sqlx::Error>>;
    /// A statement that writes five rows to `items`.
    const BULK: &'static str;
    /// A statement that ends the current transaction.
    const END_TRANSACTION: &'static str;
}

impl Server for Postgres {
    const ENV: &'static str = "BENCH_POSTGRES_URL";
    const BULK: &'static str = "INSERT INTO items (id, name) SELECT 'b' || g, :name FROM generate_series(1, 5) AS g";
    const END_TRANSACTION: &'static str = "COMMIT";

    fn open(url: String) -> BoxFuture<'static, (Pool<Self>, BoxFuture<'static, ()>)> {
        Box::pin(async move {
            let schema = unique("tb");
            let admin = PgPoolOptions::new().max_connections(1).connect(&url).await.expect("connect to PostgreSQL");
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}"))).execute(&admin).await.unwrap();
            let search_path = schema.clone();
            let pool = PgPoolOptions::new()
                .max_connections(3)
                .after_connect(move |conn, _| {
                    let sql = format!("SET search_path = {search_path}");
                    Box::pin(async move { sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).execute(conn).await.map(drop) })
                })
                .connect(&url)
                .await
                .unwrap();
            sqlx::raw_sql(
                "CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL);
                 CREATE TABLE item_audit (n BIGSERIAL PRIMARY KEY, item TEXT NOT NULL);
                 CREATE TABLE notes (body TEXT NOT NULL);
                 CREATE FUNCTION audit_item() RETURNS trigger LANGUAGE plpgsql AS $$
                 BEGIN INSERT INTO item_audit (item) VALUES (NEW.id); RETURN NEW; END $$;
                 CREATE TRIGGER audit_items AFTER INSERT ON items FOR EACH ROW EXECUTE FUNCTION audit_item();",
            )
            .execute(&pool)
            .await
            .unwrap();
            let cleanup_pool = pool.clone();
            let cleanup: BoxFuture<'static, ()> = Box::pin(async move {
                cleanup_pool.close().await;
                let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&admin).await;
                admin.close().await;
            });
            (pool, cleanup)
        })
    }

    fn exec<'a>(pool: &'a Pool<Self>, sql: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned())).execute(pool).await.unwrap();
        })
    }

    fn count<'a>(pool: &'a Pool<Self>, sql: &'a str) -> BoxFuture<'a, i64> {
        Box::pin(async move { sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned())).fetch_one(pool).await.unwrap() })
    }

    fn raw<'a>(conn: &'a mut DbConn<Self>, sql: &'a str) -> BoxFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(async move { sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned())).execute(conn).await.map(drop) })
    }
}

impl Server for MySql {
    const ENV: &'static str = "BENCH_MYSQL_URL";
    const BULK: &'static str =
        "INSERT INTO items (id, name) VALUES ('b1', :name), ('b2', :name), ('b3', :name), ('b4', :name), ('b5', :name)";
    // DDL commits the transaction implicitly.
    const END_TRANSACTION: &'static str = "CREATE TABLE implicit_commit (x INT)";

    fn open(url: String) -> BoxFuture<'static, (Pool<Self>, BoxFuture<'static, ()>)> {
        Box::pin(async move {
            let database = unique("tb");
            let admin = MySqlPool::connect(&url).await.expect("connect to MySQL");
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {database}"))).execute(&admin).await.unwrap();
            let base = url.rsplit_once('/').map_or(url.as_str(), |(base, _)| base).to_owned();
            let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(3).connect(&format!("{base}/{database}")).await.unwrap();
            sqlx::raw_sql(
                "CREATE TABLE items (id VARCHAR(64) PRIMARY KEY, name TEXT NOT NULL);
                 CREATE TABLE counters (id BIGINT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(64) NOT NULL, hits INT NOT NULL DEFAULT 0, UNIQUE (label));
                 CREATE TABLE item_audit (n BIGINT AUTO_INCREMENT PRIMARY KEY, item VARCHAR(64) NOT NULL);
                 CREATE TABLE audited (id VARCHAR(64) PRIMARY KEY);
                 CREATE TRIGGER audit_audited AFTER INSERT ON audited FOR EACH ROW INSERT INTO item_audit (item) VALUES (NEW.id);
                 CREATE TABLE parents (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL);
                 CREATE TABLE children (id INT PRIMARY KEY, parent INT NOT NULL,
                     FOREIGN KEY (parent) REFERENCES parents (id) ON DELETE CASCADE);",
            )
            .execute(&pool)
            .await
            .unwrap();
            let cleanup_pool = pool.clone();
            let cleanup: BoxFuture<'static, ()> = Box::pin(async move {
                cleanup_pool.close().await;
                let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP DATABASE {database}"))).execute(&admin).await;
                admin.close().await;
            });
            (pool, cleanup)
        })
    }

    fn exec<'a>(pool: &'a Pool<Self>, sql: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned())).execute(pool).await.unwrap();
        })
    }

    fn count<'a>(pool: &'a Pool<Self>, sql: &'a str) -> BoxFuture<'a, i64> {
        Box::pin(async move { sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned())).fetch_one(pool).await.unwrap() })
    }

    fn raw<'a>(conn: &'a mut DbConn<Self>, sql: &'a str) -> BoxFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(async move { sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned())).execute(conn).await.map(drop) })
    }
}

/// Runs `test` against an isolated database, or skips when the server variable is unset.
async fn with_server<B: Server, F, Fut>(test: F)
where
    F: FnOnce(Pool<B>) -> Fut,
    Fut: Future<Output = ()>,
{
    let Ok(url) = std::env::var(B::ENV) else {
        eprintln!("skipped: set {} to run this test", B::ENV);
        return;
    };
    let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry().with(SendproofLayer::new()));
    let (pool, cleanup) = B::open(url).await;
    // Drop the test's database even when an assertion fails.
    let outcome = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(test(pool))).await;
    cleanup.await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn postgres_held_step_recovers_when_handler_catches_an_aborted_transaction() {
    with_server::<Postgres, _, _>(|pool| async move {
        let mut held = SqlxProvider::new(pool.clone()).begin_held_preview().await.expect("open held PostgreSQL preview");
        let mut extensions = http::Extensions::new();
        held.begin_step(1, &mut extensions).await.unwrap();
        let enrollment = Enrollment(Arc::new(extensions));
        let stale = Db::from_enrollment(pool.clone(), Some(&enrollment), true).unwrap();
        let mut connection = stale.acquire().await.unwrap();
        // A raw SQLx error leaves PostgreSQL's current subtransaction aborted even if caught.
        assert!(Postgres::raw(&mut connection, "SELECT 1 / 0").await.is_err());
        drop(connection);
        assert!(matches!(held.keep_step().await, Err(HeldStepError::Recoverable(_))));
        held.rewind(1).await.unwrap();

        let mut extensions = http::Extensions::new();
        held.begin_step(1, &mut extensions).await.unwrap();
        assert!(matches!(stale.acquire().await, Err(DbError::NotEnrolled)));
        let enrollment = Enrollment(Arc::new(extensions));
        let db = Db::from_enrollment(pool.clone(), Some(&enrollment), true).unwrap();
        db.acquire().await.unwrap().query("INSERT INTO items (id, name) VALUES ('held', 'kept')").execute().await.unwrap();
        let changes = held.keep_step().await.expect("keep step after rewind");
        assert!(changes.changes.iter().any(|change| change.table == "items" && change.operation == "insert"));
        held.end().await.unwrap();
        assert_eq!(Postgres::count(&pool, "SELECT count(*) FROM items").await, 0);
    })
    .await;
}

/// Coordination points a handler shares with its test.
#[derive(Default)]
struct Signals {
    written: Notify,
    resume: Notify,
    barrier: std::sync::OnceLock<Barrier>,
}

struct AppState<B: Backend> {
    pool: Pool<B>,
    signals: Arc<Signals>,
}

impl<B: Backend> Clone for AppState<B> {
    fn clone(&self) -> Self {
        Self { pool: self.pool.clone(), signals: self.signals.clone() }
    }
}

impl<B: Backend> FromRef<AppState<B>> for Pool<B> {
    fn from_ref(state: &AppState<B>) -> Self {
        state.pool.clone()
    }
}

async fn insert<B: Backend>(conn: &mut DbConn<B>, id: &str, name: &str) -> Result<u64, DbError> {
    use sendproof_sqlx::RowsAffected;
    Ok(conn.query("INSERT INTO items (id, name) VALUES (:id, :name)").bind("id", id).bind("name", name).execute().await?.rows_affected())
}

/// Insert, update, insert, delete; and a secret-named parameter.
async fn sequence<B: Backend>(db: Db<B>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    insert(&mut conn, "a", "Bolt").await?;
    conn.query("UPDATE items SET name = :name WHERE id = :id").bind("name", "Nut").bind("id", "a").execute().await?;
    insert(&mut conn, "b", "Washer").await?;
    conn.query("DELETE FROM items WHERE id = :id").bind("id", "b").execute().await?;
    conn.query("SELECT :api_key AS echoed").bind("api_key", "hunter2").fetch_optional().await?;
    Ok(StatusCode::OK)
}

async fn bulk<B: Server>(db: Db<B>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    conn.query(B::BULK).bind("name", "bulk").execute().await?;
    Ok(StatusCode::OK)
}

/// A nested transaction that rolls back and one that commits.
async fn nested<B: Backend>(db: Db<B>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    insert(&mut conn, "keep", "Kept").await?;
    let mut undone = conn.begin().await?;
    undone.query("INSERT INTO items (id, name) VALUES (:id, 'Undone')").bind("id", "undone").execute().await?;
    undone.rollback().await?;
    let mut dropped = conn.begin().await?;
    dropped.query("INSERT INTO items (id, name) VALUES (:id, 'Dropped')").bind("id", "dropped").execute().await?;
    drop(dropped);
    let mut kept = conn.begin().await?;
    kept.query("INSERT INTO items (id, name) VALUES (:id, 'Nested')").bind("id", "nested").execute().await?;
    kept.commit().await?;
    Ok(StatusCode::OK)
}

/// A duplicate insert fails and is handled; the request carries on.
async fn duplicate<B: Backend>(db: Db<B>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    insert(&mut conn, "d", "First").await?;
    match insert(&mut conn, "d", "Again").await {
        Err(DbError::Sqlx(sqlx::Error::Database(error))) if error.is_unique_violation() => {}
        other => panic!("expected a unique violation, got {other:?}"),
    }
    insert(&mut conn, "e", "After").await?;
    Ok(StatusCode::OK)
}

async fn end_transaction<B: Server>(db: Db<B>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    insert(&mut conn, "escaped", "Committed").await?;
    // Plain SQLx on the handler's connection is checked too: refused before it is sent.
    match B::raw(&mut conn, B::END_TRANSACTION).await {
        Err(sqlx::Error::InvalidArgument(message)) if message.contains("refused") => {}
        other => panic!("expected a refusal, got {other:?}"),
    }
    insert(&mut conn, "after", "Rolled back").await?;
    Ok(StatusCode::OK)
}

/// Ends the transaction through a named query, which a preview refuses before it runs.
async fn named_end<B: Server>(db: Db<B>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    insert(&mut conn, "kept", "Rolled back").await?;
    match conn.query(B::END_TRANSACTION).execute().await {
        Err(DbError::Query(message)) if message.contains("refused") => {}
        other => panic!("expected a refusal, got {:?}", other.map(|_| ())),
    }
    insert(&mut conn, "still", "Rolled back").await?;
    Ok(StatusCode::OK)
}

/// Writes, lets the test write from another connection, then writes again.
async fn interleaved<B: Backend>(State(state): State<AppState<B>>, db: Db<B>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    insert(&mut conn, "own", "Mine").await?;
    let resumed = state.signals.resume.notified();
    state.signals.written.notify_one();
    resumed.await;
    conn.query("UPDATE items SET name = :name WHERE id = :id").bind("name", "Still mine").bind("id", "own").execute().await?;
    Ok(StatusCode::OK)
}

/// Two of these run at once, each with its own `x-id`.
async fn overlapping<B: Backend>(
    State(state): State<AppState<B>>,
    headers: axum::http::HeaderMap,
    db: Db<B>,
) -> Result<StatusCode, DbError> {
    let id = headers["x-id"].to_str().unwrap().to_owned();
    let mut conn = db.acquire().await?;
    insert(&mut conn, &format!("{id}-1"), "First").await?;
    state.signals.barrier.get().expect("a barrier").wait().await;
    insert(&mut conn, &format!("{id}-2"), "Second").await?;
    Ok(StatusCode::OK)
}

/// Inserts one fixed key; several previews run it at once. The pause lets the others reach their insert, and wait on
/// this one's row, before this preview rolls back.
async fn shared<B: Backend>(db: Db<B>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    insert(&mut conn, "shared", "Shared").await?;
    tokio::time::sleep(Duration::from_millis(50)).await;
    Ok(StatusCode::CREATED)
}

async fn raw_write<B: Server>(db: Db<B>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    B::raw(&mut conn, "INSERT INTO items (id, name) VALUES ('raw', 'Raw')").await?;
    Ok(StatusCode::OK)
}

async fn boom<B: Backend>(db: Db<B>) -> Result<StatusCode, DbError> {
    let mut conn = db.acquire().await?;
    insert(&mut conn, "boom", "x").await?;
    panic!("handler failure after writing");
}

const ROUTES: [&str; 11] =
    ["/sequence", "/bulk", "/nested", "/duplicate", "/end", "/named-end", "/interleaved", "/overlapping", "/shared", "/raw", "/boom"];

fn app<B: Server>(pool: Pool<B>, signals: Arc<Signals>) -> Router {
    let mut config = Config::builder("Tests")
        .environment("Development")
        .enable_in(["Development"])
        .include_sql_parameter_values(true)
        .provider(SqlxProvider::new(pool.clone()).database("test"))
        .identity(|headers| async move {
            headers.get("x-user").map(|user| Identity {
                name: Some(user.into()),
                subject: Some(user.into()),
                authentication_type: Some("test".into()),
                ..Identity::default()
            })
        });
    for path in ROUTES {
        config = config.preview_operation("POST", path);
    }
    let bench = Sendproof::new(config.build().unwrap());
    let api = Router::new()
        .route("/sequence", post(sequence::<B>))
        .route("/bulk", post(bulk::<B>))
        .route("/nested", post(nested::<B>))
        .route("/duplicate", post(duplicate::<B>))
        .route("/end", post(end_transaction::<B>))
        .route("/named-end", post(named_end::<B>))
        .route("/interleaved", post(interleaved::<B>))
        .route("/overlapping", post(overlapping::<B>))
        .route("/shared", post(shared::<B>))
        .route("/raw", post(raw_write::<B>))
        .route("/boom", post(boom::<B>))
        .bench_gate(&bench)
        .with_state(AppState { pool, signals });
    bench.wrap(api)
}

fn preview(path: &str) -> Request<Body> {
    Request::post(format!("/sendproof/_preview{path}")).header("prefer", "tx=rollback").body(Body::empty()).unwrap()
}

fn send(path: &str, user: &str) -> Request<Body> {
    Request::post(path).header("prefer", "trace").header("x-user", user).body(Body::empty()).unwrap()
}

async fn json_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap_or(Value::Null)
}

async fn trace(app: &Router, response: axum::response::Response, user: &str) -> Value {
    assert!(response.status().is_success(), "the send succeeded: {}", response.status());
    let id = response.headers().get("x-sendproof-trace").expect("a trace id").to_str().unwrap().to_owned();
    let read = Request::get(format!("/sendproof/_api/traces/{id}")).header("x-user", user).body(Body::empty()).unwrap();
    json_body(app.clone().oneshot(read).await.unwrap()).await
}

/// `(operation, id)` of the changes to `items`, in order.
fn item_changes(envelope: &Value) -> Vec<(String, String)> {
    envelope["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|change| change["table"] == "items")
        .map(|change| (change["operation"].as_str().unwrap().to_owned(), change["key"]["id"].as_str().unwrap_or("?").to_owned()))
        .collect()
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect()
}

async fn preview_reports_ordered_changes_and_rolls_back<B: Server>(pool: Pool<B>) {
    let app = app(pool.clone(), Arc::default());
    let response = app.oneshot(preview("/sequence")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let envelope = json_body(response).await;
    assert_eq!(envelope["rolledBack"], true);
    assert_eq!(item_changes(&envelope), pairs(&[("insert", "a"), ("update", "a"), ("insert", "b"), ("delete", "b")]));
    let changes = envelope["changes"].as_array().unwrap();
    let update = changes.iter().find(|c| c["operation"] == "update").unwrap();
    assert_eq!(update["key"], json!({"id": "a"}));
    assert_eq!(update["before"]["name"], "Bolt");
    assert_eq!(update["after"]["name"], "Nut");
    let delete = changes.iter().find(|c| c["operation"] == "delete").unwrap();
    assert_eq!(delete["before"]["name"], "Washer");
    assert!(delete["after"].is_null());
    let sql: Vec<_> = envelope["logs"].as_array().unwrap().iter().filter(|l| l["level"] == "Sql").collect();
    assert_eq!(sql.len(), 5, "each named statement is logged once, and the capture's own statements never: {sql:?}");
    assert_eq!(
        sql[0]["sql"]["parameters"],
        json!([{"name": "id", "value": "a", "dbType": "String"}, {"name": "name", "value": "Bolt", "dbType": "String"}])
    );
    assert_eq!(sql[0]["sql"]["rowsAffected"], 1);
    assert_eq!(sql[4]["sql"]["parameters"][0]["value"], "[REDACTED]");
    assert!(!envelope.to_string().contains("hunter2"));
    assert_eq!(B::count(&pool, "SELECT COUNT(*) FROM items").await, 0);
    assert_eq!(B::count(&pool, "SELECT COUNT(*) FROM item_audit").await, 0, "trigger writes roll back too");
}

async fn bulk_writes_are_captured_row_by_row<B: Server>(pool: Pool<B>) {
    let envelope = json_body(app(pool.clone(), Arc::default()).oneshot(preview("/bulk")).await.unwrap()).await;
    let ids: Vec<String> = item_changes(&envelope).into_iter().map(|(operation, id)| format!("{operation}:{id}")).collect();
    assert_eq!(ids, ["insert:b1", "insert:b2", "insert:b3", "insert:b4", "insert:b5"]);
    assert_eq!(B::count(&pool, "SELECT COUNT(*) FROM items").await, 0);
}

async fn rolled_back_nested_transactions_drop_their_changes<B: Server>(pool: Pool<B>) {
    let envelope = json_body(app(pool.clone(), Arc::default()).oneshot(preview("/nested")).await.unwrap()).await;
    assert_eq!(envelope["rolledBack"], true, "{envelope}");
    assert_eq!(item_changes(&envelope), pairs(&[("insert", "keep"), ("insert", "nested")]));
    assert_eq!(B::count(&pool, "SELECT COUNT(*) FROM items").await, 0);
}

async fn a_failed_statement_does_not_break_the_preview<B: Server>(pool: Pool<B>) {
    let envelope = json_body(app(pool.clone(), Arc::default()).oneshot(preview("/duplicate")).await.unwrap()).await;
    assert_eq!(envelope["status"], 200, "{envelope}");
    assert_eq!(item_changes(&envelope), pairs(&[("insert", "d"), ("insert", "e")]));
    assert_eq!(B::count(&pool, "SELECT COUNT(*) FROM items").await, 0);
}

async fn ending_the_transaction_inside_a_preview_is_unconfirmed<B: Server>(pool: Pool<B>) {
    let app = app(pool.clone(), Arc::default());
    let response = app.clone().oneshot(preview("/end")).await.unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(response.headers().get("preference-applied").is_none(), "no rollback is claimed");
    assert_eq!(B::count(&pool, "SELECT COUNT(*) FROM items").await, 0, "the raw commit was refused before it was sent");
    // The connection is still usable for the next preview.
    let next = json_body(app.oneshot(preview("/sequence")).await.unwrap()).await;
    assert_eq!(next["rolledBack"], true, "{next}");
}

async fn a_named_statement_that_ends_the_transaction_is_refused<B: Server>(pool: Pool<B>) {
    // Refused before it runs, and the preview still fails even though the handler caught the error.
    let response = app(pool.clone(), Arc::default()).oneshot(preview("/named-end")).await.unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(response.headers().get("preference-applied").is_none(), "no rollback is claimed");
    assert_eq!(B::count(&pool, "SELECT COUNT(*) FROM items").await, 0);
}

async fn observed_send_ignores_concurrent_writers<B: Server>(pool: Pool<B>) {
    let signals = Arc::new(Signals::default());
    let app = app(pool.clone(), signals.clone());
    let written = signals.written.notified();
    let request = tokio::spawn(app.clone().oneshot(send("/interleaved", "alex")));
    written.await;
    // Another connection writes while the observed handler is between statements. It must not be
    // blocked by the capture, and its row must not appear in the trace.
    tokio::time::timeout(Duration::from_secs(10), B::exec(&pool, "INSERT INTO items (id, name) VALUES ('outsider', 'Theirs')"))
        .await
        .expect("a concurrent writer is not blocked by an observed send");
    signals.resume.notify_one();
    let response = request.await.unwrap().unwrap();
    let trace = trace(&app, response, "alex").await;
    assert_eq!(item_changes(&trace), pairs(&[("insert", "own"), ("update", "own")]));
    assert!(trace.get("changesTruncated").is_none(), "the list is complete: {trace}");
    assert_eq!(B::count(&pool, "SELECT COUNT(*) FROM items").await, 2, "both writes committed");
}

async fn concurrent_observed_sends_see_only_their_own_rows<B: Server>(pool: Pool<B>) {
    let signals = Arc::new(Signals::default());
    signals.barrier.set(Barrier::new(2)).ok();
    let app = app(pool.clone(), signals);
    let request = |id: &str| {
        let mut request = send("/overlapping", id);
        request.headers_mut().insert("x-id", id.parse().unwrap());
        app.clone().oneshot(request)
    };
    let (left, right) = tokio::join!(request("left"), request("right"));
    for (user, response) in [("left", left.unwrap()), ("right", right.unwrap())] {
        let trace = trace(&app, response, user).await;
        let expected = [("insert".to_owned(), format!("{user}-1")), ("insert".to_owned(), format!("{user}-2"))];
        assert_eq!(item_changes(&trace), expected);
    }
    assert_eq!(B::count(&pool, "SELECT COUNT(*) FROM items").await, 4);
}

/// Previews inserting the same new key at once each report their own insert. On MySQL, InnoDB would abort all but
/// one with a deadlock when the first rolled back, so the provider lets MySQL previews take turns.
async fn concurrent_previews_inserting_one_key_all_complete<B: Server>(pool: Pool<B>) {
    let app = app(pool.clone(), Arc::default());
    let responses = futures_util::future::join_all((0..8).map(|_| app.clone().oneshot(preview("/shared")))).await;
    for response in responses {
        let response = response.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let envelope = json_body(response).await;
        assert_eq!(envelope["status"], 201, "{envelope}");
        assert_eq!(item_changes(&envelope), pairs(&[("insert", "shared")]));
    }
    assert_eq!(B::count(&pool, "SELECT COUNT(*) FROM items").await, 0);
}

async fn sequential_requests_reuse_clean_connections<B: Server>(pool: Pool<B>) {
    let app = app(pool.clone(), Arc::default());
    // More requests than pooled connections, alternating previews and observed sends.
    for round in 0..4 {
        let envelope = json_body(app.clone().oneshot(preview("/sequence")).await.unwrap()).await;
        assert_eq!(envelope["rolledBack"], true, "round {round}: {envelope}");
        assert_eq!(item_changes(&envelope).len(), 4, "round {round}");
        let response = app.clone().oneshot(send("/bulk", "alex")).await.unwrap();
        let trace = trace(&app, response, "alex").await;
        assert_eq!(item_changes(&trace).len(), 5, "round {round}");
        B::exec(&pool, "DELETE FROM items").await;
    }
}

async fn a_panicking_observed_handler_is_not_traced<B: Server>(pool: Pool<B>) {
    let app = app(pool.clone(), Arc::default());
    let outcome = tokio::spawn(app.clone().oneshot(send("/boom", "alex"))).await;
    assert!(outcome.is_err() || outcome.unwrap().unwrap().status().is_server_error());
    assert_eq!(B::count(&pool, "SELECT COUNT(*) FROM items WHERE id = 'boom'").await, 1, "an ordinary send commits as it goes");
    // The connection that carried the capture is not reused with it.
    let response = app.clone().oneshot(send("/bulk", "alex")).await.unwrap();
    assert_eq!(item_changes(&trace(&app, response, "alex").await).len(), 5);
}

macro_rules! server_tests {
    ($backend:ty, $module:ident: $($test:ident),* $(,)?) => {
        mod $module {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
                async fn $test() {
                    with_server::<$backend, _, _>(super::$test::<$backend>).await;
                }
            )*
        }
    };
}

server_tests!(Postgres, postgres:
    preview_reports_ordered_changes_and_rolls_back,
    bulk_writes_are_captured_row_by_row,
    rolled_back_nested_transactions_drop_their_changes,
    a_failed_statement_does_not_break_the_preview,
    ending_the_transaction_inside_a_preview_is_unconfirmed,
    a_named_statement_that_ends_the_transaction_is_refused,
    observed_send_ignores_concurrent_writers,
    concurrent_observed_sends_see_only_their_own_rows,
    concurrent_previews_inserting_one_key_all_complete,
    sequential_requests_reuse_clean_connections,
    a_panicking_observed_handler_is_not_traced,
);

server_tests!(MySql, mysql:
    preview_reports_ordered_changes_and_rolls_back,
    bulk_writes_are_captured_row_by_row,
    rolled_back_nested_transactions_drop_their_changes,
    a_failed_statement_does_not_break_the_preview,
    ending_the_transaction_inside_a_preview_is_unconfirmed,
    a_named_statement_that_ends_the_transaction_is_refused,
    observed_send_ignores_concurrent_writers,
    concurrent_observed_sends_see_only_their_own_rows,
    concurrent_previews_inserting_one_key_all_complete,
    sequential_requests_reuse_clean_connections,
    a_panicking_observed_handler_is_not_traced,
);

/// PostgreSQL captures writes made by triggers, reports keyless rows, and leaves no trigger behind.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_captures_trigger_writes_and_cleans_up() {
    with_server::<Postgres, _, _>(|pool| async move {
        let app = app(pool.clone(), Arc::default());
        let envelope = json_body(app.clone().oneshot(preview("/sequence")).await.unwrap()).await;
        let audit: Vec<_> = envelope["changes"].as_array().unwrap().iter().filter(|c| c["table"] == "item_audit").collect();
        assert_eq!(audit.len(), 2, "the user trigger's rows are captured: {envelope}");
        assert_eq!(audit[0]["after"]["item"], "a");
        // An observed send's committed triggers are dropped afterwards.
        let response = app.clone().oneshot(send("/bulk", "alex")).await.unwrap();
        trace(&app, response, "alex").await;
        let leftover = Postgres::count(&pool, "SELECT COUNT(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND t.tgname LIKE 'sendproof\\_capture\\_%'").await;
        assert_eq!(leftover, 0, "no capture trigger outlives its request");
        // A panicking observed handler: its connection is closed, so the session's triggers go with it.
        let _ = tokio::spawn(app.clone().oneshot(send("/boom", "alex"))).await;
        let mut leftover = 1;
        for _ in 0..50 {
            leftover = Postgres::count(&pool, "SELECT COUNT(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND t.tgname LIKE 'sendproof\\_capture\\_%'").await;
            if leftover == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(leftover, 0, "triggers of an abandoned capture disappear with its session");
    })
    .await;
}

/// MySQL captures named statements only. It says so when a raw statement wrote rows, and when a
/// recognized write set off a trigger or a foreign-key action whose rows it cannot see.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mysql_flags_writes_it_cannot_capture() {
    async fn triggered(db: Db<MySql>) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        conn.query("INSERT INTO audited (id) VALUES (:id)").bind("id", "t1").execute().await?;
        Ok(StatusCode::OK)
    }
    async fn cascaded(db: Db<MySql>) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        conn.query("DELETE FROM parents WHERE id = :id").bind("id", 1).execute().await?;
        Ok(StatusCode::OK)
    }
    async fn renamed(db: Db<MySql>) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        // The foreign key acts on delete only, so renaming a parent writes nothing elsewhere.
        conn.query("UPDATE parents SET name = :name WHERE id = :id").bind("name", "Renamed").bind("id", 1).execute().await?;
        Ok(StatusCode::OK)
    }
    async fn stepped(db: Db<MySql>) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        MySql::raw(&mut conn, "SET SESSION auto_increment_increment = 5").await?;
        let result = conn.query("INSERT INTO counters (label) VALUES (:a), (:b)").bind("a", "p").bind("b", "q").execute().await;
        MySql::raw(&mut conn, "SET SESSION auto_increment_increment = 1").await?;
        result?;
        Ok(StatusCode::OK)
    }
    with_server::<MySql, _, _>(|pool| async move {
        MySql::exec(
            &pool,
            "INSERT INTO parents (id, name) VALUES (1, 'Parent'); INSERT INTO children (id, parent) VALUES (10, 1), (11, 1)",
        )
        .await;
        let mut config =
            Config::builder("Tests").environment("Development").enable_in(["Development"]).provider(SqlxProvider::new(pool.clone()));
        for path in ["/raw", "/triggered", "/cascaded", "/renamed", "/stepped"] {
            config = config.preview_operation("POST", path);
        }
        let bench = Sendproof::new(config.build().unwrap());
        let app = bench.wrap(
            Router::new()
                .route("/raw", post(raw_write::<MySql>))
                .route("/triggered", post(triggered))
                .route("/cascaded", post(cascaded))
                .route("/renamed", post(renamed))
                .route("/stepped", post(stepped))
                .bench_gate(&bench)
                .with_state(AppState { pool: pool.clone(), signals: Arc::default() }),
        );
        let run = |path: &'static str| {
            let app = app.clone();
            async move { json_body(app.oneshot(preview(path)).await.unwrap()).await }
        };
        let tables = |envelope: &Value| -> Vec<String> {
            envelope["changes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| format!("{} {}", c["operation"].as_str().unwrap(), c["table"].as_str().unwrap()))
                .collect()
        };

        // A raw SQLx write runs, but its rows are unknown.
        let raw = run("/raw").await;
        assert_eq!(raw["status"], 200);
        assert!(tables(&raw).is_empty());
        assert_eq!(raw["changesTruncated"], true, "{raw}");

        // The trigger's audit row is not captured, so the list says it is incomplete.
        let triggered = run("/triggered").await;
        assert_eq!(tables(&triggered), ["insert audited"]);
        assert_eq!(triggered["changesTruncated"], true, "{triggered}");

        // ON DELETE CASCADE removes the children, which are not captured.
        let cascaded = run("/cascaded").await;
        assert_eq!(tables(&cascaded), ["delete parents"]);
        assert_eq!(cascaded["changesTruncated"], true, "{cascaded}");

        // No trigger or foreign-key action applies: the list is complete.
        let renamed = run("/renamed").await;
        assert_eq!(tables(&renamed), ["update parents"]);
        assert!(renamed.get("changesTruncated").is_none(), "{renamed}");

        // Generated keys follow the session's auto_increment_increment, changed mid-request.
        let stepped = run("/stepped").await;
        let keys: Vec<i64> = stepped["changes"].as_array().unwrap().iter().map(|c| c["key"]["id"].as_i64().unwrap()).collect();
        assert_eq!(keys.len(), 2, "{stepped}");
        assert_eq!(keys[1] - keys[0], 5, "{stepped}");
        assert!(stepped.get("changesTruncated").is_none(), "{stepped}");

        for (table, rows) in [("items", 0), ("audited", 0), ("item_audit", 0), ("parents", 1), ("children", 2), ("counters", 0)] {
            assert_eq!(MySql::count(&pool, &format!("SELECT COUNT(*) FROM {table}")).await, rows, "{table} is unchanged");
        }
    })
    .await;
}

/// A preview app over `provider` with one route, `/run`, served by `handler`.
fn single_route<H, T>(provider: SqlxProvider<MySql>, pool: Pool<MySql>, signals: Arc<Signals>, handler: H) -> Router
where
    H: axum::handler::Handler<T, AppState<MySql>>,
    T: 'static,
{
    let config =
        Config::builder("Tests").environment("Development").enable_in(["Development"]).provider(provider).preview_operation("POST", "/run");
    let bench = Sendproof::new(config.build().unwrap());
    bench.wrap(Router::new().route("/run", post(handler)).bench_gate(&bench).with_state(AppState { pool, signals }))
}

/// spec/data-stores.md "Transaction-control statements from the handler" on MySQL: an undeclared
/// `CALL` is refused before it runs, and a procedure wrongly declared safe that commits still fails
/// the preview, because the savepoint set when it started is gone. The last part runs with
/// `autocommit=0`, where MySQL opens a new transaction after the commit, which only the start
/// savepoint sees through.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mysql_procedures_never_commit_a_confirmed_preview() {
    async fn call(db: Db<MySql>) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        insert(&mut conn, "before", "Preview").await?;
        let _ = conn.query("CALL sendproof_commit_probe()").execute().await;
        insert(&mut conn, "after", "Preview").await?;
        Ok(StatusCode::CREATED)
    }
    with_server::<MySql, _, _>(|pool| async move {
        MySql::exec(&pool, "CREATE PROCEDURE sendproof_commit_probe() BEGIN COMMIT; END").await;
        let count = || MySql::count(&pool, "SELECT COUNT(*) FROM items");

        let guarded = single_route(SqlxProvider::new(pool.clone()), pool.clone(), Arc::default(), call);
        let response = guarded.oneshot(preview("/run")).await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR, "a refused CALL fails the preview");
        assert_eq!(count().await, 0);

        let trusting = SqlxProvider::new(pool.clone()).safe_procedure("sendproof_commit_probe");
        let response = single_route(trusting, pool.clone(), Arc::default(), call).oneshot(preview("/run")).await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR, "a declared procedure that commits fails the preview");
        assert!(response.headers().get("preference-applied").is_none());
        MySql::exec(&pool, "DELETE FROM items").await;

        let manual = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(1)
            .after_connect(|conn, _| Box::pin(async move { sqlx::raw_sql("SET autocommit = 0").execute(conn).await.map(drop) }))
            .connect_with((*pool.connect_options()).clone())
            .await
            .unwrap();
        let trusting = SqlxProvider::new(manual.clone()).safe_procedure("sendproof_commit_probe");
        let response = single_route(trusting, manual.clone(), Arc::default(), call).oneshot(preview("/run")).await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR, "under autocommit=0 the start savepoint still sees the commit");
        assert!(response.headers().get("preference-applied").is_none());
        manual.close().await;
    })
    .await;
}

/// spec/data-stores.md: a MySQL deadlock rolls the whole preview transaction back, so a retried write
/// would run with autocommit and commit for real. The provider refuses every statement after it, and
/// the preview answers 500.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mysql_refuses_every_statement_after_a_deadlock() {
    async fn deadlocked(State(state): State<AppState<MySql>>, db: Db<MySql>) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        conn.query("UPDATE items SET name = :name WHERE id = :id").bind("name", "Preview").bind("id", "a").execute().await?;
        let resumed = state.signals.resume.notified();
        state.signals.written.notify_one();
        resumed.await;
        // The other transaction holds `b` and waits for `a`: this closes the cycle, and InnoDB rolls back the
        // preview, which changed fewer rows.
        let deadlock = conn.query("UPDATE items SET name = :name WHERE id = :id").bind("name", "Preview").bind("id", "b").execute().await;
        assert!(deadlock.is_err(), "the preview was the deadlock victim");
        // An ORM retries the write; with the transaction gone it would commit on its own.
        let retried =
            conn.query("INSERT INTO items (id, name) VALUES (:id, :name)").bind("id", "retried").bind("name", "x").execute().await;
        assert!(matches!(retried, Err(DbError::Query(ref message)) if message.contains("refused")), "{retried:?}");
        Ok(StatusCode::CREATED)
    }
    with_server::<MySql, _, _>(|pool| async move {
        MySql::exec(&pool, "INSERT INTO items (id, name) VALUES ('a', 'A'), ('b', 'B')").await;
        for n in 0..20 {
            MySql::exec(&pool, &format!("INSERT INTO items (id, name) VALUES ('filler{n}', 'F')")).await;
        }
        let signals = Arc::new(Signals::default());
        let app = single_route(SqlxProvider::new(pool.clone()), pool.clone(), signals.clone(), deadlocked);
        let request = tokio::spawn(app.oneshot(preview("/run")));
        signals.written.notified().await;

        let mut other = pool.begin().await.unwrap();
        sqlx::raw_sql("UPDATE items SET name = 'Other' WHERE id = 'b' OR id LIKE 'filler%'").execute(&mut *other).await.unwrap();
        let waiting = tokio::spawn(async move {
            let result = sqlx::raw_sql("UPDATE items SET name = 'Other' WHERE id = 'a'").execute(&mut *other).await.map(drop);
            let _ = other.rollback().await;
            result
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        signals.resume.notify_one();

        let response = request.await.unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR, "a deadlocked preview is never confirmed");
        assert!(response.headers().get("preference-applied").is_none());
        waiting.await.unwrap().unwrap();
        assert_eq!(MySql::count(&pool, "SELECT COUNT(*) FROM items WHERE id = 'retried'").await, 0, "the retry never ran");
    })
    .await;
}

/// Review finding 5 of docs/plans/data-stores.md: a preview whose future is dropped mid-handler (a client
/// that disconnects) rolls back and hands back its MySQL turn, so the next preview runs instead of waiting.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mysql_a_dropped_preview_rolls_back_and_releases_its_turn() {
    async fn stuck(State(state): State<AppState<MySql>>, db: Db<MySql>) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        insert(&mut conn, "dropped", "Preview").await?;
        state.signals.written.notify_one();
        std::future::pending::<()>().await;
        Ok(StatusCode::CREATED)
    }
    async fn quick(db: Db<MySql>) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        insert(&mut conn, "next", "Preview").await?;
        Ok(StatusCode::CREATED)
    }
    with_server::<MySql, _, _>(|pool| async move {
        let provider = SqlxProvider::new(pool.clone());
        let signals = Arc::new(Signals::default());
        let request = tokio::spawn(single_route(provider.clone(), pool.clone(), signals.clone(), stuck).oneshot(preview("/run")));
        signals.written.notified().await;
        request.abort();
        let _ = request.await;
        // A clone of the provider shares the turn the dropped preview held.
        let next = tokio::time::timeout(
            Duration::from_secs(10),
            single_route(provider, pool.clone(), Arc::default(), quick).oneshot(preview("/run")),
        )
        .await
        .expect("the next preview waited for a turn the dropped one never released")
        .unwrap();
        assert_eq!(next.status(), StatusCode::OK);
        assert_eq!(MySql::count(&pool, "SELECT COUNT(*) FROM items").await, 0, "the dropped preview rolled back");
    })
    .await;
}

/// MySQL upserts and replaces report what they did to the existing row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mysql_reports_upserts_replaces_and_generated_keys() {
    async fn handler(db: Db<MySql>) -> Result<StatusCode, DbError> {
        let mut conn = db.acquire().await?;
        conn.query("INSERT INTO counters (label) VALUES (:a), (:b)").bind("a", "x").bind("b", "y").execute().await?;
        conn.query("INSERT INTO items (id, name) VALUES (:id, :name) ON DUPLICATE KEY UPDATE name = :name")
            .bind("id", "seed")
            .bind("name", "Upserted")
            .execute()
            .await?;
        conn.query("REPLACE INTO items (id, name) VALUES (:id, :name)").bind("id", "seed").bind("name", "Replaced").execute().await?;
        Ok(StatusCode::OK)
    }
    with_server::<MySql, _, _>(|pool| async move {
        MySql::exec(&pool, "INSERT INTO items (id, name) VALUES ('seed', 'Original')").await;
        let bench = Sendproof::new(
            Config::builder("Tests")
                .environment("Development")
                .enable_in(["Development"])
                .provider(SqlxProvider::new(pool.clone()))
                .preview_operation("POST", "/upsert")
                .build()
                .unwrap(),
        );
        let app = bench.wrap(
            Router::new()
                .route("/upsert", post(handler))
                .bench_gate(&bench)
                .with_state(AppState { pool: pool.clone(), signals: Arc::default() }),
        );
        let envelope = json_body(app.oneshot(preview("/upsert")).await.unwrap()).await;
        let changes = envelope["changes"].as_array().unwrap();
        let summary: Vec<String> =
            changes.iter().map(|c| format!("{} {} {}", c["operation"].as_str().unwrap(), c["table"].as_str().unwrap(), c["key"])).collect();
        let first = changes[0]["key"]["id"].as_i64().expect("a generated key");
        assert_eq!(
            summary,
            [
                format!("insert counters {{\"id\":{first}}}"),
                format!("insert counters {{\"id\":{}}}", first + 1),
                r#"update items {"id":"seed"}"#.to_owned(),
                r#"delete items {"id":"seed"}"#.to_owned(),
                r#"insert items {"id":"seed"}"#.to_owned(),
            ]
        );
        assert_eq!(changes[2]["before"]["name"], "Original");
        assert_eq!(changes[2]["after"]["name"], "Upserted");
        assert_eq!(changes[4]["after"]["name"], "Replaced");
        assert_eq!(MySql::count(&pool, "SELECT COUNT(*) FROM counters").await, 0);
        assert_eq!(MySql::count(&pool, "SELECT COUNT(*) FROM items WHERE name = 'Original'").await, 1);
    })
    .await;
}
