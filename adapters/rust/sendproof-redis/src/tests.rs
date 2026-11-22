//! The guard against a recording fake connection: what is sent is exactly what the guard let through.

use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use redis::{Cmd, Pipeline, RedisFuture, Value, aio::ConnectionLike};
use sendproof_core::{
    capture::{self, Recorder},
    model::LogEntry,
};

use super::*;

/// Records the name of every command that reaches the "socket".
#[derive(Clone, Default)]
struct Wire(Arc<Mutex<Vec<String>>>);

impl Wire {
    fn sent(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

impl ConnectionLike for Wire {
    fn req_packed_command<'a>(&'a mut self, cmd: &'a Cmd) -> RedisFuture<'a, Value> {
        self.0.lock().unwrap().push(Command::of(cmd).name);
        Box::pin(async { Ok(Value::Okay) })
    }

    fn req_packed_commands<'a>(&'a mut self, pipeline: &'a Pipeline, _: usize, _: usize) -> RedisFuture<'a, Vec<Value>> {
        let names: Vec<String> = pipeline.cmd_iter().map(|cmd| Command::of(cmd).name).collect();
        self.0.lock().unwrap().extend(names.iter().cloned());
        // An atomic pipeline answers with the single reply of EXEC: an array of the queued replies.
        let replies =
            if pipeline.is_transaction() { vec![Value::Array(vec![Value::Okay; names.len()])] } else { vec![Value::Okay; names.len()] };
        Box::pin(async move { Ok(replies) })
    }

    fn get_db(&self) -> i64 {
        0
    }
}

fn preview() -> Arc<Recorder> {
    let recorder = Recorder::new_preview(Instant::now(), true);
    recorder.begin(true);
    recorder
}

fn guarded(store: &RedisStore, wire: &Wire) -> GuardedConnection<Wire> {
    store.detached().guard(wire.clone())
}

fn db_entries(logs: &[LogEntry]) -> Vec<(String, Option<String>, bool)> {
    logs.iter().filter_map(|log| log.db.as_ref()).map(|db| (db.operation.clone(), db.statement.clone(), db.blocked)).collect()
}

#[tokio::test]
async fn a_read_runs_and_is_logged_without_its_values() {
    let (wire, store, recorder) = (Wire::default(), RedisStore::new(), preview());
    capture::scope(recorder.clone(), async {
        let mut conn = guarded(&store, &wire);
        redis::cmd("GET").arg("counter:a").exec_async(&mut conn).await.unwrap();
    })
    .await;
    assert_eq!(wire.sent(), ["GET"]);
    assert!(recorder.blocked().is_none());
    assert_eq!(db_entries(&recorder.finish().logs), [("GET".into(), Some("GET counter:a".into()), false)]);
}

#[tokio::test]
async fn a_write_is_refused_before_any_byte_is_sent_and_marks_the_preview() {
    let (wire, store, recorder) = (Wire::default(), RedisStore::new(), preview());
    capture::scope(recorder.clone(), async {
        let mut conn = guarded(&store, &wire);
        let error = redis::cmd("INCR").arg("counter:a").exec_async(&mut conn).await.unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Client);
        // GETDEL looks like a read but deletes the key.
        assert!(redis::cmd("GETDEL").arg("counter:a").exec_async(&mut conn).await.is_err());
    })
    .await;
    assert!(wire.sent().is_empty(), "nothing reached the wire: {:?}", wire.sent());
    let blocked = recorder.blocked().expect("marked");
    assert_eq!((blocked.store.as_str(), blocked.operation.as_str()), ("redis", "INCR"), "the first write wins");
    assert_eq!(db_entries(&recorder.finish().logs).iter().filter(|(_, _, blocked)| *blocked).count(), 2);
}

#[tokio::test]
async fn a_pipeline_with_a_write_is_refused_as_a_whole() {
    let (wire, store, recorder) = (Wire::default(), RedisStore::new(), preview());
    capture::scope(recorder.clone(), async {
        let mut conn = guarded(&store, &wire);
        let mut pipe = redis::pipe();
        pipe.cmd("GET").arg("a").cmd("SET").arg("b").arg("1").cmd("GET").arg("c");
        assert!(pipe.exec_async(&mut conn).await.is_err());
        let mut atomic = redis::pipe();
        atomic.atomic().cmd("GET").arg("a").cmd("DEL").arg("b");
        assert!(atomic.exec_async(&mut conn).await.is_err());
    })
    .await;
    assert!(wire.sent().is_empty(), "no command of a refused pipeline, and no EXEC, is sent");
    assert_eq!(recorder.blocked().unwrap().operation, "SET");
}

#[tokio::test]
async fn a_read_only_pipeline_runs() {
    let (wire, store, recorder) = (Wire::default(), RedisStore::new(), preview());
    capture::scope(recorder.clone(), async {
        let mut conn = guarded(&store, &wire);
        let mut pipe = redis::pipe();
        pipe.atomic().cmd("GET").arg("a").cmd("MGET").arg("b").arg("c");
        pipe.exec_async(&mut conn).await.unwrap();
    })
    .await;
    assert_eq!(wire.sent(), ["GET", "MGET"]);
    assert!(recorder.blocked().is_none());
}

#[tokio::test]
async fn a_write_after_multi_discards_the_transaction() {
    let (wire, store, recorder) = (Wire::default(), RedisStore::new(), preview());
    capture::scope(recorder.clone(), async {
        let mut conn = guarded(&store, &wire);
        redis::cmd("MULTI").exec_async(&mut conn).await.unwrap();
        redis::cmd("GET").arg("a").exec_async(&mut conn).await.unwrap();
        assert!(redis::cmd("SET").arg("a").arg("1").exec_async(&mut conn).await.is_err());
    })
    .await;
    assert_eq!(wire.sent(), ["MULTI", "GET", "DISCARD"], "EXEC must never follow a refused write");
}

#[tokio::test]
async fn a_refused_pipeline_after_multi_discards_the_transaction() {
    let (wire, store, recorder) = (Wire::default(), RedisStore::new(), preview());
    capture::scope(recorder.clone(), async {
        let mut conn = guarded(&store, &wire);
        redis::cmd("MULTI").exec_async(&mut conn).await.unwrap();
        let mut pipe = redis::pipe();
        pipe.cmd("GET").arg("a").cmd("SET").arg("a").arg("1");
        assert!(pipe.exec_async(&mut conn).await.is_err());
    })
    .await;
    assert_eq!(wire.sent(), ["MULTI", "DISCARD"], "EXEC must never follow a refused write");
}

#[tokio::test]
async fn the_refusal_names_the_store_and_the_command() {
    let (wire, store, recorder) = (Wire::default(), RedisStore::new(), preview());
    let error =
        capture::scope(recorder, async { redis::cmd("INCR").arg("counter:a").exec_async(&mut guarded(&store, &wire)).await.unwrap_err() })
            .await;
    let message = error.to_string();
    assert!(message.contains("Redis") && message.contains("INCR"), "{message}");
}

#[tokio::test]
async fn the_store_hands_each_request_a_guarded_connection() {
    let (wire, recorder) = (Wire::default(), preview());
    let store = RedisStore::new().connection(wire.clone());
    capture::scope(recorder.clone(), async {
        // The handler never holds the raw connection: the extractor's handle supplies a guarded one.
        let mut conn = store.detached().connection();
        redis::cmd("GET").arg("a").exec_async(&mut conn).await.unwrap();
        assert!(redis::cmd("SET").arg("a").arg("1").exec_async(&mut conn).await.is_err());
    })
    .await;
    assert_eq!(wire.sent(), ["GET"]);
    assert_eq!(recorder.blocked().unwrap().operation, "SET");
}

#[tokio::test]
async fn session_commands_are_never_guarded_or_logged() {
    let (wire, store, recorder) = (Wire::default(), RedisStore::new(), preview());
    capture::scope(recorder.clone(), async {
        let mut conn = guarded(&store, &wire);
        for name in ["AUTH", "HELLO", "PING", "SELECT"] {
            redis::cmd(name).arg("bench_redis_local").exec_async(&mut conn).await.unwrap();
        }
        redis::cmd("MULTI").exec_async(&mut conn).await.unwrap();
    })
    .await;
    assert_eq!(wire.sent().len(), 5);
    assert!(db_entries(&recorder.finish().logs).is_empty(), "the password never reaches a capture");
}

#[tokio::test]
async fn writes_outside_a_preview_pass_and_are_logged_in_an_observed_send() {
    let (wire, store) = (Wire::default(), RedisStore::new());
    // No capture at all (an ordinary Send): untouched.
    redis::cmd("INCR").arg("k").exec_async(&mut guarded(&store, &wire)).await.unwrap();
    // Observed send: the write runs, and is traced.
    let observed = Recorder::new(Instant::now(), true);
    observed.begin(false);
    capture::scope(observed.clone(), async { redis::cmd("INCR").arg("k").exec_async(&mut guarded(&store, &wire)).await.unwrap() }).await;
    assert_eq!(wire.sent(), ["INCR", "INCR"]);
    assert!(observed.blocked().is_none());
    assert_eq!(db_entries(&observed.finish().logs), [("INCR".into(), Some("INCR k".into()), false)]);
}

#[tokio::test]
async fn a_host_declared_read_is_allowed_by_exact_name_only() {
    let (wire, recorder) = (Wire::default(), preview());
    let store = RedisStore::new().treat_as_read(["mymodule.get"]).unwrap();
    capture::scope(recorder.clone(), async {
        let mut conn = guarded(&store, &wire);
        redis::cmd("MYMODULE.GET").arg("k").exec_async(&mut conn).await.unwrap();
        assert!(redis::cmd("MYMODULE.SET").arg("k").exec_async(&mut conn).await.is_err());
    })
    .await;
    assert_eq!(wire.sent(), ["MYMODULE.GET"]);
    assert!(RedisStore::new().treat_as_read(["MYMODULE.*"]).is_err());
}

/// The negative test: without the guard the same write reaches the wire, which is what the
/// conformance checks (and the 409 assertions above) catch.
#[tokio::test]
async fn the_checks_fail_when_the_connection_is_not_guarded() {
    let (mut wire, recorder) = (Wire::default(), preview());
    capture::scope(recorder.clone(), async {
        redis::cmd("INCR").arg("counter:a").exec_async(&mut wire).await.unwrap();
    })
    .await;
    assert_eq!(wire.sent(), ["INCR"], "an unhooked connection writes during a Preview");
    assert!(recorder.blocked().is_none(), "and the Preview would be confirmed");
}

/// Runs a Preview of `POST /things` through the core pipeline, with `store` registered.
async fn run_preview<F: std::future::Future<Output = ()>>(store: &RedisStore, handler: F) -> sendproof_core::Reply {
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
async fn an_unattributed_write_while_a_preview_is_open_is_refused_before_it_is_sent() {
    let wire = Wire::default();
    let store = RedisStore::new().connection(wire.clone());
    let reply = run_preview(&store, async {
        // A spawned task has no request scope, like a connection used from background work: nothing can
        // say whose write it is, so it is the Preview's, and it is refused.
        let mut conn = store.detached().connection();
        let result = tokio::spawn(async move { redis::cmd("INCR").arg("counter:a").exec_async(&mut conn).await }).await.unwrap();
        assert!(result.is_err());
    })
    .await;
    assert!(wire.sent().is_empty(), "the write must not reach Redis: {:?}", wire.sent());
    assert_eq!(reply.status, 409, "{}", String::from_utf8_lossy(&reply.body));
}

/// A task the handler started keeps the Preview's context after the response. Once the Preview has
/// ended its writes are still refused, for as long as the process runs.
#[tokio::test]
async fn a_write_from_a_task_that_outlives_its_preview_is_still_refused() {
    let wire = Wire::default();
    let store = RedisStore::new().connection(wire.clone());
    let (release, released) = tokio::sync::oneshot::channel::<()>();
    let (finished, result) = tokio::sync::oneshot::channel();
    let reply = run_preview(&store, async {
        let mut conn = store.detached().connection();
        tokio::spawn(async move {
            released.await.ok();
            let outcome = redis::cmd("INCR").arg("counter:late").exec_async(&mut conn).await;
            let _ = finished.send(outcome);
        });
    })
    .await;
    assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
    release.send(()).unwrap();
    assert!(result.await.unwrap().is_err(), "the late write is refused");
    assert!(wire.sent().is_empty(), "the write must not reach Redis: {:?}", wire.sent());
}

#[tokio::test]
async fn a_detached_background_write_is_never_refused() {
    let wire = Wire::default();
    let store = RedisStore::new().connection(wire.clone());
    // The background worker's connection is made outside any Preview, so it carries no Preview's context.
    let mut conn = store.detached().connection();
    let reply = run_preview(&store, async {
        tokio::spawn(sendproof_core::detached(async move { redis::cmd("INCR").arg("counter:a").exec_async(&mut conn).await.unwrap() }))
            .await
            .unwrap();
    })
    .await;
    assert_eq!(wire.sent(), ["INCR"]);
    assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
}

#[test]
fn a_label_that_looks_like_a_connection_string_is_refused() {
    assert!(RedisStore::new().name("cache").is_ok());
    assert!(RedisStore::new().name("redis://:password@host:6379").is_err());
}

/// The guard against the compose Redis (`docker compose -f tests/conformance/compose.yml up -d --wait
/// redis`): every write path is refused before it reaches the server, proven by an independent read.
/// Skips, saying why, when Redis doesn't answer.
mod server {
    use std::time::Duration;

    use redis::{AsyncCommands, aio::MultiplexedConnection};

    use super::*;

    async fn connect() -> Option<MultiplexedConnection> {
        let url = std::env::var("BENCH_REDIS_SERVER_URL").unwrap_or_else(|_| "redis://:bench_redis_local@127.0.0.1:56379/".into());
        let attempt = async {
            let mut connection = redis::Client::open(url).ok()?.get_multiplexed_async_connection().await.ok()?;
            redis::cmd("PING").exec_async(&mut connection).await.ok()?;
            Some(connection)
        };
        let connection = tokio::time::timeout(Duration::from_secs(3), attempt).await.ok().flatten();
        if connection.is_none() {
            eprintln!("skipped: Redis isn't running (docker compose -f tests/conformance/compose.yml up -d --wait redis)");
        }
        connection
    }

    #[tokio::test]
    async fn no_write_path_reaches_the_server_during_a_preview() {
        let Some(mut reader) = connect().await else { return };
        let prefix = format!("sp_test_{}_{:?}:", std::process::id(), Instant::now());
        let key = |name: &str| format!("{prefix}{name}");
        reader.set::<_, _, ()>(key("seeded"), 1).await.unwrap();

        let recorder = preview();
        let store = RedisStore::new().connection(reader.clone());
        capture::scope(recorder.clone(), async {
            let mut conn = store.detached().connection();
            // Reads run.
            assert_eq!(conn.get::<_, i64>(key("seeded")).await.unwrap(), 1);
            // A single write.
            assert!(conn.incr::<_, _, i64>(key("seeded"), 1).await.is_err());
            // A pipeline and an atomic pipeline that each hold one write.
            assert!(redis::pipe().get(key("seeded")).set(key("piped"), 1).exec_async(&mut conn).await.is_err());
            assert!(redis::pipe().atomic().get(key("seeded")).set(key("atomic"), 1).exec_async(&mut conn).await.is_err());
            // A script that writes.
            let script = "return redis.call('SET', KEYS[1], '1')";
            assert!(redis::cmd("EVAL").arg(script).arg(1).arg(key("scripted")).exec_async(&mut conn).await.is_err());
            // A hand-sent MULTI with a queued write: DISCARD, and EXEC has nothing to run.
            redis::cmd("MULTI").exec_async(&mut conn).await.unwrap();
            assert!(redis::cmd("SET").arg(key("queued")).arg(1).exec_async(&mut conn).await.is_err());
            assert!(redis::cmd("EXEC").exec_async(&mut conn).await.is_err(), "no transaction is left open");
            // Publishing can't be recalled.
            assert!(conn.publish::<_, _, i64>(key("channel"), "message").await.is_err());
        })
        .await;
        assert_eq!(recorder.blocked().unwrap().operation, "INCRBY", "the first write is the one reported");

        // An independent read: nothing the Preview tried to write is there.
        assert_eq!(reader.get::<_, i64>(key("seeded")).await.unwrap(), 1);
        for name in ["piped", "atomic", "scripted", "queued"] {
            assert!(!reader.exists::<_, bool>(key(name)).await.unwrap(), "{name} reached the server");
        }
        reader.del::<_, ()>(key("seeded")).await.unwrap();
    }
}
