//! The MongoDB binding against the compose replica set (`docker compose -f tests/conformance/compose.yml
//! up -d --wait mongodb`). Each test gets its own database, reads back through an independent client
//! (which shares nothing with the binding), and skips, saying why, when the service doesn't answer.

use std::{
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};

use mongodb::{
    Client,
    bson::{Document, doc},
    options::{ClientOptions, UpdateOptions},
};
use sendproof_core::{Config, Core, Failure, Headers, Inner, PreviewState, Reply, capture};
use serde_json::Value;

use super::*;

fn server() -> String {
    std::env::var("BENCH_MONGODB_SERVER_URL").unwrap_or_else(|_| "mongodb://127.0.0.1:57017/?directConnection=true".into())
}

struct Fixture {
    store: MongoStore,
    core: Arc<Core>,
    /// An independent client: the proof that a Preview left nothing behind.
    reader: Client,
    database: String,
}

/// Client options for the compose server, with the driver's default 30-second server selection.
async fn options() -> Option<ClientOptions> {
    ClientOptions::parse(server()).await.ok()
}

/// The engine's detection once the server has really answered it.
///
/// Detection keeps only a real answer: a `hello` that fails (a slow server, or one dropping new
/// connections while many suites share it) runs Previews in guard mode for now and is asked again
/// next time. Asking until it answers keeps a busy server from turning a test's Previews into
/// guard-mode blocks.
async fn detected(engine: &engine::Engine) -> engine::Detected {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let detected = engine.detect().await;
        if detected.reason != Some(UNREACHABLE_REASON) {
            return detected;
        }
        assert!(Instant::now() < deadline, "the compose MongoDB never answered detection");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// A fixture with its own database, or `None` (a skip) when MongoDB doesn't answer.
async fn fixture(timeout: Option<Duration>) -> Option<Fixture> {
    let options = options().await?;
    // Only the skip check is short. The store keeps the default: its detection `hello` is the first
    // command of a fresh client, which can take longer than 2 seconds on a loaded server.
    let mut probe = options.clone();
    probe.server_selection_timeout = Some(Duration::from_secs(2));
    let reader = Client::with_options(probe).ok()?;
    if reader.database("admin").run_command(doc! { "hello": 1 }).await.is_err() {
        eprintln!("skipped: MongoDB isn't running (docker compose -f tests/conformance/compose.yml up -d --wait mongodb)");
        return None;
    }
    let database = format!("sp_test_{}", uuid_like());
    let mut builder = MongoStore::builder(options, database.clone()).name("catalog").unwrap();
    if let Some(timeout) = timeout {
        builder = builder.preview_timeout(timeout);
    }
    let store = builder.build().unwrap();
    assert_eq!(detected(&store.engine).await.mode, preview::Mode::Preview, "the compose MongoDB is a replica set");
    let config = Config::builder("Test")
        .environment("Development")
        .enable_in(["Development"])
        .preview_operation("POST", "/things")
        .data_store(store.clone())
        .build()
        .unwrap();
    Some(Fixture { store, core: Core::new(config), reader, database })
}

/// A name no other test uses at the same time, in this process or another: the process id, the
/// time, and a counter. The clock alone isn't enough: macOS reports it in whole microseconds, so two
/// tests starting together got the same database, and one's seed, writes or cleanup broke the other.
fn uuid_like() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    format!("{:x}_{nanos:x}_{:x}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

#[test]
fn every_test_database_name_is_distinct() {
    // Generated back to back, as parallel tests do: the clock repeats, the names must not.
    let names: std::collections::HashSet<String> = (0..10_000).map(|_| uuid_like()).collect();
    assert_eq!(names.len(), 10_000);
}

impl Fixture {
    /// The documents of `documents` that match `filter`, read independently.
    async fn find(&self, filter: Document) -> Vec<Document> {
        use futures_util::TryStreamExt;
        self.reader.database(&self.database).collection::<Document>("documents").find(filter).await.unwrap().try_collect().await.unwrap()
    }

    async fn seed(&self, document: Document) {
        self.reader.database(&self.database).collection::<Document>("documents").insert_one(document).await.unwrap();
    }

    async fn cleanup(self) {
        let _ = self.reader.database(&self.database).drop().await;
    }

    /// Runs a Preview of `POST /things` whose handler is `handler`, and finishes it.
    async fn preview<F, Fut>(&self, handler: F) -> Reply
    where
        F: FnOnce(Mongo) -> Fut,
        Fut: Future<Output = u16>,
    {
        let state = PreviewState::new(&self.core, Instant::now());
        let enrollment = state.enroll(&self.core, "POST", Some("/things"), &Headers::new()).await.expect("enrolled");
        let mongo = self.store.from_enrollment(Some(&enrollment), true).unwrap();
        let result = capture::scope(state.recorder(), async move {
            let status = handler(mongo).await;
            Ok::<_, Failure>(Inner { status, headers: Headers::new(), body: br#"{"ok":true}"#.to_vec() })
        })
        .await;
        state.complete();
        state.finish(result).await
    }
}

macro_rules! fixture {
    ($timeout:expr) => {
        match fixture($timeout).await {
            Some(fixture) => fixture,
            None => return,
        }
    };
    () => {
        fixture!(None)
    };
}

fn json(reply: &Reply) -> Value {
    serde_json::from_slice(&reply.body).unwrap_or(Value::Null)
}

fn confirmed(reply: &Reply) -> bool {
    reply.headers.iter().any(|(name, value)| *name == "preference-applied" && value == "tx=rollback")
}

#[tokio::test]
async fn a_preview_reports_nested_changes_and_leaves_nothing_behind() {
    let fixture = fixture!();
    fixture.seed(doc! { "_id": "seeded", "name": "Seeded", "profile": { "city": "Leeds" }, "password_hash": "hashed:x" }).await;
    let reply = fixture
        .preview(|mongo| async move {
            let documents = mongo.collection::<Document>("documents");
            documents
                .insert_one(doc! { "_id": "new", "name": "Draft", "profile": { "city": "York" }, "password_hash": "hashed:secret" })
                .await
                .unwrap();
            let updated = documents
                .update_one(doc! { "_id": "seeded" }, doc! { "$set": { "name": "Renamed", "profile.city": "Hull" } })
                .await
                .unwrap();
            assert_eq!(updated.modified_count, 1);
            // Reads inside the Preview see its own writes.
            assert!(documents.find_one(doc! { "_id": "new" }).await.unwrap().is_some());
            201
        })
        .await;
    assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
    assert!(confirmed(&reply));
    let envelope = json(&reply);
    let changes = envelope["changes"].as_array().unwrap();
    let insert = changes.iter().find(|change| change["operation"] == "insert").expect("an insert");
    assert_eq!(
        (insert["store"].as_str(), insert["table"].as_str(), insert["namespace"].as_str()),
        (Some("mongodb"), Some("documents"), Some(fixture.database.as_str()))
    );
    assert_eq!(insert["key"], serde_json::json!({"_id": "new"}));
    assert_eq!(insert["before"], Value::Null);
    assert_eq!(insert["after"]["profile"], serde_json::json!({"city": "York"}), "nesting is kept");
    assert_eq!(insert["after"]["password_hash"], "[REDACTED]");
    let update = changes.iter().find(|change| change["operation"] == "update").expect("an update");
    assert_eq!((update["before"]["name"].as_str(), update["after"]["name"].as_str()), (Some("Seeded"), Some("Renamed")));
    assert_eq!((update["before"]["profile"]["city"].as_str(), update["after"]["profile"]["city"].as_str()), (Some("Leeds"), Some("Hull")));
    let db_entries: Vec<&Value> = envelope["logs"].as_array().unwrap().iter().filter(|log| log["level"] == "Db").collect();
    assert!(db_entries.iter().any(|log| log["db"]["operation"] == "insert" && log["db"]["target"] == "documents"));
    assert!(!envelope.to_string().contains("hashed:secret"), "a secret never appears");
    assert!(fixture.find(doc! { "_id": "new" }).await.is_empty(), "an independent read must not find the previewed insert");
    assert_eq!(fixture.find(doc! { "_id": "seeded" }).await[0].get_str("name"), Ok("Seeded"));
    fixture.cleanup().await;
}

#[tokio::test]
async fn upserts_and_replacements_say_how() {
    let fixture = fixture!();
    fixture.seed(doc! { "_id": "seeded", "name": "Seeded" }).await;
    let reply = fixture
        .preview(|mongo| async move {
            let documents = mongo.collection::<Document>("documents");
            documents
                .update_one_with(
                    doc! { "_id": "made" },
                    doc! { "$set": { "name": "Upserted" } },
                    UpdateOptions::builder().upsert(true).build(),
                )
                .await
                .unwrap();
            documents.replace_one(doc! { "_id": "seeded" }, doc! { "_id": "seeded", "name": "Replaced" }).await.unwrap();
            200
        })
        .await;
    let changes = json(&reply)["changes"].clone();
    let by = |operation: &str| changes.as_array().unwrap().iter().find(|change| change["operation"] == operation).cloned().unwrap();
    assert_eq!(by("insert")["via"], "upsert");
    assert_eq!(by("update")["via"], "replace");
    fixture.cleanup().await;
}

#[tokio::test]
async fn out_and_merge_are_blocked_before_sending_at_any_depth() {
    let fixture = fixture!();
    fixture.seed(doc! { "_id": "seeded", "name": "Seeded" }).await;
    for pipeline in [
        vec![doc! { "$match": {} }, doc! { "$out": "archive" }],
        vec![doc! { "$facet": { "x": [{ "$match": {} }, { "$merge": { "into": "archive" } }] } }],
    ] {
        let reply = fixture
            .preview(|mongo| {
                let pipeline = pipeline.clone();
                async move {
                    // The handler swallows the refusal and returns 200.
                    let _ = mongo.collection::<Document>("documents").aggregate(pipeline).await;
                    200
                }
            })
            .await;
        assert_eq!(reply.status, 409, "{}", String::from_utf8_lossy(&reply.body));
        let problem = json(&reply);
        assert_eq!(problem["store"], "mongodb");
        assert_eq!(problem["operation"], "aggregate");
        assert!(problem["detail"].as_str().unwrap().contains("$out") || problem["detail"].as_str().unwrap().contains("$merge"));
        assert!(!confirmed(&reply));
    }
    assert!(fixture.find(doc! {}).await.len() == 1);
    let collections = fixture.reader.database(&fixture.database).list_collection_names().await.unwrap();
    assert!(!collections.iter().any(|name| name == "archive"), "$out must not create the archive collection");
    fixture.cleanup().await;
}

#[tokio::test]
async fn an_explicit_create_and_count_are_blocked_before_sending() {
    let fixture = fixture!();
    let reply = fixture
        .preview(|mongo| async move {
            let _ = mongo.default_database().run_command(doc! { "create": "made" }).await;
            200
        })
        .await;
    assert_eq!(reply.status, 409);
    assert_eq!(json(&reply)["operation"], "create");
    let reply = fixture
        .preview(|mongo| async move {
            let _ = mongo.collection::<Document>("documents").estimated_document_count().await;
            200
        })
        .await;
    assert_eq!((reply.status, json(&reply)["operation"].as_str().map(str::to_owned)), (409, Some("count".into())));
    fixture.cleanup().await;
}

#[tokio::test]
async fn a_write_sent_without_the_preview_session_fails_the_preview_with_500() {
    let fixture = fixture!();
    let client = fixture.store.client().clone();
    let database = fixture.database.clone();
    let reply = fixture
        .preview(|_| async move {
            // Around the guarded handle: no session, so the write really happens. Monitoring sees it.
            client.database(&database).collection::<Document>("documents").insert_one(doc! { "_id": "escaped" }).await.unwrap();
            201
        })
        .await;
    assert_eq!(reply.status, 500, "{}", String::from_utf8_lossy(&reply.body));
    assert!(!confirmed(&reply), "a rollback is never claimed for a write that escaped");
    fixture.cleanup().await;
}

#[tokio::test]
async fn a_handler_commit_is_refused_before_it_is_sent_and_never_confirms() {
    let fixture = fixture!();
    let reply = fixture
        .preview(|mongo| async move {
            let documents = mongo.collection::<Document>("documents");
            documents.insert_one(doc! { "_id": "committed?" }).await.unwrap();
            let refused = mongo.database("admin").run_command(doc! { "commitTransaction": 1 }).await;
            assert!(refused.is_err(), "the commit never reaches the server");
            // The handler swallows the error and answers 200.
            201
        })
        .await;
    assert_eq!(reply.status, 500);
    assert!(!confirmed(&reply));
    assert!(fixture.find(doc! { "_id": "committed?" }).await.is_empty(), "nothing was committed");
    fixture.cleanup().await;
}

#[tokio::test]
async fn a_commit_that_reaches_the_server_by_another_path_trips_the_wire() {
    let fixture = fixture!();
    let client = fixture.store.client().clone();
    let reply = fixture
        .preview(|_| async move {
            // Through the raw client, which no handle guards: monitoring must catch it.
            let _ = client.database("admin").run_command(doc! { "commitTransaction": 1 }).await;
            200
        })
        .await;
    assert_eq!(reply.status, 500);
    fixture.cleanup().await;
}

#[tokio::test]
async fn before_images_come_from_the_transaction_start_not_from_later_commits_by_others() {
    let fixture = fixture!();
    fixture.seed(doc! { "_id": "seeded", "name": "Seeded" }).await;
    let (reader, database) = (fixture.reader.clone(), fixture.database.clone());
    let reply = fixture
        .preview(|mongo| async move {
            let documents = mongo.collection::<Document>("documents");
            // The first command pins the transaction's snapshot.
            documents.find_one(doc! { "_id": "seeded" }).await.unwrap();
            // Another request commits an insert after the snapshot.
            reader
                .database(&database)
                .collection::<Document>("documents")
                .insert_one(doc! { "_id": "concurrent", "name": "Not mine" })
                .await
                .unwrap();
            // The Preview's filter matches every document it can see: the majority-committed view would
            // also list the concurrent insert, and report it as a deletion.
            documents.update_many(doc! {}, doc! { "$set": { "touched": true } }).await.unwrap();
            200
        })
        .await;
    assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
    let changes = json(&reply)["changes"].clone();
    let changes = changes.as_array().unwrap();
    assert_eq!(changes.len(), 1, "only the seeded document changed: {changes:?}");
    assert_eq!((changes[0]["operation"].as_str(), changes[0]["key"]["_id"].as_str()), (Some("update"), Some("seeded")));
    assert!(!json(&reply).to_string().contains("Not mine"), "a document another request inserted must not appear as a change");
    // The concurrent insert is the other request's, and stays.
    assert_eq!(fixture.find(doc! { "_id": "concurrent" }).await.len(), 1);
    assert!(fixture.find(doc! { "touched": true }).await.is_empty());
    fixture.cleanup().await;
}

#[tokio::test]
async fn a_preview_keeps_the_mode_it_began_in() {
    let fixture = fixture!();
    // Detection "fails" for the start of this Preview: it begins in guard mode.
    fixture
        .store
        .engine
        .set_detected(engine::Detected { mode: preview::Mode::Guard, reason: Some(STANDALONE_REASON), monitored: true })
        .await;
    let store = fixture.store.clone();
    let reply = fixture
        .preview(|mongo| async move {
            // Detection now succeeds, but this Preview has no transaction: its write must still block.
            store.engine.set_detected(engine::Detected { mode: preview::Mode::Preview, reason: None, monitored: true }).await;
            let _ = mongo.collection::<Document>("documents").insert_one(doc! { "_id": "x" }).await;
            200
        })
        .await;
    assert_eq!(reply.status, 409, "a Preview that began in guard mode treats every write as blocked");
    assert!(fixture.find(doc! {}).await.is_empty());
    fixture.cleanup().await;
}

#[tokio::test]
async fn a_preview_that_outlives_its_time_limit_is_aborted_and_never_confirmed() {
    let fixture = fixture!(Some(Duration::from_millis(300)));
    let reply = fixture
        .preview(|mongo| async move {
            let documents = mongo.collection::<Document>("documents");
            documents.insert_one(doc! { "_id": "early" }).await.unwrap();
            tokio::time::sleep(Duration::from_millis(900)).await;
            // After the abort a command on the session would run outside any transaction and commit: refused instead.
            assert!(documents.insert_one(doc! { "_id": "late" }).await.is_err());
            200
        })
        .await;
    assert_eq!(reply.status, 500);
    assert!(!confirmed(&reply));
    assert!(fixture.find(doc! {}).await.is_empty(), "neither write reached the data");
    fixture.cleanup().await;
}

#[tokio::test]
async fn concurrent_previews_never_share_a_session() {
    let fixture = fixture!();
    let (a, b) = tokio::join!(
        fixture.preview(|mongo| async move {
            mongo.collection::<Document>("documents").insert_one(doc! { "_id": "a" }).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            201
        }),
        fixture.preview(|mongo| async move {
            mongo.collection::<Document>("documents").insert_one(doc! { "_id": "b" }).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            201
        }),
    );
    for (reply, mine, theirs) in [(&a, "a", "b"), (&b, "b", "a")] {
        assert_eq!(reply.status, 200);
        let text = json(reply)["changes"].to_string();
        assert!(text.contains(&format!("\"_id\":\"{mine}\"")) && !text.contains(&format!("\"_id\":\"{theirs}\"")), "{text}");
    }
    assert!(fixture.find(doc! {}).await.is_empty());
    fixture.cleanup().await;
}

#[tokio::test]
async fn a_call_from_a_task_the_handler_spawns_is_still_captured() {
    let fixture = fixture!();
    let reply = fixture
        .preview(|mongo| async move {
            // A spawned task has no task-local capture; the handle still carries the Preview session.
            tokio::spawn(async move { mongo.collection::<Document>("documents").insert_one(doc! { "_id": "spawned" }).await.unwrap() })
                .await
                .unwrap();
            201
        })
        .await;
    assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
    let envelope = json(&reply);
    assert!(envelope["changes"].to_string().contains("\"_id\":\"spawned\""), "the insert must be reported: {envelope}");
    assert!(envelope["logs"].as_array().unwrap().iter().any(|log| log["db"]["operation"] == "insert"), "and logged");
    assert!(fixture.find(doc! {}).await.is_empty());
    fixture.cleanup().await;
}

#[tokio::test]
async fn an_unattributed_write_while_a_preview_is_open_fails_it() {
    let fixture = fixture!();
    let (client, database) = (fixture.store.client().clone(), fixture.database.clone());
    let reply = fixture
        .preview(|_| async move {
            // A spawned task has no request scope: the write commits, and nothing can say whose it was.
            tokio::spawn(async move {
                client.database(&database).collection::<Document>("documents").insert_one(doc! { "_id": "unattributed" }).await.unwrap()
            })
            .await
            .unwrap();
            201
        })
        .await;
    assert_eq!(reply.status, 500, "{}", String::from_utf8_lossy(&reply.body));
    assert!(!confirmed(&reply));
    fixture.cleanup().await;
}

#[tokio::test]
async fn a_detached_background_write_leaves_an_open_preview_confirmable() {
    let fixture = fixture!();
    let (client, database) = (fixture.store.client().clone(), fixture.database.clone());
    let reply = fixture
        .preview(|_| async move {
            // A background worker marks its work detached: it is not part of any Preview.
            tokio::spawn(sendproof_core::detached(async move {
                client.database(&database).collection::<Document>("documents").insert_one(doc! { "_id": "worker" }).await.unwrap()
            }))
            .await
            .unwrap();
            201
        })
        .await;
    assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
    assert_eq!(fixture.find(doc! { "_id": "worker" }).await.len(), 1, "the worker's write is its own and commits");
    fixture.cleanup().await;
}

#[tokio::test]
async fn a_preview_dropped_before_it_finishes_aborts_its_transaction() {
    // A client that disconnects drops the Preview future: `finish` never runs.
    let fixture = fixture!(Some(Duration::from_secs(30)));
    fixture.seed(doc! { "_id": "seeded", "n": 0 }).await;
    {
        let state = PreviewState::new(&fixture.core, Instant::now());
        let enrollment = state.enroll(&fixture.core, "POST", Some("/things"), &Headers::new()).await.expect("enrolled");
        let mongo = fixture.store.from_enrollment(Some(&enrollment), true).unwrap();
        capture::scope(state.recorder(), async {
            mongo.collection::<Document>("documents").update_one(doc! { "_id": "seeded" }, doc! { "$inc": { "n": 1 } }).await.unwrap();
        })
        .await;
    }
    assert!(fixture.store.engine.shared.previews.lock().unwrap().is_empty(), "the Preview is no longer registered");
    // The transaction's write lock is released promptly, not when the 30-second time limit fires. (10
    // seconds, not less: the abort runs in a spawned task, which a loaded machine can delay.)
    let documents = fixture.reader.database(&fixture.database).collection::<Document>("documents");
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        documents.update_one(doc! { "_id": "seeded" }, doc! { "$inc": { "n": 10 } }).await
    })
    .await;
    assert!(matches!(result, Ok(Ok(_))), "the dropped Preview still holds its transaction: {result:?}");
    assert_eq!(fixture.find(doc! { "_id": "seeded" }).await[0].get_i32("n"), Ok(10), "nothing of the Preview was committed");
    fixture.cleanup().await;
}

/// A TCP proxy to the compose MongoDB that can cut every connection and refuse new ones: the network
/// failing in the middle of a Preview.
struct Proxy {
    address: std::net::SocketAddr,
    down: Arc<std::sync::atomic::AtomicBool>,
    links: Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl Proxy {
    async fn start() -> Self {
        let options = options().await.unwrap();
        let upstream = match &options.hosts[0] {
            mongodb::options::ServerAddress::Tcp { host, port } => format!("{host}:{}", port.unwrap_or(27017)),
            other => panic!("the proxy needs a TCP server address, not {other:?}"),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = Proxy { address: listener.local_addr().unwrap(), down: Arc::default(), links: Arc::default() };
        let (down, links) = (proxy.down.clone(), proxy.links.clone());
        tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                if down.load(std::sync::atomic::Ordering::SeqCst) {
                    continue; // Dropping the socket closes it.
                }
                let upstream = upstream.clone();
                links.lock().unwrap().push(tokio::spawn(async move {
                    if let Ok(mut server) = tokio::net::TcpStream::connect(upstream).await {
                        let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
                    }
                }));
            }
        });
        proxy
    }

    /// Closes every open connection and refuses new ones until [`Proxy::restore`].
    fn cut(&self) {
        self.down.store(true, std::sync::atomic::Ordering::SeqCst);
        self.links.lock().unwrap().drain(..).for_each(|link| link.abort());
    }

    fn restore(&self) {
        self.down.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[tokio::test]
async fn a_preview_dropped_while_the_connection_is_down_still_releases_its_locks() {
    let fixture = fixture!();
    fixture.seed(doc! { "_id": "seeded", "n": 0 }).await;
    let proxy = Arc::new(Proxy::start().await);
    // A store that reaches MongoDB only through the proxy, and gives up quickly when it can't: the
    // driver's own abort fails, and the driver hides that failure.
    let mut options = ClientOptions::parse(format!("mongodb://{}/?directConnection=true", proxy.address)).await.unwrap();
    options.server_selection_timeout = Some(Duration::from_secs(1));
    let store = MongoStore::builder(options, fixture.database.clone()).build().unwrap();
    detected(&store.engine).await;
    let core = Core::new(
        Config::builder("T")
            .environment("Development")
            .enable_in(["Development"])
            .preview_operation("POST", "/things")
            .data_store(store.clone())
            .build()
            .unwrap(),
    );
    {
        let state = PreviewState::new(&core, Instant::now());
        let enrollment = state.enroll(&core, "POST", Some("/things"), &Headers::new()).await.expect("enrolled");
        let mongo = store.from_enrollment(Some(&enrollment), true).unwrap();
        capture::scope(state.recorder(), async {
            mongo.collection::<Document>("documents").update_one(doc! { "_id": "seeded" }, doc! { "$inc": { "n": 1 } }).await.unwrap();
        })
        .await;
        // The client disconnects as the network fails: the Preview is dropped while MongoDB can't be reached.
        proxy.cut();
    }
    // The network comes back after 3 seconds, long after the driver gave up on its abort.
    let restorer = proxy.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        restorer.restore();
    });
    // Without retries the transaction holds its write lock until the server's 60-second lifetime limit.
    let documents = fixture.reader.database(&fixture.database).collection::<Document>("documents");
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        documents.update_one(doc! { "_id": "seeded" }, doc! { "$inc": { "n": 10 } }).await
    })
    .await;
    assert!(matches!(result, Ok(Ok(_))), "the dropped Preview still holds its transaction: {result:?}");
    assert_eq!(fixture.find(doc! { "_id": "seeded" }).await[0].get_i32("n"), Ok(10), "nothing of the Preview was committed");
    fixture.cleanup().await;
}

