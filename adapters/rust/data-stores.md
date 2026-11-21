# Data stores in the Rust binding

Sendproof Preview promises that a confirmed Preview never leaves a write behind. For SQL, the rollback provider guarantees it. For MongoDB, Redis and DynamoDB, the Rust binding hooks each store's client, following the rules in [spec/data-stores.md](../../spec/data-stores.md). It works the same in Axum and Actix Web.

| Store | Crate | Mode | What a Preview does |
| --- | --- | --- | --- |
| MongoDB replica set or sharded cluster | [`sendproof-mongodb`](sendproof-mongodb) | `preview` | Runs every command in one transaction, reports document changes, and aborts it. |
| MongoDB standalone server | [`sendproof-mongodb`](sendproof-mongodb) | `guard` | Runs reads. The first write stops the Preview. |
| Redis | [`sendproof-redis`](sendproof-redis) | `guard` | Runs reads. The first write stops the Preview. |
| DynamoDB | [`sendproof-dynamodb`](sendproof-dynamodb) | `guard` | Runs reads. The first write stops the Preview. |

Send and observed Send are never blocked. Their writes commit as usual, and an observed Send traces every store command as a `Db` log entry.

## Coverage: only hooked clients are covered

> [!WARNING]
> The binding covers a store only through the handles and interceptor below. Other clients are not covered: their writes are neither blocked nor rolled back. That includes a client created inside a handler, a second client for the same store, a Redis pub/sub connection, a Redis connection used without `Redis::connection` or `Redis::guard`, a DynamoDB client built without the interceptor, and a raw socket. Hook every client your handlers use, at startup.
>
> The guard finds the Preview through the request's handle (Redis and MongoDB) or the request's task-local capture (DynamoDB and the MongoDB command monitor). A handle moved into a task your handler spawns with `tokio::spawn` keeps its Preview (a guarded Redis connection, a `Mongo` handle). A spawned task doesn't inherit the task-local capture, so a DynamoDB call, or a write through `MongoStore::client()`, from such a task can't be attributed to any request. The DynamoDB interceptor and the MongoDB monitor treat a write they can't attribute as a possible Preview write that has already happened: **every Preview open on that store answers 500**. Every request the Axum and Actix adapters dispatch is attributed, so ordinary traffic never does this. Wrap background work that writes to a hooked store (job runners, scheduled tasks, fire-and-forget writes spawned from a handler) in `sendproof_axum::detached(...)` (or `sendproof_actix::detached`), which marks it as part of no Preview. Redis has no monitoring, so a raw Redis connection's writes are not seen at all.

## Register the stores

Build each store once at startup, add it to the configuration with `data_store`, and keep it where handlers can reach it.

```rust
use sendproof_axum::{Config, Sendproof};
use sendproof_dynamodb::DynamoStore;
use sendproof_mongodb::MongoStore;
use sendproof_redis::RedisStore;

let catalog = MongoStore::builder(mongodb::options::ClientOptions::parse(mongo_url).await?, "catalog")
    .name("catalog")?
    .build()?;                                   // installs command monitoring, then connects
let cache = RedisStore::new().connection(redis_connection).name("cache")?; // the store owns the connection
let orders = DynamoStore::new().name("orders")?;

let bench = Sendproof::new(
    Config::builder("Inventory")
        .environment("Development")
        .enable_in(["Development"])
        .provider(SqliteProvider::new(pool.clone()))            // optional: see below
        .data_store(catalog.clone())
        .data_store(cache.clone())
        .data_store(orders.clone())
        .preview_operation("POST", "/items")
        .preview_unavailable("DELETE", "/sessions/{id}", "Clears the Redis session")
        .build()?,
);
```

`name` is the label the workbench shows. It must be a display name such as `catalog`, never a URL, host name or credentials; a value that looks like one is refused with a `ConfigError`.

A SQL provider is optional when you register data stores. An app whose only database is MongoDB, or that has only Redis or DynamoDB, can Preview without one: MongoDB rolls back its own transaction and the guarded stores block writes. A SQL database you give no provider for is then not covered, like any unhooked client.

### MongoDB

`MongoStore::builder(options, default_database)` takes the `ClientOptions` **before** the client exists, installs a command event handler on them, and creates the client. The options must not already have a `command_event_handler`: the tripwire needs it. The `mongodb` crate has no ambient session and no pre-send hook, so handlers use guarded handles instead of the driver's types.

