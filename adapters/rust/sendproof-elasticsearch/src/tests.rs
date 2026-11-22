//! The guard against a fake cluster that records every request that reaches it (what is sent is
//! exactly what the guard let through), for both engines, then the OpenSearch wrapper against the
//! compose OpenSearch (`docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d
//! --wait opensearch`), where every write path is refused before it reaches the cluster, proven by an
//! independent read. The server tests skip, saying why, when OpenSearch doesn't answer.

use std::sync::Mutex;

use sendproof_core::{
    capture::{self, Recorder},
    model::LogEntry,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use super::*;

/// A cluster that answers `{}` to everything and remembers each request: `METHOD path` and its body.
#[derive(Clone, Default)]
struct Wire(Arc<Mutex<Vec<(String, String)>>>);

impl Wire {
    fn sent(&self) -> Vec<String> {
        self.0.lock().unwrap().iter().map(|(request, _)| request.clone()).collect()
    }

    fn bodies(&self) -> Vec<String> {
        self.0.lock().unwrap().iter().map(|(_, body)| body.clone()).collect()
    }

    /// Starts listening on a free loopback port and returns the address.
    async fn serve(&self) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let wire = self.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let wire = wire.clone();
                tokio::spawn(async move {
                    let mut received = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let (head, length) = loop {
                        let Ok(read) = stream.read(&mut chunk).await else { return };
                        if read == 0 {
                            return;
                        }
                        received.extend_from_slice(&chunk[..read]);
                        if let Some(end) = received.windows(4).position(|window| window == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&received[..end]).into_owned();
                            let length = head
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .and_then(|value| value.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            break (head, (end + 4, length));
                        }
                    };
                    while received.len() < length.0 + length.1 {
                        let Ok(read) = stream.read(&mut chunk).await else { return };
                        if read == 0 {
                            break;
                        }
                        received.extend_from_slice(&chunk[..read]);
                    }
                    let request_line = head.lines().next().unwrap_or_default();
                    let mut parts = request_line.split(' ');
                    let request = format!("{} {}", parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
                    let body = String::from_utf8_lossy(&received[length.0..]).into_owned();
                    wire.0.lock().unwrap().push((request, body));
                    let _ = stream
                        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")
                        .await;
                });
            }
        });
        address
    }
}

fn preview() -> Arc<Recorder> {
    let recorder = Recorder::new_preview(Instant::now(), true);
    recorder.begin(true);
    recorder
}

fn db_entries(logs: &[LogEntry]) -> Vec<(String, Option<String>, Option<String>, bool)> {
    logs.iter()
        .filter_map(|log| log.db.as_ref())
        .map(|db| (db.operation.clone(), db.target.clone(), db.statement.clone(), db.blocked))
        .collect()
}

