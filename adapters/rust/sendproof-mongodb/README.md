# sendproof-mongodb

MongoDB Preview and write guard for Sendproof. On a replica set or sharded cluster a Preview runs every command in **one transaction that is aborted after the handler** and reports the document changes (`preview` mode). On a standalone server the store runs in `guard` mode: reads run, the first write blocks the Preview (409).

The `mongodb` crate has no ambient session and no pre-send hook, so handlers use guarded handles:

```rust
let options = ClientOptions::parse(url).await?;
let store = MongoStore::builder(options, "catalog").name("catalog")?.build()?;   // installs command monitoring, then connects
// Config::builder(..).data_store(store.clone())

async fn create(mongo: Mongo, Json(item): Json<Item>) -> Result<StatusCode, StatusCode> {
    let items = mongo.collection::<Item>("items");           // the driver's API, session added during a Preview
    items.insert_one(&item).await.map_err(|_| StatusCode::CONFLICT)?;
    Ok(StatusCode::CREATED)
}
```

Features: `axum` (`Mongo` extractor, `MongoStore: FromRef<State>`) and `actix` (`web::Data<MongoStore>` in `app_data`).

* Every handle call in a Preview carries the Preview's session. Nothing is ever committed; the `before` image is read at the transaction's own snapshot time, so a concurrent commit by another request is never reported as a change.
* Commands MongoDB refuses inside a transaction (`$out`, `$merge` at any depth, an explicit `create`, `count`, `listCollections`, `drop`, ...) are blocked before sending, with the reason.
* **Tripwire:** command monitoring fails the Preview with 500 when a write reaches the server without the Preview's `lsid` and `autocommit: false`, or when any `commitTransaction` or `abortTransaction` does. A handler's own `commitTransaction` through a handle is refused before it is sent.
* A Preview keeps the mode it started in. A handler that outlives `preview_timeout` (50 s by default, below the server's 60 s) has its transaction aborted and the Preview answers 500; nothing after the abort can reach the data.
* A server the store can't reach when it checks the topology runs in `guard` mode with `UNREACHABLE_REASON` ("couldn't reach MongoDB to check whether it supports transactions"), not the standalone reason, and is asked again next time.
* The driver ignores a failed `abortTransaction`, and the server would keep the transaction and its locks until its 60-second lifetime limit. When no reply acknowledged the abort (the connection dropped), the store ends the transaction with `killSessions` on the Preview's session, retrying with backoff for up to 10 s, then logs a `tracing` warning with the session id. Nothing is committed either way.
* Concurrent MongoDB Previews of one document don't queue: a `WriteConflict` reaches the handler.

**Coverage:** only commands sent through the store's handles or its own client are covered. A second `Client`, or one created inside a handler, is neither guarded nor rolled back. A `Mongo` handle moved into a spawned task keeps its Preview; a write through `MongoStore::client()` from a spawned task can't be attributed to any request, so every open Preview answers 500. Use the handle there, and wrap background work that writes in `sendproof_core::detached`. See [the data-stores page](../data-stores.md).