#[tokio::test]
async fn a_write_conflict_between_two_previews_reaches_the_handler() {
    let fixture = fixture!();
    fixture.seed(doc! { "_id": "seeded", "n": 0 }).await;
    let outcomes = tokio::join!(
        fixture.preview(|mongo| async move {
            let documents = mongo.collection::<Document>("documents");
            let first = documents.update_one(doc! { "_id": "seeded" }, doc! { "$inc": { "n": 1 } }).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            if first.is_ok() { 200 } else { 409 }
        }),
        fixture.preview(|mongo| async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let result = mongo.collection::<Document>("documents").update_one(doc! { "_id": "seeded" }, doc! { "$inc": { "n": 1 } }).await;
            match result {
                Ok(_) => 200,
                Err(error) => {
                    // The WriteConflict is the handler's to handle; MongoDB Previews don't queue.
                    assert!(
                        error.to_string().to_lowercase().contains("conflict") || error.contains_label("TransientTransactionError"),
                        "{error}"
                    );
                    409
                }
            }
        }),
    );
    // One of them hit the conflict; neither left anything behind.
    assert!(outcomes.0.status == 200 || outcomes.1.status == 200);
    assert_eq!(fixture.find(doc! { "_id": "seeded" }).await[0].get_i32("n"), Ok(0));
    fixture.cleanup().await;
}

