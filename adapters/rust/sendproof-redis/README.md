# sendproof-redis

Redis write guard for Sendproof (`guard` mode). Redis can't roll back, so a Preview reads Redis normally and is stopped **before the first write is sent**.

```rust
let connection = redis::Client::open(url)?.get_multiplexed_async_connection().await?;
let store = RedisStore::new().connection(connection).name("cache")?; // register with Config::builder(..).data_store(store.clone())
// state: RedisStore must be reachable from the handler (axum: `impl FromRef<AppState> for RedisStore`)

async fn counter(redis: Redis) -> Result<Json<i64>, StatusCode> {
    let mut conn = redis.connection();                    // the store's connection, guarded
    redis::cmd("INCR").arg("counter:a").query_async(&mut conn).await.map(Json).map_err(|_| StatusCode::CONFLICT)
}
```

Features: `axum` (`Redis` extractor, `RedisStore: FromRef<State>`) and `actix` (`web::Data<RedisStore>` in `app_data`).

* A read runs and becomes a `Db` log entry (`SET session:42 ? ? ?`: name and keys only).
* The first write in a Preview is refused with a `RedisError` before it is packed, marks the Preview blocked, and the Preview answers 409 even if the handler swallows the error.
* A pipeline (also `atomic()`) is classified as a whole before the first command is written. A write after a hand-sent `MULTI` is followed by `DISCARD`.
* `AUTH`, `HELLO`, `PING`, `SELECT` and the other session commands are never guarded or logged.
* `treat_as_read(["MYMODULE.GET"])` declares host reads, by exact name. It is your statement that the command never writes.

A connection the store doesn't own (one checked out of a pool) is guarded with `redis.guard(connection)`.

**Coverage:** only connections from `Redis::connection` or passed through `Redis::guard` are covered, and Redis has no command monitoring to catch the rest. A connection used directly, a second client, a pub/sub connection or a raw socket is not guarded. See [the data-stores page](../data-stores.md).