```rust
async fn create(mongo: Mongo, Json(item): Json<Item>) -> Result<StatusCode, StatusCode> {
    let items = mongo.collection::<Item>("items");   // the driver's methods, session added during a Preview
    items.insert_one(&item).await.map_err(|_| StatusCode::CONFLICT)?;
    Ok(StatusCode::CREATED)
}
```

`Mongo` is an extractor: in Axum implement `FromRef<AppState>` for `MongoStore` and enable the crate's `axum` feature; in Actix register `web::Data::new(store)` and enable `actix`. `mongo.database("name")`, `mongo.default_database()` and `mongo.collection::<T>("name")` return `MongoDatabase` and `MongoCollection<T>`, which have `find`, `find_one`, `insert_one`, `insert_many`, `update_one`, `update_many`, `replace_one`, `delete_one`, `delete_many`, `find_one_and_update`, `find_one_and_replace`, `find_one_and_delete`, `aggregate`, `count_documents`, `distinct`, `run_command` and a `_with` form taking the driver's options (`upsert`, `sort`, `limit`, `projection`). A method the handle doesn't list can't be reached, so a new driver feature can't slip past the guard.

- During a Preview every call passes the Preview's session, so the command carries its `lsid`, `txnNumber` and `autocommit: false`. Nothing is ever committed.
- A handler's own `commitTransaction` or `abortTransaction`, sent through `run_command`, is refused before it is sent and fails the Preview with 500, like a raw SQL `COMMIT`.
- **The tripwire.** Command monitoring sees every command the client sends. A write during a Preview without the Preview's `lsid` and `autocommit: false`, or any `commitTransaction` or `abortTransaction`, fails the Preview with 500: it can't be undone, so no rollback is claimed. This is what catches a write sent through `MongoStore::client()` or a client you built yourself from the same options.
- The tripwire proves it is on the guarded client itself: the store's own detection `hello` must reach its command monitor. A client whose monitor never saw it reports `guard` mode with "Preview unavailable: command monitoring isn't installed on this MongoDB client" and never begins a Preview (500).
- The topology is detected once with `hello`. Each Preview keeps the mode it started in, so a Preview that began in `guard` mode never has its writes treated as joining a transaction it never had.
- A Preview may hold its transaction for `preview_timeout`, 50 seconds by default (below MongoDB's 60-second transaction lifetime). A handler still running at the limit loses the transaction: later calls are refused, nothing can reach the data after the abort, and the Preview answers 500.
- `aggregate` is a write when a `$out` or `$merge` stage appears at any depth, including inside `$facet`, `$lookup` and `$unionWith`. MongoDB can't run these in a transaction, so a `preview`-mode Preview is blocked before sending, with the reason.

### Redis

`RedisStore::new().connection(connection)` is the store, and it owns the connection: any cloneable `redis::aio::ConnectionLike` (`MultiplexedConnection`, `ConnectionManager`, a cluster connection). The `Redis` extractor gives each request's handle (Axum: `FromRef<AppState>` for `RedisStore` and the `axum` feature; Actix: `web::Data::new(store)` and the `actix` feature), and `redis.connection()` returns the store's connection guarded. The guarded connection is itself a `ConnectionLike`, so `AsyncCommands` and `redis::cmd(..).query_async` work unchanged.

```rust
async fn counter(redis: Redis) -> Json<i64> {
    let mut conn = redis.connection();
    Json(redis::cmd("INCR").arg("counter:a").query_async(&mut conn).await.unwrap_or(0))
}
```

Redis has no command monitoring, so there is no tripwire behind the guard: a write through a raw connection during a Preview is not seen, and the Preview is confirmed. Give the connection to the store rather than keeping it in application state. A connection the store doesn't own, such as one checked out of a deadpool or bb8 pool, is guarded with `redis.guard(connection)`.

Pipelines, including `atomic()` ones, are classified as a whole before the first command is written, so a refused write sends no command of the batch and no `EXEC`. A write refused after a hand-sent `MULTI` is followed by `DISCARD`. Pub/sub connections are not covered.

### DynamoDB

`DynamoStore::interceptor()` is an AWS SDK `Intercept` implementation. Add it to the client's configuration: `aws_sdk_dynamodb::config::Builder::from(&sdk_config).interceptor(store.interceptor()).build()`. It runs after the request is serialized and before it is signed or transmitted, so credentials and signatures never reach a capture. It reads the operation from the request and the PartiQL statements from its JSON body, so it covers every operation of the client, and `PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`, `TransactWriteItems` and any PartiQL statement that isn't a `SELECT` are writes.

## Mark an operation `preview: false`

An operation you know writes to a guarded store, such as one that clears a Redis session, can be marked `preview: false`. The workbench then shows "Preview unavailable" with your reason before anyone tries, and a Preview of it is refused (409, never confirmed) without running the handler. Send still runs it. The binding never infers the mark; without it the operation is advertised and the guard decides at run time.

```rust
Config::builder("Inventory")
    .preview_unavailable("DELETE", "/sessions/{id}", "Clears the Redis session")
    // or name the stores it writes, so the workbench shows their marks:
    .preview_unavailable_for("DELETE", "/sessions/{id}", "Preview unavailable: this operation writes to Redis", ["redis"])
```

Register the route as usual. Declaring the same method and path with `preview_operation` is a `ConfigError`.

## What a blocked Preview returns

When the guard refuses a write, the command never reaches the store and the handler gets an error: a `RedisError` of kind `Client`, an SDK dispatch error, or a `mongodb::error::Error` whose `get_custom::<PreviewWriteBlocked>()` has the `store` and `operation`. The Preview then answers 409 with `application/problem+json`, whatever the handler made of the error:

```json
{ "type": "about:blank", "title": "Preview unavailable", "status": 409, "code": "preview_unavailable",
  "detail": "Preview unavailable: this operation writes to Redis", "store": "redis", "operation": "INCR", "rolledBack": false }
```

The SQL transaction rolls back as usual. A failed rollback or abort, a handler `COMMIT` or `commitTransaction`, or a write that escaped the MongoDB session answers 500 without confirmation instead. A handler that panics after a block still gets the 409.

In `preview` mode MongoDB blocks only what a transaction can't run, such as `$out`, `$merge`, `count`, `listCollections` or an explicit `create`, with a reason like "Preview unavailable: MongoDB can't run $out inside a transaction".

## Host-declared reads

Each store takes `treat_as_read`, a list of exact command names the guard should let through, such as a custom Redis module read:

```rust
RedisStore::new().treat_as_read(["MYMODULE.GET"])?
```

> [!WARNING]
> `treat_as_read` is your statement that the command never writes. The guard trusts it: a listed command that does write is not blocked, and its write happens during the Preview. Names match exactly, with no wildcards.

## MongoDB limits

These come from MongoDB's transaction limits; see [MongoDB in Preview](../../spec/data-stores.md#mongodb-in-preview).

- A Preview whose handler runs longer than `preview_timeout` fails with 500, and nothing is written.
- Two Previews that write the same document don't queue: the second gets a `WriteConflict`, and the handler decides what to answer. The Preview still rolls back.
- Keep a Preview under about 1,000 changed documents.
- Document `before` images are read at the Preview transaction's snapshot time, so a concurrent commit by another request never shows up as a change.
- An explicit `create` fails inside a Preview, because MongoDB refuses it in a transaction with snapshot read concern. Inserting into a new collection creates it and rolls back.
- The `rustls-tls` feature of the `mongodb` crate is always enabled by this crate; enable `dns-resolver` yourself for `mongodb+srv` URLs.

## Logs and redaction

Every store command in a Preview or observed-Send trace is a `Db` log entry with the store, operation, target, sanitized statement, rows and time. Statements never carry values: MongoDB statements keep field names and operators with every literal as `"?"`, Redis statements keep the command and key names (`SET session:42 ? ? ?`; commands the guard doesn't know show no keys), and DynamoDB statements are the PartiQL text with every inline string or number literal replaced by `?`. Session commands such as `AUTH` and `hello` are never logged.

Change records for MongoDB carry `store`, `namespace`, the collection as `table`, `{ _id }` as `key`, and whole nested documents as `before` and `after`. A field with a secret name, such as `password_hash` or `apiKey`, is `"[REDACTED]"` at any depth. `via` is `"upsert"` or `"replace"` when the change came from an upsert or a whole-document replacement.

## Tests

`cargo test --manifest-path adapters/rust/Cargo.toml --workspace` runs the store tests. The MongoDB tests use the compose replica set (`docker compose -f tests/conformance/compose.yml up -d --wait mongodb`) and skip, saying why, when it doesn't answer. The Redis and DynamoDB unit tests run against a recording fake connection and a recording HTTP client; each crate also has a test against its compose service (`redis`, `dynamodb`) that reads the store back independently after every refused write path, and skips when the service doesn't answer. The shared checks run with `node tests/conformance/run.mjs rust-axum rust-actix` and need `mongodb redis dynamodb` from the same compose file.