#[tokio::test]
async fn observed_send_commits_once_and_traces_the_command() {
    let fixture = fixture!();
    let recorder = Recorder::new(Instant::now(), true);
    recorder.begin(false);
    let mongo = fixture.store.detached();
    capture::scope(recorder.clone(), async {
        mongo.collection::<Document>("documents").insert_one(doc! { "_id": "sent", "password_hash": "hashed:secret" }).await.unwrap()
    })
    .await;
    let logs = recorder.finish().logs;
    let inserts: Vec<_> = logs.iter().filter_map(|log| log.db.as_ref()).filter(|db| db.operation == "insert").collect();
    assert_eq!(inserts.len(), 1);
    assert_eq!(
        inserts[0].statement.as_deref().map(|statement| statement.contains("hashed:secret")),
        Some(false),
        "values never appear in a statement"
    );
    assert_eq!(fixture.find(doc! { "_id": "sent" }).await.len(), 1, "an observed send commits");
    fixture.cleanup().await;
}

#[test]
fn a_standalone_server_and_an_unreachable_one_give_different_reasons() {
    // A standalone `hello`: sessions, but no replica set name. It really can't run transactions.
    let standalone = engine::topology(&doc! { "isWritablePrimary": true, "maxWireVersion": 25, "logicalSessionTimeoutMinutes": 30 });
    assert_eq!((standalone.mode, standalone.reason), (preview::Mode::Guard, Some(STANDALONE_REASON)));
    let replica_set = engine::topology(&doc! { "isWritablePrimary": true, "setName": "rs0", "logicalSessionTimeoutMinutes": 30 });
    assert_eq!((replica_set.mode, replica_set.reason), (preview::Mode::Preview, None));
    // An unreachable server says only that it couldn't be asked.
    assert_ne!(STANDALONE_REASON, UNREACHABLE_REASON);
    assert!(UNREACHABLE_REASON.contains("couldn't reach MongoDB") && !UNREACHABLE_REASON.contains("doesn't support"));
}

