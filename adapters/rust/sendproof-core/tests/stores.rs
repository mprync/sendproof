//! The data-store rules of `spec/data-stores.md` at the core: the embedded tables, the guard, the
//! pipeline order of a Preview and discovery.

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};

use http::Extensions;
use sendproof_core::{
    BoxError, BoxFuture, Changes, CommandKind, Config, Core, DataStore, Failure, Headers, Inner, PreviewProvider, PreviewSession,
    PreviewState, StoreDescription, StoreMode, StoreScope, capture,
    model::Change,
    protocol,
    stores::{OpenPreviews, tables},
};
use serde_json::{Value, json};

/// The shared table, read from the spec, must equal the generated copy.
fn spec(store: &str) -> Value {
    let path = format!("{}/../../../spec/data-stores/{store}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("the spec table")).unwrap()
}

#[test]
fn embedded_tables_match_the_spec() {
    for (store, embedded) in [
        ("redis", tables::REDIS),
        ("mongodb", tables::MONGODB),
        ("dynamodb", tables::DYNAMODB),
        ("cassandra", tables::CASSANDRA),
        ("elasticsearch", tables::ELASTICSEARCH),
    ] {
        let copy: Value = serde_json::from_str(embedded).unwrap();
        assert_eq!(copy, spec(store), "{store}: run `node adapters/rust/scripts/embed-store-tables.mjs`");
    }
}

/// How many sessions began, rolled back and closed.
#[derive(Default)]
struct Counts {
    rollbacks: AtomicUsize,
    closes: AtomicUsize,
}

struct FakeSession {
    counts: Arc<Counts>,
    fail_rollback: bool,
}

impl PreviewSession for FakeSession {
    fn rollback(&mut self) -> BoxFuture<'_, Result<(), BoxError>> {
        self.counts.rollbacks.fetch_add(1, Ordering::SeqCst);
        let fail = self.fail_rollback;
        Box::pin(async move { if fail { Err("abort failed".into()) } else { Ok(()) } })
    }

    fn changes(&mut self) -> Changes {
        Changes {
            changes: vec![Change {
                operation: "insert".into(),
                table: "documents".into(),
                store: Some("mongodb".into()),
                after: Some(json!({"_id": "a", "profile": {"password_hash": "x", "city": "York"}})),
                ..Change::default()
            }],
            truncated: false,
        }
    }

    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), BoxError>> {
        self.counts.closes.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

/// A `preview`-mode store whose session can be made to fail.
struct FakeStore {
    counts: Arc<Counts>,
    fail_rollback: bool,
}

impl DataStore for FakeStore {
    fn describe(&self) -> BoxFuture<'_, StoreDescription> {
        Box::pin(async {
            StoreDescription { system: "mongodb".into(), name: Some("catalog".into()), mode: StoreMode::Preview, reason: None }
        })
    }

    fn begin_preview<'a>(&'a self, _: &'a mut Extensions) -> BoxFuture<'a, Result<Option<Box<dyn PreviewSession>>, BoxError>> {
        let session = FakeSession { counts: self.counts.clone(), fail_rollback: self.fail_rollback };
        Box::pin(async move { Ok(Some(Box::new(session) as Box<dyn PreviewSession>)) })
    }
}

/// A guard-only store.
struct GuardStore;

impl DataStore for GuardStore {
    fn describe(&self) -> BoxFuture<'_, StoreDescription> {
        Box::pin(async {
            StoreDescription {
                system: "redis".into(),
                name: None,
                mode: StoreMode::Guard,
                reason: Some("Preview unavailable: test".into()),
            }
        })
    }
}

fn config(store: impl DataStore) -> Config {
    Config::builder("Test")
        .environment("Development")
        .enable_in(["Development"])
        .preview_operation("POST", "/things")
        .preview_unavailable_for("DELETE", "/things/{id}", "Preview unavailable: this operation writes to Redis", ["redis"])
        .data_store(store)
        .build()
        .unwrap()
}

