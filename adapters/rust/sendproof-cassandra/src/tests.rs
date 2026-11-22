//! The guard's decisions without a server, then the wrapper against the compose Cassandra
//! (`docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra`):
//! every write path is refused before it reaches the server, proven by an independent read. The
//! server tests skip, saying why, when Cassandra doesn't answer.

use std::time::Instant;

use sendproof_core::{
    capture::{self, Recorder},
    model::LogEntry,
};

use super::*;

fn preview() -> Arc<Recorder> {
    let recorder = Recorder::new_preview(Instant::now(), true);
    recorder.begin(true);
    recorder
}

fn hook(reads: &[&str]) -> Hook {
    Hook { scope: StoreScope::current(), reads: Arc::new(reads.iter().map(|name| (*name).to_owned()).collect()), open: OpenPreviews::new() }
}

fn db_entries(logs: &[LogEntry]) -> Vec<(String, Option<String>, Option<String>, bool)> {
    logs.iter()
        .filter_map(|log| log.db.as_ref())
        .map(|db| (db.operation.clone(), db.target.clone(), db.statement.clone(), db.blocked))
        .collect()
}

#[tokio::test]
async fn a_read_passes_and_is_logged_without_its_values() {
    let recorder = preview();
    capture::scope(recorder.clone(), async {
        let hook = hook(&[]);
        let pending = hook.check("SELECT id, status FROM tickets WHERE id = 'secret-id'").unwrap();
        hook.finish(pending, Some(Arc::new("ks".into())), Some(1), None);
    })
    .await;
    assert!(recorder.blocked().is_none());
    assert_eq!(
        db_entries(&recorder.finish().logs),
        [("SELECT".into(), Some("tickets".into()), Some("SELECT id, status FROM tickets WHERE id = ?".into()), false)]
    );
}

#[tokio::test]
async fn a_write_is_refused_and_marks_the_preview() {
    let recorder = preview();
    capture::scope(recorder.clone(), async {
        let hook = hook(&[]);
        for write in [
            "INSERT INTO tickets (id) VALUES (?)",
            "UPDATE tickets SET status = 'x' WHERE id = ? IF EXISTS",
            "DELETE FROM tickets WHERE id = ?",
            "TRUNCATE tickets",
            "DROP KEYSPACE ks",
            "SELECT * FROM t; DELETE FROM t WHERE id = 1",
            "BEGIN BATCH APPLY BATCH",
            "",
        ] {
            assert!(hook.check(write).is_err(), "{write}");
        }
    })
    .await;
    let blocked = recorder.blocked().expect("marked");
    assert_eq!((blocked.store.as_str(), blocked.operation.as_str()), ("cassandra", "INSERT"), "the first write wins");
    assert_eq!(blocked.detail, "Preview unavailable: this operation writes to Cassandra");
    let entries = db_entries(&recorder.finish().logs);
    assert_eq!(entries.len(), 8);
    assert!(entries.iter().all(|entry| entry.3), "every refusal is logged as blocked");
}

#[tokio::test]
async fn every_batch_is_refused_even_a_read_only_or_empty_one() {
    let recorder = preview();
    capture::scope(recorder.clone(), async {
        let hook = hook(&[]);
        assert!(hook.check_batch(&["SELECT * FROM t"]).is_err());
        assert!(hook.check_batch(&[]).is_err());
    })
    .await;
    assert_eq!(recorder.blocked().unwrap().operation, "BATCH");
}

#[tokio::test]
async fn use_and_describe_are_reads() {
    let recorder = preview();
    capture::scope(recorder.clone(), async {
        let hook = hook(&[]);
        assert!(hook.check("USE ks").is_ok());
        assert!(hook.check("DESCRIBE TABLES").is_ok());
        assert!(hook.check("LIST ROLES").is_ok());
    })
    .await;
    assert!(recorder.blocked().is_none());
}

#[tokio::test]
async fn writes_outside_a_preview_pass_and_are_logged_in_an_observed_send() {
    // No capture at all (an ordinary Send): untouched.
    assert!(hook(&[]).check("INSERT INTO t (id) VALUES (1)").is_ok());
    let observed = Recorder::new(Instant::now(), true);
    observed.begin(false);
    capture::scope(observed.clone(), async {
        let hook = hook(&[]);
        let pending = hook.check("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)").unwrap();
        hook.finish(pending, None, None, None);
    })
    .await;
    assert!(observed.blocked().is_none());
    assert_eq!(
        db_entries(&observed.finish().logs),
        [("INSERT".into(), Some("tickets".into()), Some("INSERT INTO tickets (id, status, hits) VALUES (?, ?, ?)".into()), false)]
    );
}

