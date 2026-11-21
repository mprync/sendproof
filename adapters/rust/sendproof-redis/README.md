# sendproof-redis

Redis write guard for Sendproof (`guard` mode). Redis can't roll back, so a Preview reads Redis normally and is stopped **before the first write is sent**.

```rust
let store = RedisStore::new().name("cache")?;             // register with Config::builder(..).data_store(store.clone())
// state: RedisStore must be reachable from the handler (axum: `impl FromRef<AppState> for RedisStore`)

async fn counter(redis: Redis, State(app): State<App>) -> Result<Json<i64>, StatusCode> {
    let mut conn = redis.guard(app.redis.clone());        // any redis::aio::ConnectionLike
    redis::cmd("INCR").arg("counter:a").query_async(&mut conn).await.map(Json).map_err(|_| StatusCode::CONFLICT)
}
```

Features: `axum` (`Redis` extractor, `RedisStore: FromRef<State>`) and `actix` (`web::Data<RedisStore>` in `app_data`).

* A read runs and becomes a `Db` log entry (`SET session:42 ? ? ?`: name and keys only).
* The first write in a Preview is refused with a `RedisError` before it is packed, marks the Preview blocked, and the Preview answers 409 even if the handler swallows the error.
* A pipeline (also `atomic()`) is classified as a whole before the first command is written. A write after a hand-sent `MULTI` is followed by `DISCARD`.
* `AUTH`, `HELLO`, `PING`, `SELECT` and the other session commands are never guarded or logged.
* `treat_as_read(["MYMODULE.GET"])` declares host reads, by exact name. It is your statement that the command never writes.

**Coverage:** only connections passed through `Redis::guard` are covered. A connection used directly, a second client, a pub/sub connection or a raw socket is not guarded. See [the data-stores page](../data-stores.md).