fn handler_response(status: u16) -> Result<Inner, Failure> {
    Ok(Inner { status, headers: Headers::new(), body: br#"{"ok":true}"#.to_vec() })
}

/// Runs a Preview of `POST /things` whose handler is `handler`, then finishes it.
async fn run<F, Fut>(core: &Arc<Core>, handler: F) -> sendproof_core::Reply
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Inner, Failure>>,
{
    let state = PreviewState::new(core, Instant::now());
    state.enroll(core, "POST", Some("/things"), &Headers::new()).await.expect("enrolled");
    let result = capture::scope(state.recorder(), handler()).await;
    state.complete();
    state.finish(result).await
}

fn json_body(reply: &sendproof_core::Reply) -> Value {
    serde_json::from_slice(&reply.body).unwrap()
}

#[tokio::test]
async fn a_preview_without_a_sql_provider_confirms_and_reports_store_changes() {
    let counts = Arc::new(Counts::default());
    let core = Core::new(config(FakeStore { counts: counts.clone(), fail_rollback: false }));
    let reply = run(&core, || async { handler_response(201) }).await;
    assert_eq!(reply.status, 200);
    assert!(reply.headers.iter().any(|(name, value)| *name == "preference-applied" && value == "tx=rollback"));
    let envelope = json_body(&reply);
    assert_eq!(envelope["rolledBack"], true);
    let change = &envelope["changes"][0];
    assert_eq!(change["store"], "mongodb");
    assert_eq!(change["after"]["profile"]["password_hash"], "[REDACTED]", "secret fields are hidden at any depth");
    assert_eq!(change["after"]["profile"]["city"], "York");
    assert_eq!((counts.rollbacks.load(Ordering::SeqCst), counts.closes.load(Ordering::SeqCst)), (1, 1));
}

#[tokio::test]
async fn a_blocked_write_answers_409_even_when_the_handler_swallows_it_and_returns_200() {
    let counts = Arc::new(Counts::default());
    let core = Core::new(config(FakeStore { counts: counts.clone(), fail_rollback: false }));
    let reply = run(&core, || async {
        let refused = StoreScope::current().guard("redis", "INCR", CommandKind::Write, None);
        assert!(refused.is_err());
        // The handler catches the error and answers 200 anyway.
        handler_response(200)
    })
    .await;
    assert_eq!(reply.status, 409);
    assert!(reply.headers.iter().any(|(name, value)| *name == "content-type" && value == "application/problem+json"));
    assert!(reply.headers.iter().all(|(name, _)| *name != "preference-applied"), "a blocked Preview never claims a rollback");
    let problem = json_body(&reply);
    assert_eq!(problem["code"], "preview_unavailable");
    assert_eq!(problem["store"], "redis");
    assert_eq!(problem["operation"], "INCR");
    assert_eq!(problem["rolledBack"], false);
    assert_eq!(problem["detail"], "Preview unavailable: this operation writes to Redis");
    assert!(problem.get("changes").is_none() && problem.get("body").is_none(), "nothing the handler produced is returned");
    assert_eq!(counts.rollbacks.load(Ordering::SeqCst), 1, "the store transaction is still aborted");
}

#[tokio::test]
async fn a_handler_that_panics_after_a_block_still_gets_409() {
    let core = Core::new(config(GuardStore));
    let state = PreviewState::new(&core, Instant::now());
    state.enroll(&core, "POST", Some("/things"), &Headers::new()).await.unwrap();
    capture::scope(state.recorder(), async {
        let _ = StoreScope::current().guard("redis", "SET", CommandKind::Write, None);
    })
    .await;
    let reply = state.finish(Err(Failure::Error("the handler panicked".into()))).await;
    assert_eq!(reply.status, 409);
}

#[tokio::test]
async fn a_fault_outranks_a_block_and_withholds_confirmation() {
    let core = Core::new(config(FakeStore { counts: Arc::default(), fail_rollback: false }));
    let reply = run(&core, || async {
        let scope = StoreScope::current();
        let _ = scope.guard("redis", "INCR", CommandKind::Write, None);
        scope.refuse("a handler commitTransaction reached the server");
        handler_response(200)
    })
    .await;
    assert_eq!(reply.status, 500);
    assert!(reply.headers.iter().all(|(name, _)| *name != "preference-applied"));
}

#[tokio::test]
async fn a_failed_abort_answers_500_and_every_session_is_still_closed() {
    let counts = Arc::new(Counts::default());
    let core = Core::new(config(FakeStore { counts: counts.clone(), fail_rollback: true }));
    let reply = run(&core, || async { handler_response(201) }).await;
    assert_eq!(reply.status, 500);
    assert_eq!(counts.closes.load(Ordering::SeqCst), 1);
}

/// Every cleanup step runs: a store whose abort fails skips neither the SQL rollback nor the other
/// stores, and the Preview answers 500.
#[tokio::test]
async fn a_failed_abort_skips_no_other_rollback_or_close() {
    struct Sql(Arc<Counts>);
    impl PreviewProvider for Sql {
        fn begin_preview<'a>(&'a self, _: &'a mut Extensions) -> BoxFuture<'a, Result<Box<dyn PreviewSession>, BoxError>> {
            let session = FakeSession { counts: self.0.clone(), fail_rollback: false };
            Box::pin(async move { Ok(Box::new(session) as Box<dyn PreviewSession>) })
        }
    }
    let (sql, failing, other) = (Arc::new(Counts::default()), Arc::new(Counts::default()), Arc::new(Counts::default()));
    let config = Config::builder("Test")
        .environment("Development")
        .enable_in(["Development"])
        .preview_operation("POST", "/things")
        .provider(Sql(sql.clone()))
        .data_store(FakeStore { counts: failing.clone(), fail_rollback: true })
        .data_store(FakeStore { counts: other.clone(), fail_rollback: false })
        .build()
        .unwrap();
    let core = Core::new(config);
    let reply = run(&core, || async { handler_response(201) }).await;
    assert_eq!(reply.status, 500);
    for (name, counts) in [("SQL", &sql), ("failing store", &failing), ("other store", &other)] {
        assert_eq!(
            (counts.rollbacks.load(Ordering::SeqCst), counts.closes.load(Ordering::SeqCst)),
            (1, 1),
            "the {name} session was rolled back and closed"
        );
    }
}

/// The negative test: with the hook removed, the Preview is confirmed, so the shared checks that
/// expect a 409 would fail. This is what "the checks fail when the guard is off" means here.
#[tokio::test]
async fn without_the_guard_a_write_is_not_blocked() {
    let core = Core::new(config(GuardStore));
    let reply = run(&core, || async { handler_response(200) }).await;
    assert_eq!(reply.status, 200, "no guard call, no block");
}

#[tokio::test]
async fn a_held_step_keeps_guard_hooks_for_writes_outside_request_capture() {
    struct Tripwire(OpenPreviews);
    impl DataStore for Tripwire {
        fn describe(&self) -> BoxFuture<'_, StoreDescription> {
            GuardStore.describe()
        }

        fn begin_preview<'a>(&'a self, extensions: &'a mut Extensions) -> BoxFuture<'a, Result<Option<Box<dyn PreviewSession>>, BoxError>> {
            Box::pin(async { self.0.begin(extensions).map(Some) })
        }
    }
    let open = OpenPreviews::new();
    let core = Core::new(config(Tripwire(open.clone())));
    let mut headers = Headers::new();
    let opened = core.session_request("POST", "", &headers, &[]).await;
    assert_eq!(opened.status, 201);
    let session = json_body(&opened);
    headers.push(protocol::SESSION_HEADER, session["id"].as_str().unwrap());
    headers.push("prefer", "tx=rollback");
    let (_, state) = core.prepare_preview("POST", &headers, "/things", Instant::now()).await.unwrap();
    state.enroll(&core, "POST", Some("/things"), &headers).await.unwrap();
    // A task missing both its request and recorder must still be refused during this Preview.
    let blocked = open.block_unattributed(&StoreScope::current(), "redis", "SET", CommandKind::Write);
    assert!(blocked.is_err());
    state.complete();
    let blocked = state.finish(handler_response(200)).await;
    assert_eq!(json_body(&blocked)["code"], "preview_unavailable");
    assert_eq!(open.count(), 0);

    let (_, state) = core.prepare_preview("POST", &headers, "/things", Instant::now()).await.unwrap();
    state.enroll(&core, "POST", Some("/things"), &headers).await.unwrap();
    state.complete();
    let kept = state.finish(handler_response(200)).await;
    assert_eq!(json_body(&kept)["session"]["step"], 1);
    core.shutdown_sessions().await;
}

#[tokio::test]
async fn a_write_outside_a_preview_is_never_blocked() {
    assert!(StoreScope::current().guard("redis", "INCR", CommandKind::Write, None).is_ok());
}

#[tokio::test]
async fn discovery_lists_stores_marked_operations_and_the_binding() {
    struct Sqlite;
    impl PreviewProvider for Sqlite {
        fn database(&self) -> Option<String> {
            Some("fixture.db".into())
        }
        fn system(&self) -> Option<&'static str> {
            Some("sqlite")
        }
        fn begin_preview<'a>(&'a self, _: &'a mut Extensions) -> BoxFuture<'a, Result<Box<dyn PreviewSession>, BoxError>> {
            Box::pin(async { Err("unused".into()) })
        }
    }
    let config = Config::builder("Test")
        .enable_in(["Production"])
        .preview_operation("POST", "/things")
        .preview_unavailable_for("DELETE", "/things/{id}", "Preview unavailable: this operation writes to Redis", ["redis"])
        .data_store(GuardStore)
        .provider(Sqlite)
        .build()
        .unwrap();
    let stores = config.describe_stores().await;
    let document = protocol::capabilities(&config, None, &stores, "Axum");
    assert_eq!(document["binding"], json!({"language": "rust", "framework": "Axum"}));
    assert_eq!(document["database"], json!({"name": "fixture.db", "system": "sqlite"}));
    assert_eq!(document["dataStores"], json!([{"system": "redis", "mode": "guard", "reason": "Preview unavailable: test"}]));
    assert_eq!(document["previewOperations"], json!([{"method": "POST", "path": "/things"}]));
    assert_eq!(
        document["previewUnavailable"],
        json!([{"method": "DELETE", "path": "/things/{id}", "reason": "Preview unavailable: this operation writes to Redis", "stores": ["redis"]}])
    );
}

#[test]
fn an_operation_cannot_be_both_declared_and_marked_unavailable() {
    let config = Config::builder("Test").preview_operation("DELETE", "/x").preview_unavailable("DELETE", "/x", "No").build();
    assert!(config.is_err());
    assert!(Config::builder("Test").preview_unavailable("DELETE", "/x", " ").build().is_err());
    assert!(Config::builder("Test").preview_unavailable_for("DELETE", "/x", "No", ["Redis!"]).build().is_err());
}
