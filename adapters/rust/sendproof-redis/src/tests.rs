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

#[test]
fn a_label_that_looks_like_a_connection_string_is_refused() {
    assert!(RedisStore::new().name("cache").is_ok());
    assert!(RedisStore::new().name("redis://:password@host:6379").is_err());
}
