# sendproof-cassandra

Cassandra write guard for Sendproof (`guard` mode). Cassandra can't roll back, so a Preview reads Cassandra normally and is stopped **before the first write is sent**. It works with the `scylla` driver, which also speaks to Apache Cassandra.

```rust
let session = SessionBuilder::new().known_node("127.0.0.1:9042").build().await?;
let store = CassandraStore::new(Arc::new(session)).name("tickets")?; // register with Config::builder(..).data_store(store.clone())
// state: CassandraStore must be reachable from the handler (axum: `impl FromRef<AppState> for CassandraStore`)

async fn ticket(cassandra: Cassandra) -> Result<Json<String>, StatusCode> {
    let session = cassandra.session();                    // the store's session, guarded
    session.query_unpaged("SELECT status FROM tickets WHERE id = ?", ("a",)).await.map(|_| Json("ok".into())).map_err(|_| StatusCode::CONFLICT)
}
```

The `Session` is a concrete struct with no pre-send hook, so the guard is a wrapper: the store owns the session and hands out only `GuardedSession`, which mirrors the driver's `query_*`, `execute_*`, `execute_bound_*`, `batch`, `prepare` and `use_keyspace`.

Features: `axum` (`Cassandra` extractor, `CassandraStore: FromRef<State>`) and `actix` (`web::Data<CassandraStore>` in `app_data`).

* A read (`SELECT`, `USE`, `DESCRIBE`, `LIST ...`) runs and becomes a `Db` log entry with every literal replaced by `?`.
* The first write is refused with `CassandraError::Blocked` before the driver is called, marks the Preview blocked, and the Preview answers 409 even if the handler swallows the error.
* Every batch is a write, even a read-only or empty one. A lightweight transaction is a write even when its condition fails. A prepared statement is classified by the text it was prepared from.
* Only the session given to the store is covered. A second `Session` the application builds itself is not seen.
* A node that advertises an address the client can't reach (a container IP) needs an `AddressTranslator` that maps it to the published port; the tests show one.

See [adapters/rust/data-stores.md](../data-stores.md) for the page that covers every store.