#[tokio::test]
async fn a_host_declared_read_is_allowed_by_exact_name_only() {
    let recorder = preview();
    capture::scope(recorder.clone(), async {
        let hook = hook(&["LIST CUSTOM"]);
        assert!(hook.check("LIST custom things").is_ok());
        assert!(hook.check("LIST CUSTOMER").is_err());
    })
    .await;
    assert!(exact_names(["LIST *"], str::to_ascii_uppercase).is_err());
}

/// The negative test: without the guard the same write goes through, which is what the conformance
/// checks and the 409 assertions catch. (The server module repeats it against the real server.)
#[tokio::test]
async fn the_checks_fail_when_nothing_guards_the_session() {
    let recorder = preview();
    capture::scope(recorder.clone(), async {
        // No hook runs, so nothing classifies the write and nothing marks the Preview.
    })
    .await;
    assert!(recorder.blocked().is_none(), "an unguarded write is not blocked, and the Preview would be confirmed");
}

#[test]
fn a_label_that_looks_like_a_connection_string_is_refused() {
    assert!(store_label("tickets").is_ok());
    assert!(store_label("cassandra://user:pass@host:9042").is_err());
    assert!(store_label("127.0.0.1:9042").is_err());
}

mod server {
    use std::time::Duration;

    use std::net::{SocketAddr, ToSocketAddrs};

    use scylla::{
        client::session_builder::SessionBuilder,
        errors::TranslationError,
        policies::address_translator::{AddressTranslator, UntranslatedPeer},
    };

    use super::*;

    /// A single published node: the address it advertises (a container IP) is not reachable from the
    /// host, so every peer is the contact point.
    struct Published(SocketAddr);

    #[async_trait::async_trait]
    impl AddressTranslator for Published {
        async fn translate_address(&self, _: &UntranslatedPeer) -> Result<SocketAddr, TranslationError> {
            Ok(self.0)
        }
    }

    async fn connect() -> Option<Arc<Session>> {
        let address = std::env::var("BENCH_CASSANDRA_SERVER").unwrap_or_else(|_| "127.0.0.1:59042".into());
        let published = address.to_socket_addrs().ok()?.next()?;
        let attempt = async { SessionBuilder::new().known_node(address).address_translator(Arc::new(Published(published))).build().await.ok() };
        let session = tokio::time::timeout(Duration::from_secs(20), attempt).await.ok().flatten();
        if session.is_none() {
            eprintln!("skipped: Cassandra isn't running (docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra)");
        }
        session.map(Arc::new)
    }

    /// A fresh keyspace with a `tickets` table, dropped when the test ends.
    struct Fixture {
        raw: Arc<Session>,
        keyspace: String,
    }

    impl Fixture {
        async fn new() -> Option<Self> {
            let raw = connect().await?;
            let keyspace = format!("sp_test_{}_{}", std::process::id(), unique_tag());
            raw.query_unpaged(
                format!("CREATE KEYSPACE {keyspace} WITH replication = {{'class': 'SimpleStrategy', 'replication_factor': 1}}"),
                (),
            )
            .await
            .unwrap();
            raw.use_keyspace(&keyspace, false).await.unwrap();
            raw.query_unpaged("CREATE TABLE tickets (id text PRIMARY KEY, status text, hits int)", ()).await.unwrap();
            raw.query_unpaged("INSERT INTO tickets (id, status, hits) VALUES ('seeded', 'open', 3)", ()).await.unwrap();
            Some(Self { raw, keyspace })
        }

        /// An independent read through the unguarded session.
        async fn ticket(&self, id: &str) -> Option<(String, i32)> {
            let result = self.raw.query_unpaged("SELECT status, hits FROM tickets WHERE id = ?", (id,)).await.unwrap();
            let rows = result.into_rows_result().unwrap();
            rows.rows::<(Option<String>, Option<i32>)>().unwrap().next().map(|row| {
                let (status, hits) = row.unwrap();
                (status.unwrap_or_default(), hits.unwrap_or_default())
            })
        }

