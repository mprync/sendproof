# sendproof-elasticsearch

Elasticsearch and OpenSearch write guard for Sendproof (`guard` mode). Neither engine can roll back, so a Preview reads the cluster normally and is stopped **before the first write is sent**. One crate covers the official `elasticsearch` and `opensearch` clients; both are on by default, and `default-features = false, features = ["opensearch"]` (or `"elasticsearch"`) keeps one.

```rust
let client = OpenSearch::new(Transport::single_node("http://127.0.0.1:9200")?);
let store = OpenSearchStore::new(client).name("articles")?; // register with Config::builder(..).data_store(store.clone())
// state: OpenSearchStore must be reachable from the handler (axum: `impl FromRef<AppState> for OpenSearchStore`)

async fn article(search: OpenSearch) -> Result<Json<Value>, StatusCode> {
    let reply = search.client()                              // the store's client, guarded
        .send(Method::Post, "/articles/_search", HeaderMap::new(), None::<&()>, Some(JsonBody::new(json!({ "size": 1 }))), None)
        .await.map_err(|_| StatusCode::CONFLICT)?;
    reply.json().await.map(Json).map_err(|_| StatusCode::BAD_GATEWAY)
}
```

Both clients send everything through one concrete `Transport` with no middleware, and the typed builders (`client.search()`) call it directly, so they can't be intercepted. The guard is a wrapper over the client's raw `send`: the store owns the client and hands out only `GuardedOpenSearch` / `GuardedElasticsearch`, whose `send` takes what the client's own does. **The typed builders aren't available through the guard**: no layer under them can see a request's method, path and body (the replaceable `ConnectionPool` only picks a node). Don't keep a second client for the typed API; its writes during a Preview are neither refused nor logged.

The `elasticsearch` crate is pinned to `=9.1.0-alpha.1`, because the official client ships only alpha releases; use that exact version in your application so the store takes your client. `opensearch` follows `2`.

Features: `axum` and `actix` (the `OpenSearch` and `Elasticsearch` handle extractors).

* A read (`GET`, `HEAD`, `POST .../_search`, `_count`, `_msearch`, a SQL `SELECT`, ...) runs and becomes a `Db` log entry with the index and the body's values replaced by `?`.
* The first write (`_bulk`, `_update_by_query`, `_delete_by_query`, `_reindex`, a document `PUT`/`POST`/`DELETE`, an index or alias change, SQL that isn't one read) is refused with a client error before anything is sent, marks the Preview blocked, and the Preview answers 409 even if the handler swallows the error. `blocked_by(&error)` finds the refusal.
* Point-in-time, scroll and SQL-cursor handles run and are not logged.
* Only the client given to the store is covered. A second client the application builds itself is not seen.

See [adapters/rust/data-stores.md](../data-stores.md) for the page that covers every store.