#[tokio::test]
async fn an_unreachable_server_runs_in_guard_mode_says_so_and_blocks_writes() {
    // Nothing listens here: detection fails, so the store runs in guard mode, and says it couldn't
    // check rather than claiming the server lacks transactions.
    let mut options = ClientOptions::parse("mongodb://127.0.0.1:1/?directConnection=true").await.unwrap();
    options.server_selection_timeout = Some(Duration::from_millis(300));
    let store = MongoStore::builder(options, "catalog").build().unwrap();
    let description = store.describe().await;
    assert_eq!((description.mode, description.reason.as_deref()), (StoreMode::Guard, Some(UNREACHABLE_REASON)));
    let core = Core::new(
        Config::builder("T")
            .environment("Development")
            .enable_in(["Development"])
            .preview_operation("POST", "/things")
            .data_store(store.clone())
            .build()
            .unwrap(),
    );
    let state = PreviewState::new(&core, Instant::now());
    let enrollment = state.enroll(&core, "POST", Some("/things"), &Headers::new()).await.unwrap();
    let mongo = store.from_enrollment(Some(&enrollment), true).unwrap();
    capture::scope(state.recorder(), async {
        let error = mongo.collection::<Document>("documents").insert_one(doc! { "_id": 1 }).await.unwrap_err();
        assert!(error.get_custom::<sendproof_core::PreviewWriteBlocked>().is_some());
    })
    .await;
    state.complete();
    let reply = state.finish(Ok(Inner { status: 200, headers: Headers::new(), body: Vec::new() })).await;
    assert_eq!(reply.status, 409);
}