/// The tests every engine passes, run against `$Store` over the fake cluster.
macro_rules! engine_tests {
    ($module:ident, $feature:literal, $krate:ident, $Client:ident, $Store:ident, $Guarded:ident, $system:literal, $display:literal) => {
        #[cfg(feature = $feature)]
        mod $module {
            use $krate::http::{Method, headers::HeaderMap, request::JsonBody, transport::Transport};

            use super::*;

            fn client(address: &str) -> $krate::$Client {
                $krate::$Client::new(Transport::single_node(&format!("http://{address}")).unwrap())
            }

            /// Sends `body` as JSON with the guarded client of a detached handle.
            async fn send(
                guarded: &$Guarded,
                method: Method,
                path: &str,
                body: Option<serde_json::Value>,
            ) -> Result<$krate::http::response::Response, $krate::Error> {
                guarded.send(method, path, HeaderMap::new(), None::<&()>, body.map(JsonBody::new), None).await
            }

            #[tokio::test]
            async fn a_read_runs_and_is_logged_without_its_values() {
                let (wire, recorder) = (Wire::default(), preview());
                let store = $Store::new(client(&wire.serve().await));
                capture::scope(recorder.clone(), async {
                    let guarded = store.detached().client();
                    let reply = send(&guarded, Method::Post, "/articles/_search", Some(serde_json::json!({ "query": { "ids": { "values": ["seeded"] } }, "size": 1 }))).await.unwrap();
                    assert_eq!(reply.status_code().as_u16(), 200);
                })
                .await;
                assert_eq!(wire.sent(), ["POST /articles/_search"]);
                assert_eq!(wire.bodies(), [r#"{"query":{"ids":{"values":["seeded"]}},"size":1}"#], "the body reaches the cluster unchanged");
                assert!(recorder.blocked().is_none());
                assert_eq!(
                    db_entries(&recorder.finish().logs),
                    [("search".into(), Some("articles".into()), Some(r#"{"query":{"ids":{"values":["?"]}},"size":"?"}"#.into()), false)]
                );
            }

            #[tokio::test]
            async fn a_write_is_refused_before_anything_is_sent_and_marks_the_preview() {
                let (wire, recorder) = (Wire::default(), preview());
                let store = $Store::new(client(&wire.serve().await));
                capture::scope(recorder.clone(), async {
                    let guarded = store.detached().client();
                    let error = send(&guarded, Method::Post, "/articles/_update/1", Some(serde_json::json!({ "script": { "source": "ctx._source.views += 1" } })))
                        .await
                        .map(|_| ())
                        .unwrap_err();
                    let blocked = blocked_by(&error).expect("the error carries the refusal");
                    assert_eq!((blocked.store.as_str(), blocked.operation.as_str()), ($system, "update"));
                    assert!(error.to_string().contains($display), "{error}");
                    // Every other kind of write.
                    for (method, path) in [
                        (Method::Post, "/articles/_update_by_query?refresh=true"),
                        (Method::Post, "/articles/_delete_by_query"),
                        (Method::Post, "/_reindex"),
                        (Method::Post, "/_bulk"),
                        (Method::Put, "/articles/_bulk"),
                        (Method::Put, "/articles/_doc/1"),
                        (Method::Post, "/articles/_doc"),
                        (Method::Delete, "/articles/_doc/1"),
                        (Method::Put, "/articles"),
                        (Method::Delete, "/articles"),
                        (Method::Put, "/_scripts/bump"),
                        (Method::Post, "/_aliases"),
                        (Method::Post, "/articles/_future_endpoint"),
                    ] {
                        assert!(send(&guarded, method, path, None).await.is_err(), "{path}");
                    }
                })
                .await;
                assert!(wire.sent().is_empty(), "nothing reached the cluster: {:?}", wire.sent());
                let blocked = recorder.blocked().expect("marked");
                assert_eq!((blocked.store.as_str(), blocked.operation.as_str()), ($system, "update"), "the first write wins");
                assert_eq!(blocked.detail, concat!("Preview unavailable: this operation writes to ", $display));
                let entries = db_entries(&recorder.finish().logs);
                assert_eq!(entries.len(), 14);
                assert!(entries.iter().all(|entry| entry.3), "every refusal is logged as blocked");
            }

            #[tokio::test]
            async fn a_path_is_classified_as_the_client_will_send_it() {
                let (wire, recorder) = (Wire::default(), preview());
                let store = $Store::new(client(&wire.serve().await));
                capture::scope(recorder.clone(), async {
                    let guarded = store.detached().client();
                    // The client resolves the path as a URL: `\` is a `/`, dot segments go and the
                    // fragment is never sent, so each of these is a `_bulk` or an `_update`, not a search.
                    for path in ["/a\\..\\_bulk#/_search", "/a/../_bulk#/x/_search", "/a/%2e%2e/_bulk#/_search", "/articles/_update/1#/_search"] {
                        let error = send(&guarded, Method::Post, path, None).await.map(|_| ()).unwrap_err();
                        assert!(blocked_by(&error).is_some(), "{path}");
                    }
                    // A read with dot segments still reads.
                    send(&guarded, Method::Post, "/articles/./x/../_search#ignored", None).await.unwrap();
                })
                .await;
                assert_eq!(wire.sent(), ["POST /articles/_search"]);
                assert_eq!(recorder.blocked().map(|blocked| blocked.operation), Some("bulk".to_owned()));
            }

            #[tokio::test]
            async fn sql_is_a_read_only_when_it_is_one_select() {
                let (wire, recorder) = (Wire::default(), preview());
                let store = $Store::new(client(&wire.serve().await));
                capture::scope(recorder.clone(), async {
                    let guarded = store.detached().client();
                    send(&guarded, Method::Post, "/_plugins/_sql", Some(serde_json::json!({ "query": "SELECT * FROM articles WHERE title = 'seeded'" }))).await.unwrap();
                    assert!(send(&guarded, Method::Post, "/_plugins/_sql", Some(serde_json::json!({ "query": "DELETE FROM articles" }))).await.is_err());
                    assert!(send(&guarded, Method::Post, "/_sql", Some(serde_json::json!({ "query": "SELECT 1; DELETE FROM articles" }))).await.is_err());
                })
                .await;
                assert_eq!(wire.sent(), ["POST /_plugins/_sql"], "only the SELECT was sent");
                assert_eq!(wire.bodies(), [r#"{"query":"SELECT * FROM articles WHERE title = 'seeded'"}"#]);
                let entries = db_entries(&recorder.finish().logs);
                assert_eq!(entries[0].2.as_deref(), Some(r#"{"query":"?"}"#), "the statement shows no value");
            }

            #[tokio::test]
            async fn handles_are_session_state_and_not_logged() {
                let (wire, recorder) = (Wire::default(), preview());
                let store = $Store::new(client(&wire.serve().await));
                capture::scope(recorder.clone(), async {
                    let guarded = store.detached().client();
                    send(&guarded, Method::Post, "/articles/_pit?keep_alive=1m", None).await.unwrap();
                    send(&guarded, Method::Delete, "/_pit", Some(serde_json::json!({ "id": "x" }))).await.unwrap();
                    send(&guarded, Method::Delete, "/_search/scroll", Some(serde_json::json!({ "scroll_id": "x" }))).await.unwrap();
                })
                .await;
                assert_eq!(wire.sent().len(), 3);
                assert!(recorder.blocked().is_none());
                assert!(db_entries(&recorder.finish().logs).is_empty());
            }

            #[tokio::test]
            async fn writes_outside_a_preview_pass_and_are_logged_in_an_observed_send() {
                let wire = Wire::default();
                let store = $Store::new(client(&wire.serve().await));
                // No capture at all (an ordinary Send): untouched.
                send(&store.detached().client(), Method::Put, "/articles/_doc/1", Some(serde_json::json!({ "title": "x" }))).await.unwrap();
                let observed = Recorder::new(Instant::now(), true);
                observed.begin(false);
                capture::scope(observed.clone(), async {
                    send(&store.detached().client(), Method::Post, "/articles/_update/2", Some(serde_json::json!({ "doc": { "title": "Untitled" } }))).await.unwrap();
                })
                .await;
                assert_eq!(wire.sent(), ["PUT /articles/_doc/1", "POST /articles/_update/2"]);
                assert!(observed.blocked().is_none());
                assert_eq!(
                    db_entries(&observed.finish().logs),
                    [("update".into(), Some("articles".into()), Some(r#"{"doc":{"title":"?"}}"#.into()), false)]
                );
            }

            #[tokio::test]
            async fn a_host_declared_read_is_allowed_by_exact_name_only() {
                let (wire, recorder) = (Wire::default(), preview());
                let store = $Store::new(client(&wire.serve().await)).treat_as_read(["POST /{}/_future"]).unwrap();
                capture::scope(recorder.clone(), async {
                    let guarded = store.detached().client();
                    send(&guarded, Method::Post, "/articles/_future", None).await.unwrap();
                    assert!(send(&guarded, Method::Post, "/articles/_future2", None).await.is_err());
                })
                .await;
                assert_eq!(wire.sent(), ["POST /articles/_future"]);
                assert!($Store::new(client("127.0.0.1:1")).treat_as_read(["POST /*"]).is_err());
            }

            #[tokio::test]
            async fn a_cloned_client_stays_guarded() {
                let (wire, recorder) = (Wire::default(), preview());
                let store = $Store::new(client(&wire.serve().await));
                capture::scope(recorder.clone(), async {
                    let derived = store.detached().client().clone();
                    let again = store.detached().clone().client();
                    assert!(send(&derived, Method::Delete, "/articles/_doc/1", None).await.is_err());
                    assert!(send(&again, Method::Delete, "/articles/_doc/1", None).await.is_err());
                })
                .await;
                assert!(wire.sent().is_empty());
            }

            /// Takes each request's node in turn, like the clients' multi-node pools.
            #[derive(Debug, Clone)]
            struct TwoNodes {
                nodes: Vec<$krate::http::transport::Connection>,
                next: Arc<std::sync::atomic::AtomicUsize>,
            }

            impl $krate::http::transport::ConnectionPool for TwoNodes {
                fn next(&self) -> $krate::http::transport::Connection {
                    let at = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    self.nodes[at % self.nodes.len()].clone()
                }
            }

            /// The refusal happens above the client's connection pool: a refused write never asks the
            /// pool for a node, so it can't mark one dead, count as a failure, or shift the rotation.
            #[tokio::test]
            async fn a_refused_write_does_not_touch_the_connection_pool() {
                let (first, second, recorder) = (Wire::default(), Wire::default(), preview());
                let urls = [first.serve().await, second.serve().await].map(|address| format!("http://{address}").parse().unwrap());
                let pool = TwoNodes { nodes: urls.into_iter().map($krate::http::transport::Connection::new).collect(), next: Arc::default() };
                let transport = $krate::http::transport::TransportBuilder::new(pool).build().unwrap();
                let store = $Store::new($krate::$Client::new(transport));
                capture::scope(recorder.clone(), async {
                    let guarded = store.detached().client();
                    assert!(send(&guarded, Method::Post, "/articles/_update_by_query", None).await.is_err());
                    assert!(send(&guarded, Method::Put, "/articles/_doc/1", Some(serde_json::json!({ "title": "x" }))).await.is_err());
                    // The next reads still use the nodes in order, starting with the first.
                    send(&guarded, Method::Get, "/articles/_doc/a", None).await.unwrap();
                    send(&guarded, Method::Get, "/articles/_doc/b", None).await.unwrap();
                })
                .await;
                assert_eq!(first.sent(), ["GET /articles/_doc/a"], "the first node served the first read");
                assert_eq!(second.sent(), ["GET /articles/_doc/b"], "the second node served the second read");
                assert!(recorder.blocked().is_some());
            }

            /// The negative test: without the guard the same write reaches the cluster and the Preview is
            /// not marked, which is what the conformance checks and the 409 assertions catch.
            #[tokio::test]
            async fn the_checks_fail_when_the_client_is_not_guarded() {
                let (wire, recorder) = (Wire::default(), preview());
                let raw = client(&wire.serve().await);
                capture::scope(recorder.clone(), async {
                    raw.send(Method::Post, "/articles/_update/1", HeaderMap::new(), None::<&()>, Some(JsonBody::new(serde_json::json!({ "doc": {} }))), None)
                        .await
                        .unwrap();
                })
                .await;
                assert_eq!(wire.sent(), ["POST /articles/_update/1"], "an unhooked client writes during a Preview");
                assert!(recorder.blocked().is_none(), "and the Preview would be confirmed");
            }

            /// Runs a Preview of `POST /things` through the core pipeline, with `store` registered.
            async fn run_preview<F: std::future::Future<Output = ()>>(store: &$Store, handler: F) -> sendproof_core::Reply {
                use sendproof_core::{Core, Headers, Inner, PreviewState};
                let config = sendproof_core::Config::builder("Test")
                    .environment("Development")
                    .enable_in(["Development"])
                    .preview_operation("POST", "/things")
                    .data_store(store.clone())
                    .build()
                    .unwrap();
                let core = Core::new(config);
                let state = PreviewState::new(&core, Instant::now());
                state.enroll(&core, "POST", Some("/things"), &Headers::new()).await.expect("enrolled");
                capture::scope(state.recorder(), handler).await;
                state.complete();
                state.finish(Ok(Inner { status: 200, headers: Headers::new(), body: b"{}".to_vec() })).await
            }

            #[tokio::test]
            async fn a_swallowed_block_still_answers_409_with_the_problem_body() {
                let wire = Wire::default();
                let store = $Store::new(client(&wire.serve().await)).name("articles").unwrap();
                let reply = run_preview(&store, async {
                    // The handler ignores the error and answers 200: the mark decides.
                    let _ = send(&store.detached().client(), Method::Post, "/articles/_update_by_query", None).await;
                })
                .await;
                assert_eq!(reply.status, 409, "{}", String::from_utf8_lossy(&reply.body));
                let body = String::from_utf8_lossy(&reply.body).into_owned();
                assert!(body.contains(concat!("\"store\":\"", $system, "\"")) && body.contains("\"operation\":\"update_by_query\""), "{body}");
                assert!(wire.sent().is_empty());
            }

            #[tokio::test]
            async fn an_unattributed_write_while_a_preview_is_open_is_refused_before_it_is_sent() {
                let wire = Wire::default();
                let store = $Store::new(client(&wire.serve().await));
                let guarded = store.detached().client();
                let reply = run_preview(&store, async {
                    // A spawned task has no request scope, like a client's own background writer: nothing
                    // can say whose write it is, so it is the Preview's, and it is refused.
                    let error = tokio::spawn(async move {
                        send(&guarded, Method::Put, "/articles/_doc/orphan", Some(serde_json::json!({ "title": "x" }))).await.map(|_| ()).unwrap_err()
                    })
                    .await
                    .unwrap();
                    assert!(blocked_by(&error).is_some_and(|blocked| blocked.operation == "index"), "{error}");
                })
                .await;
                assert!(wire.sent().is_empty(), "the write must not reach the cluster: {:?}", wire.sent());
                assert_eq!(reply.status, 409, "{}", String::from_utf8_lossy(&reply.body));
            }

            /// A task the handler started keeps the Preview's context after the response. Once the Preview
            /// has ended its writes are still refused, for as long as the process runs.
            #[tokio::test]
            async fn a_write_from_a_task_that_outlives_its_preview_is_still_refused() {
                let wire = Wire::default();
                let store = $Store::new(client(&wire.serve().await));
                let (release, released) = tokio::sync::oneshot::channel::<()>();
                let (finished, result) = tokio::sync::oneshot::channel();
                let reply = run_preview(&store, async {
                    let guarded = store.detached().client();
                    tokio::spawn(async move {
                        released.await.ok();
                        let outcome = send(&guarded, Method::Put, "/articles/_doc/late", Some(serde_json::json!({ "title": "x" }))).await.map(|_| ());
                        let _ = finished.send(outcome);
                    });
                })
                .await;
                assert_eq!(reply.status, 200, "the Preview itself had written nothing: {}", String::from_utf8_lossy(&reply.body));
                release.send(()).unwrap();
                let error = result.await.unwrap().expect_err("the late write is refused");
                assert!(blocked_by(&error).is_some_and(|blocked| blocked.operation == "index"), "{error}");
                assert!(wire.sent().is_empty(), "the write must not reach the cluster: {:?}", wire.sent());
            }

            /// A bulk request is one `send`, refused on the caller's thread when it is made: there is no
            /// queue behind the guard whose send-time refusal a client could retry until it hangs.
            #[tokio::test]
            async fn a_bulk_request_is_refused_when_it_is_made() {
                let (wire, recorder) = (Wire::default(), preview());
                let store = $Store::new(client(&wire.serve().await));
                capture::scope(recorder.clone(), async {
                    let started = Instant::now();
                    let error = store
                        .detached()
                        .client()
                        .send(Method::Post, "/_bulk", HeaderMap::new(), None::<&()>, Some("{\"index\":{\"_index\":\"articles\"}}\n{\"title\":\"x\"}\n"), None)
                        .await
                        .map(|_| ())
                        .unwrap_err();
                    assert!(blocked_by(&error).is_some_and(|blocked| blocked.operation == "bulk"));
                    assert!(started.elapsed() < std::time::Duration::from_secs(1), "no retries");
                })
                .await;
                assert!(wire.sent().is_empty());
            }

            #[tokio::test]
            async fn a_detached_background_write_leaves_an_open_preview_confirmable() {
                let wire = Wire::default();
                let store = $Store::new(client(&wire.serve().await));
                let guarded = store.detached().client();
                let reply = run_preview(&store, async {
                    tokio::spawn(sendproof_core::detached(async move {
                        send(&guarded, Method::Put, "/articles/_doc/background", Some(serde_json::json!({ "title": "x" }))).await.unwrap()
                    }))
                    .await
                    .unwrap();
                })
                .await;
                assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
                assert_eq!(wire.sent(), ["PUT /articles/_doc/background"], "detached work is never refused");
            }
        }
    };
}

engine_tests!(
    elasticsearch_tests,
    "elasticsearch",
    elasticsearch,
    Elasticsearch,
    ElasticsearchStore,
    GuardedElasticsearch,
    "elasticsearch",
    "Elasticsearch"
);
engine_tests!(opensearch_tests, "opensearch", opensearch, OpenSearch, OpenSearchStore, GuardedOpenSearch, "opensearch", "OpenSearch");

#[test]
fn a_label_that_looks_like_a_url_is_refused() {
    use sendproof_core::stores::store_label;
    assert!(store_label("articles").is_ok());
    assert!(store_label("http://user:pass@localhost:9200").is_err());
}

#[test]
fn blocked_by_finds_the_refusal_through_the_error_chain() {
    let blocked = PreviewWriteBlocked { store: "opensearch".into(), operation: "update".into(), detail: "Preview unavailable".into() };
    let error = refusal(blocked.clone());
    assert_eq!(blocked_by(&error), Some(&blocked));
    assert_eq!(blocked_by(&io::Error::other("something else")), None);
}

/// The OpenSearch wrapper against the compose cluster.
#[cfg(feature = "opensearch")]
mod server {
    use std::time::Duration;

    use opensearch::http::{Method, headers::HeaderMap, request::JsonBody, transport::Transport};
    use serde_json::{Value, json};

    use super::*;

    fn raw() -> opensearch::OpenSearch {
        let url = std::env::var("BENCH_OPENSEARCH_SERVER_URL").unwrap_or_else(|_| "http://127.0.0.1:59200".into());
        opensearch::OpenSearch::new(Transport::single_node(&url).unwrap())
    }

    async fn call(client: &opensearch::OpenSearch, method: Method, path: &str, body: Option<Value>) -> (u16, Value) {
        let response = client.send(method, path, HeaderMap::new(), None::<&()>, body.map(JsonBody::new), None).await.unwrap();
        let status = response.status_code().as_u16();
        (status, response.json::<Value>().await.unwrap_or(Value::Null))
    }

    /// A fresh index holding one document, deleted when the test ends.
    struct Fixture {
        raw: opensearch::OpenSearch,
        index: String,
    }

    impl Fixture {
        async fn new() -> Option<Self> {
            let raw = raw();
            let ready = tokio::time::timeout(
                Duration::from_secs(5),
                raw.send(Method::Get, "/_cluster/health", HeaderMap::new(), None::<&()>, None::<&str>, None),
            )
            .await;
            if !matches!(ready, Ok(Ok(_))) {
                eprintln!(
                    "skipped: OpenSearch isn't running (docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait opensearch)"
                );
                return None;
            }
            // The clock alone isn't enough: tests start together and the clock's resolution is coarse.
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let index = format!(
                "sp_test_{}_{}_{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs()),
                COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            );
            let (status, body) = call(
                &raw,
                Method::Put,
                &index,
                Some(json!({ "mappings": { "properties": { "title": { "type": "keyword" }, "views": { "type": "integer" } } } })),
            )
            .await;
            assert_eq!(status, 200, "{body}");
            let (status, body) =
                call(&raw, Method::Put, &format!("/{index}/_doc/seeded?refresh=true"), Some(json!({ "title": "Seeded", "views": 3 })))
                    .await;
            assert_eq!(status, 201, "{body}");
            Some(Self { raw, index })
        }

        /// An independent read through the unguarded client.
        async fn article(&self, id: &str) -> Option<Value> {
            let (status, body) = call(&self.raw, Method::Get, &format!("/{}/_doc/{id}", self.index), None).await;
            (status == 200).then(|| body["_source"].clone())
        }

        async fn drop(self) {
            let _ = call(&self.raw, Method::Delete, &self.index, None).await;
        }
    }

    #[tokio::test]
    async fn no_write_path_reaches_the_cluster_during_a_preview() {
        let Some(fixture) = Fixture::new().await else { return };
        let store = OpenSearchStore::new(raw());
        let recorder = preview();
        let index = fixture.index.clone();
        capture::scope(recorder.clone(), async {
            let guarded = store.detached().client();
            let send = |method: Method, path: String, body: Option<Value>| {
                let guarded = guarded.clone();
                async move { guarded.send(method, &path, HeaderMap::new(), None::<&()>, body.map(JsonBody::new), None).await }
            };
            // A read sent as a POST runs.
            let reply = send(Method::Post, format!("/{index}/_search"), Some(json!({ "query": { "ids": { "values": ["seeded"] } }, "size": 1 }))).await.unwrap();
            let found: Value = reply.json().await.unwrap();
            assert_eq!(found["hits"]["hits"][0]["_source"]["title"], "Seeded");
            assert!(recorder.blocked().is_none());

            // An upsert-update, an update by query (a POST with a query, like a search), a bulk, a
            // document write, a delete, an index change.
            assert!(send(Method::Post, format!("/{index}/_update/blocked?refresh=true"), Some(json!({ "script": { "source": "ctx._source.views += params.step", "params": { "step": 1 } }, "upsert": { "title": "Untitled", "views": 1 } }))).await.is_err());
            assert!(send(Method::Post, format!("/{index}/_update_by_query?refresh=true"), Some(json!({ "query": { "ids": { "values": ["seeded"] } }, "script": { "source": "ctx._source.hidden = true" } }))).await.is_err());
            assert!(send(Method::Post, format!("/{index}/_delete_by_query?refresh=true"), Some(json!({ "query": { "match_all": {} } }))).await.is_err());
            assert!(send(Method::Post, "/_bulk?refresh=true".into(), None).await.is_err());
            assert!(send(Method::Put, format!("/{index}/_doc/indexed?refresh=true"), Some(json!({ "title": "x" }))).await.is_err());
            assert!(send(Method::Delete, format!("/{index}/_doc/seeded?refresh=true"), None).await.is_err());
            assert!(send(Method::Put, format!("/{index}/_mapping"), Some(json!({ "properties": { "extra": { "type": "keyword" } } }))).await.is_err());
            assert!(send(Method::Post, "/_plugins/_sql".into(), Some(json!({ "query": format!("DELETE FROM {index}") }))).await.is_err());
        })
        .await;
        assert_eq!(recorder.blocked().unwrap().operation, "update", "the first write is the one reported");

        // An independent read: nothing the Preview tried to write is there.
        assert_eq!(fixture.article("seeded").await, Some(json!({ "title": "Seeded", "views": 3 })));
        for id in ["blocked", "indexed"] {
            assert_eq!(fixture.article(id).await, None, "{id} reached the cluster");
        }
        fixture.drop().await;
    }

    #[tokio::test]
    async fn the_checks_fail_when_the_client_is_not_guarded() {
        let Some(fixture) = Fixture::new().await else { return };
        let recorder = preview();
        let index = fixture.index.clone();
        capture::scope(recorder.clone(), async {
            let (status, body) = call(
                &fixture.raw,
                Method::Put,
                &format!("/{index}/_doc/unguarded?refresh=true"),
                Some(json!({ "title": "x", "views": 1 })),
            )
            .await;
            assert_eq!(status, 201, "{body}");
        })
        .await;
        assert!(recorder.blocked().is_none(), "an unhooked client writes during a Preview and the Preview would be confirmed");
        assert_eq!(fixture.article("unguarded").await, Some(json!({ "title": "x", "views": 1 })));
        fixture.drop().await;
    }
}