        async fn drop(self) {
            let _ = self.raw.query_unpaged(format!("DROP KEYSPACE IF EXISTS {}", self.keyspace), ()).await;
        }
    }

    /// A number that differs between the tests of one process.
    fn unique_tag() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos())
    }

    #[tokio::test]
    async fn no_write_path_reaches_the_server_during_a_preview() {
        let Some(fixture) = Fixture::new().await else { return };
        let store = CassandraStore::new(fixture.raw.clone());
        let recorder = preview();
        capture::scope(recorder.clone(), async {
            let session = store.detached().session();
            // A read runs, unprepared and prepared (classified by the text it was prepared from).
            let read = session.query_unpaged("SELECT id, status, hits FROM tickets WHERE id = ?", ("seeded",)).await.unwrap();
            assert_eq!(read.into_rows_result().unwrap().rows_num(), 1);
            let select = session.prepare("SELECT id, status, hits FROM tickets WHERE id = ?").await.unwrap();
            assert_eq!(session.execute_unpaged(&select, ("seeded",)).await.unwrap().into_rows_result().unwrap().rows_num(), 1);
            assert!(recorder.blocked().is_none());

            // Unprepared writes, paged and unpaged.
            let error = session.query_unpaged("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)", ("blocked",)).await.unwrap_err();
            assert!(error.blocked().is_some_and(|blocked| blocked.operation == "INSERT"), "{error}");
            assert!(session.query_iter("INSERT INTO tickets (id) VALUES ('iter')", ()).await.is_err());
            assert!(session.query_single_page("DELETE FROM tickets WHERE id = 'seeded'", (), PagingState::start()).await.is_err());
            // A prepared write: the driver keeps the text, so the execution is classified as the write it is.
            let insert = session.prepare("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)").await.unwrap();
            assert!(session.execute_unpaged(&insert, ("prepared",)).await.is_err());
            assert!(session.execute_iter(insert.clone(), ("prepared-iter",)).await.is_err());
            let bound = insert.clone().bind(&("bound",)).unwrap();
            assert!(session.execute_bound_unpaged(&bound).await.is_err());
            // A lightweight transaction, even one whose condition fails.
            assert!(session.query_unpaged("UPDATE tickets SET status = 'x' WHERE id = 'seeded' IF status = 'nope'", ()).await.is_err());
            // A logged batch holding an LWT, and one that holds prepared statements, and an empty one.
            let mut batch = Batch::default();
            batch.append_statement("UPDATE tickets SET status = 'closed' WHERE id = 'seeded' IF EXISTS");
            assert!(session.batch(&batch, ((),)).await.is_err());
            let mut prepared_batch = Batch::default();
            prepared_batch.append_statement(insert.clone());
            assert!(session.batch(&prepared_batch, (("batched",),)).await.is_err());
            assert!(session.batch(&Batch::default(), Vec::<()>::new()).await.is_err());
            // DDL, and a second statement hidden behind a read.
            assert!(session.query_unpaged("CREATE TABLE sp_ddl (id text PRIMARY KEY)", ()).await.is_err());
            assert!(session.query_unpaged("SELECT * FROM tickets; DELETE FROM tickets WHERE id = 'seeded'", ()).await.is_err());
            assert!(session.query_unpaged("TRUNCATE tickets", ()).await.is_err());
        })
        .await;
        assert_eq!(recorder.blocked().unwrap().operation, "INSERT", "the first write is the one reported");

        // An independent read: nothing the Preview tried to write is there.
        assert_eq!(fixture.ticket("seeded").await, Some(("open".into(), 3)));
        for id in ["blocked", "iter", "prepared", "prepared-iter", "bound", "batched"] {
            assert_eq!(fixture.ticket(id).await, None, "{id} reached the server");
        }
        let tables = fixture.raw.query_unpaged("SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?", (&fixture.keyspace,)).await.unwrap();
        assert_eq!(tables.into_rows_result().unwrap().rows_num(), 1, "the DDL reached the server");
        fixture.drop().await;
    }

    /// The negative test against the real server: with the guard off, the same write lands.
    #[tokio::test]
    async fn the_checks_fail_when_the_session_is_not_guarded() {
        let Some(fixture) = Fixture::new().await else { return };
        let recorder = preview();
        capture::scope(recorder.clone(), async {
            fixture.raw.query_unpaged("INSERT INTO tickets (id, status, hits) VALUES ('unguarded', 'new', 1)", ()).await.unwrap();
        })
        .await;
        assert!(recorder.blocked().is_none(), "an unhooked session writes during a Preview and the Preview would be confirmed");
        assert_eq!(fixture.ticket("unguarded").await, Some(("new".into(), 1)));
        fixture.drop().await;
    }

    #[tokio::test]
    async fn writes_run_in_an_observed_send_and_are_logged_with_the_keyspace() {
        let Some(fixture) = Fixture::new().await else { return };
        let store = CassandraStore::new(fixture.raw.clone());
        let observed = Recorder::new(Instant::now(), true);
        observed.begin(false);
        capture::scope(observed.clone(), async {
            let session = store.detached().session();
            session.query_unpaged("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)", ("sent",)).await.unwrap();
            let mut batch = Batch::default();
            batch.append_statement("INSERT INTO tickets (id, status, hits) VALUES ('batched', 'new', 2)");
            session.batch(&batch, ((),)).await.unwrap();
        })
        .await;
        assert!(observed.blocked().is_none());
        assert_eq!(fixture.ticket("sent").await, Some(("new".into(), 1)));
        assert_eq!(fixture.ticket("batched").await, Some(("new".into(), 2)));
        let logs = observed.finish().logs;
        let dbs: Vec<_> = logs.iter().filter_map(|log| log.db.as_ref()).collect();
        assert_eq!(dbs.len(), 2);
        assert_eq!((dbs[0].operation.as_str(), dbs[0].target.as_deref(), dbs[0].namespace.as_deref()), ("INSERT", Some("tickets"), Some(fixture.keyspace.as_str())));
        assert_eq!(dbs[0].statement.as_deref(), Some("INSERT INTO tickets (id, status, hits) VALUES (?, ?, ?)"));
        assert_eq!((dbs[1].operation.as_str(), dbs[1].target.as_deref()), ("BATCH", Some("tickets")));
        fixture.drop().await;
    }

    /// Runs a Preview of `POST /things` through the core pipeline, with `store` registered.
    async fn run_preview<F: std::future::Future<Output = ()>>(store: &CassandraStore, handler: F) -> sendproof_core::Reply {
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
    async fn a_swallowed_block_still_answers_409() {
        let Some(fixture) = Fixture::new().await else { return };
        let store = CassandraStore::new(fixture.raw.clone());
        let reply = run_preview(&store, async {
            // The handler ignores the error and the response is 200: the mark decides.
            let _ = store.detached().session().query_unpaged("DELETE FROM tickets WHERE id = 'seeded'", ()).await;
        })
        .await;
        assert_eq!(reply.status, 409, "{}", String::from_utf8_lossy(&reply.body));
        let body = String::from_utf8_lossy(&reply.body).into_owned();
        assert!(body.contains("\"store\":\"cassandra\"") && body.contains("\"operation\":\"DELETE\""), "{body}");
        assert_eq!(fixture.ticket("seeded").await, Some(("open".into(), 3)));
        fixture.drop().await;
    }

    #[tokio::test]
    async fn an_unattributed_write_while_a_preview_is_open_fails_it() {
        let Some(fixture) = Fixture::new().await else { return };
        let store = CassandraStore::new(fixture.raw.clone());
        let session = store.detached().session();
        let reply = run_preview(&store, async {
            // A spawned task has no request scope: the write is sent, and nothing can say whose it was.
            tokio::spawn(async move { session.query_unpaged("INSERT INTO tickets (id, status, hits) VALUES ('orphan', 'new', 1)", ()).await.unwrap() })
                .await
                .unwrap();
        })
        .await;
        assert_eq!(reply.status, 500, "{}", String::from_utf8_lossy(&reply.body));
        fixture.drop().await;
    }

    #[tokio::test]
    async fn a_detached_background_write_leaves_an_open_preview_confirmable() {
        let Some(fixture) = Fixture::new().await else { return };
        let store = CassandraStore::new(fixture.raw.clone());
        let session = store.detached().session();
        let reply = run_preview(&store, async {
            tokio::spawn(sendproof_core::detached(async move {
                session.query_unpaged("INSERT INTO tickets (id, status, hits) VALUES ('background', 'new', 1)", ()).await.unwrap()
            }))
            .await
            .unwrap();
        })
        .await;
        assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
        fixture.drop().await;
    }
}