/// The negative test: a write through the raw client during a Preview is the only thing that stops a
/// false confirmation, and the handle is what stops it earlier. Without the handle there is no block.
#[tokio::test]
async fn the_checks_fail_when_the_handle_is_not_used() {
    let fixture = fixture!();
    let client = fixture.store.client().clone();
    let database = fixture.database.clone();
    let reply = fixture
        .preview(|_| async move {
            client.database(&database).collection::<Document>("documents").insert_one(doc! { "_id": "raw" }).await.unwrap();
            200
        })
        .await;
    assert_ne!(reply.status, 409, "no handle, no guard: only the tripwire (500) stops this");
    assert_eq!(reply.status, 500);
    fixture.cleanup().await;
}

#[test]
fn a_label_that_looks_like_a_connection_string_is_refused() {
    let options = ClientOptions::default();
    assert!(MongoStore::builder(options.clone(), "d").name("catalog").is_ok());
    assert!(MongoStore::builder(options, "d").name("mongodb://user:pass@host/").is_err());
}

/// The tripwire must be installed on the guarded client itself: its own detection `hello` has to reach
/// the monitor. A client without it can't see an escaped write, so it never begins a Preview.
#[tokio::test]
async fn a_client_whose_monitor_never_sees_its_own_hello_never_previews() {
    let fixture = fixture!();
    // The client of a store built around the builder: no command monitoring. The default server
    // selection timeout, so a slow `hello` under load isn't mistaken for a standalone server.
    let engine = engine::Engine::new(
        Client::with_options(options().await.unwrap()).unwrap(),
        fixture.database.clone(),
        preview::Shared::new(Default::default()),
        engine::DEFAULT_PREVIEW_TIMEOUT,
    );
    let store = MongoStore { engine, name: None };
    detected(&store.engine).await;
    let description = store.describe().await;
    assert_eq!(description.mode, StoreMode::Guard);
    assert_eq!(description.reason.as_deref(), Some(UNMONITORED_REASON));
    let core = Core::new(
        Config::builder("T")
            .environment("Development")
            .enable_in(["Development"])
            .preview_operation("POST", "/things")
            .data_store(store)
            .build()
            .unwrap(),
    );
    let state = PreviewState::new(&core, Instant::now());
    assert_eq!(state.enroll(&core, "POST", Some("/things"), &Headers::new()).await.err(), Some(500));
    // The fixture's own store proves its monitor and previews.
    assert_eq!(fixture.store.describe().await.mode, StoreMode::Preview);
    fixture.cleanup().await;
}
