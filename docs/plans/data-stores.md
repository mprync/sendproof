# Plan: data stores in every binding

This plan takes MongoDB, Redis and DynamoDB (batch one), then Cassandra, Elasticsearch and OpenSearch, Cosmos DB and Firestore (batch two), to all eight bindings. The rules are in [spec/data-stores.md](../../spec/data-stores.md); this page says how each binding implements them and in what order.

**Status:** the foundation is done: the spec, the shared classification tables and vectors in `spec/data-stores/`, the conformance checks, the compose services, and a working reference in `tests/conformance/fixtures/data-stores-reference/`. Node is done for batch one (see [How the Node binding did it](#how-the-node-binding-did-it)); the other seven languages have not started. The batch-two foundation is done too; see [Work breakdown, batch two](#work-breakdown-batch-two).

## What the foundation gives each binding

| Piece | Where | How a binding uses it |
| --- | --- | --- |
| Rules | `spec/data-stores.md` | The behavior to implement. |
| Classification tables | `spec/data-stores/{redis,mongodb,dynamodb}.json`; batch two `{cassandra,elasticsearch,cosmosdb,firestore}.json` | Embed unchanged, or generate a source file from them at build time. A unit test fails when the copy differs. |
| Recorded requests | `spec/data-stores/recordings/{cosmosdb,firestore}.json` | Replay through the Cosmos DB and Firestore hooks over a fake transport (see its README). |
| Classification vectors | `spec/data-stores/classification-cases.json` | Run every case through the binding's classifier in its unit tests. |
| Reference guard | `tests/conformance/fixtures/data-stores-reference/guard.mjs` | Classification, the Preview scope's blocked mark, the Db log builder and redaction, in about 200 lines. |
| Reference hooks | `…/data-stores-reference/hooks.mjs` | What each store hook does, including MongoDB session injection and change capture. |
| Reference pipeline | `preview()` in `…/data-stores-reference/server.mjs` | The order of rollback, fault, block and confirmation. |
| Conformance | `tests/conformance/data-stores.mjs`, `shared-rules.mjs` | List `"stores"` and `"sharedRules"` on the manifest entry, add the fixture routes, run `node tests/conformance/run.mjs <id>`. |

## The shared core every binding adds

Each binding adds these once, in its core package, before any store hook:

1. **Classifier** for each store, driven by the embedded tables, passing the shared vectors.
2. **Preview scope fields:** `blocked` (first refused write: store, operation, detail) and `fault` (a transaction-control refusal), on the request-scoped capture the binding already has (`AsyncLocal`, `AsyncLocalStorage`, `ContextVar`, `ThreadLocal`, `context.Context`, `Thread.current`, the PHP recorder service, the Rust `task_local!`).
3. **`guard(store, operation, kind, detail?)`:** a no-op outside Preview; in Preview it records the block and throws the binding's `PreviewWriteBlocked` error. Every hook calls it before sending.
4. **Pipeline order** after the handler: abort `preview`-mode store transactions and roll back SQL; if any failed or a fault is recorded, answer 500 without confirmation; else if blocked, answer 409 with the problem body; else confirm.
5. **Discovery:** `dataStores` from the registered hooks; `previewUnavailable` from operations marked `preview: false`.
6. **Db log entries and change records** with the redaction rules, reusing the binding's existing `looksSecret` and redaction helpers, extended to nested documents.
7. **Transaction-control guard** in every SQL provider for the `raw-commit` rule, if the provider doesn't refuse `COMMIT` already.

## Client libraries and their hooks

Batch one supports the most-used client for each store in each language. "Native" means the library offers a documented pre-send hook. "Wrapper" means the binding hands the application a guarded handle with the same API. Items marked **spike** must be confirmed in the first hour of that language's work; the fallback is always a wrapper.

### Redis

| Language | Libraries | Hook |
| --- | --- | --- |
| Node | `ioredis`, `redis` (node-redis 4 and 5) | Wrap the instance's `sendCommand`, which every command, pipeline and `multi` passes through (**spike** for node-redis 5's pipeline path). |
| Python | `redis` (redis-py, including `redis.asyncio`), used by django-redis and Django's `RedisCache` | A `Connection` subclass passed as the pool's `connection_class`, overriding `pack_command`: every single and pipelined command is packed there before any byte is sent. |
| .NET | `StackExchange.Redis`, `Microsoft.Extensions.Caching.StackExchangeRedis` | Wrapper: an `IConnectionMultiplexer` decorator whose `GetDatabase` returns a `DispatchProxy` over `IDatabase`, mapping each method to its Redis command; `Execute` and `ExecuteAsync` classify their command name. For `RedisCache`, supply the decorator through `RedisCacheOptions.ConnectionMultiplexerFactory`. Note that `IDistributedCache.Get` with sliding expiration issues a write, which the guard correctly blocks. |
| Java | Spring Data Redis over Lettuce or Jedis; Jedis 5 directly | Spring: a `BeanPostProcessor` that decorates `RedisConnectionFactory` so `getConnection()` returns a guarded `RedisConnection` proxy. Jedis 5: a decorating `CommandExecutor` passed to `UnifiedJedis` (native). Raw Lettuce: wrap `StatefulRedisConnection.dispatch` (**spike**). |
| Kotlin | Same as Java | Same as Java. |
| Go | `github.com/redis/go-redis/v9`, `github.com/redis/rueidis` | Native: `redis.Hook` (`ProcessHook`, `ProcessPipelineHook`) returning an error; `rueidishook`. |
| PHP | Predis, phpredis through Laravel's Redis manager or Symfony Cache | Predis: a command processor (`Predis\Command\Processor\ProcessorInterface`), which runs before send, including pipelines (native). phpredis under Laravel: a connector registered with `Redis::extend` whose connection overrides `command()`; in a Preview, `pipeline()` and `transaction()` callbacks are treated as writes, because they reach the raw client. |
| Ruby | `redis` 5 and `redis-client`, used by Rails' `RedisCacheStore` and Sidekiq | Native: `RedisClient.register(middleware)` with `call` and `call_pipelined`. Sidekiq enqueues are writes and will block a Preview; document that hosts should record jobs as effects instead. |
| Rust | `redis` (redis-rs) with deadpool or bb8 | Wrapper: a type implementing `redis::aio::ConnectionLike` whose `req_packed_command` and `req_packed_commands` classify each `Cmd` before delegating. `fred` is out of scope for batch one. |

### DynamoDB

All AWS SDKs have native pre-send hooks.

| Language | Library | Hook |
| --- | --- | --- |
| Node | `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` | `client.middlewareStack.add(guard, { step: 'initialize' })`; the operation is `context.commandName` without the `Command` suffix. The document client shares the base client's stack. |
| Python | `boto3`, `aioboto3`, PynamoDB | `client.meta.events.register('before-call.dynamodb', handler)`; registering on the botocore session covers every client made from it, including PynamoDB's. |
| .NET | `AWSSDK.DynamoDBv2`, including `DynamoDBContext` | A `PipelineHandler` added through `RuntimePipelineCustomizerRegistry`; the operation comes from the request type. |
| Java and Kotlin | AWS SDK for Java v2, including the Enhanced Client | `ExecutionInterceptor.beforeExecution`, registered on the client's override configuration; the operation is `SdkExecutionAttribute.OPERATION_NAME`. |
| Go | `github.com/aws/aws-sdk-go-v2/service/dynamodb` | An `Initialize` middleware added through `APIOptions`; `awsmiddleware.GetOperationName(ctx)`. The request context carries the Preview state. |
| PHP | `aws/aws-sdk-php` | `$client->getHandlerList()->appendInit(...)`; the operation is `$command->getName()`. |
| Ruby | `aws-sdk-dynamodb`, Dynamoid | A Seahorse plugin adding a handler at `step: :initialize`; `context.operation_name`. |
| Rust | `aws-sdk-dynamodb` | An `Intercept` implementation whose `read_before_execution` returns an error; the operation name comes from the config bag's operation metadata. |

### MongoDB

No MongoDB driver offers a documented pre-send hook: command monitoring reports a command but can't stop it. So each binding's hook is a guarded handle that injects the Preview session, using the framework's own ambient session where one exists. Every binding also subscribes to command monitoring as a tripwire: a write during a Preview without the Preview's `lsid` fails the Preview with 500 (see [Commands that escape the session](../../spec/data-stores.md#commands-that-escape-the-session)).

| Language | Libraries | Session binding and guard |
| --- | --- | --- |
| Node | `mongodb` driver; Mongoose 8 | Driver: `mongoStore(client)` returns a guarded client whose `db()` and `collection()` return proxies that add `{ session }` from `AsyncLocalStorage` to every operation and refuse a foreign session. Mongoose: a global plugin whose `pre` middleware sets the Preview session on queries, documents, `aggregate` and `insertMany` (**spike**: confirm it covers `bulkWrite` and model statics). |
| Python | `pymongo` (sync and `AsyncMongoClient`); Beanie; MongoEngine | `wrap(client)` returns proxies adding `session=` from the `ContextVar`. Beanie takes the wrapped client in `init_beanie`. MongoEngine: `connect(mongo_client_class=GuardedMongoClient)` (**spike**). |
| .NET | `MongoDB.Driver`; `MongoDB.EntityFrameworkCore` | Driver: a decorator for the registered `IMongoClient` that returns `MongoCollectionBase<T>` subclasses routing each sessionless call to its session overload. EF Core provider: **spike** whether `Database.BeginTransaction()` is supported; if so, the existing `Sendproof.EntityFrameworkCore` provider covers it unchanged. |
| Java | Spring Data MongoDB; `mongodb-driver-sync` | Spring: the binding runs the Preview in a `TransactionTemplate` on `MongoTransactionManager`, marked rollback-only, so `MongoTemplate` and repositories join it natively. For guard mode, a `BeanPostProcessor` wraps `MongoDatabaseFactory` so collections are `java.lang.reflect.Proxy` guards. Plain driver: the same proxies over `MongoClient`. |
| Kotlin | `mongodb-driver-kotlin-coroutine` | Wrapper over `MongoDatabase` and `MongoCollection`, with the session in a coroutine context element. |
| Go | `go.mongodb.org/mongo-driver/v2` | `mongobench.Wrap(db)` returns `Database` and `Collection` wrappers with the driver's method set; in a Preview they call through `mongo.NewSessionContext(ctx, session)`. Handlers must pass `r.Context()`, as with the SQL wrapper today. |
| PHP | `mongodb/laravel-mongodb`; `mongodb/mongodb` | Laravel: the connection's `beginTransaction()` and `rollBack()` bind the session to its query builder, so the provider follows the existing Eloquent provider's shape. Guard mode and the plain library: a decorating `Collection` from a guarded `Client` factory. |
| Ruby | Mongoid 9; `mongo` driver | Mongoid: `Model.with_session` makes the session ambient for Mongoid operations on that client; the provider starts and aborts the transaction on it. Plain driver: a guarded client wrapper. |
| Rust | `mongodb` crate | A `Mongo` extractor, like the existing `Db<…>` extractor, whose methods pass the Preview session; there is no ambient session in the crate. |

Each MongoDB hook detects the topology with `hello` (see [Starting the transaction](../../spec/data-stores.md#starting-the-transaction)) and reports `guard` mode with its reason on a standalone server.

## Public API in each binding's style

Each binding adds one registration per store and one way to mark an operation `preview: false`. The names below are proposals that match each binding's existing style; per-language helpers may adjust spelling to fit, but not the shape.

### .NET

```csharp
builder.Services.AddSendproof()
    .WithApiName("Inventory")
    .AddEntityFrameworkCore<AppDbContext>()
    .AddMongoDB(mongo => mongo.WithName("catalog"))              // decorates the registered IMongoClient
    .AddRedis(redis => redis.WithName("cache").TreatAsRead("MYMODULE.GET"))
    .AddDynamoDB();                                               // pipeline handler on IAmazonDynamoDB

app.MapDelete("/sessions/{id}", Handler).WithSendproofPreview(enabled: false, reason: "Clears the Redis session");
// or [SendproofPreview(Enabled = false, Reason = "Clears the Redis session")]
```

### Node and TypeScript

```ts
const catalog = mongoStore(new MongoClient(url), { name: 'catalog' }); // handlers use catalog.client
const cache = redisStore(new Redis(redisUrl), { name: 'cache' });      // hooks the instance in place
const orders = dynamoStore(new DynamoDBClient({}));                    // adds middleware in place
const bench = sendproof({ previewProvider: drizzlePreview(db), dataStores: [catalog, cache, orders] });

bench.operation('POST', '/items', createItem);
bench.unavailable('DELETE', '/sessions/:id', { reason: 'Clears the Redis session', stores: ['redis'] }, deleteSession);
// NestJS: @SendproofPreview('DELETE', '/sessions/:id', { enabled: false, reason: '…' })
```

### Python

```python
bench = Sendproof(
    app,
    provider=SQLAlchemyPreview(engine, database="inventory_dev"),
    data_stores=[mongo_store(client, name="catalog"), redis_store(pool, name="cache"), dynamodb_store(boto_session)],
)

@app.delete("/sessions/{id}")
@preview(False, reason="Clears the Redis session")
def delete_session(id: str): ...
```

### Java (Spring Boot) and Kotlin (Ktor)

```java
@Bean Sendproof sendproof() {
  return Sendproof.builder().apiName("Inventory")
      .dataStore(MongoStore.springData().name("catalog"))   // auto-configured when Spring Data MongoDB is present
      .dataStore(RedisStore.spring().name("cache"))
      .dataStore(DynamoDbStore.interceptor())               // also exposed as an ExecutionInterceptor bean
      .build();
}

@SendproofPreview(enabled = false, reason = "Clears the Redis session")
@DeleteMapping("/sessions/{id}") void deleteSession(@PathVariable String id) { … }
```

```kotlin
install(Sendproof) {
  provider = JdbcPreviewProvider(PreviewDataSource(hikari)) { "inventory" }
  dataStores += MongoStore.coroutine(database, name = "catalog")
  dataStores += RedisStore.lettuce(connection, name = "cache")
}
sendproofPreview(enabled = false, reason = "Clears the Redis session") { delete("/sessions/{id}") { … } }
```

### Go

```go
catalog, _ := mongobench.Wrap(client.Database("catalog"), mongobench.WithName("catalog"))
rdb.AddHook(redisbench.Hook())                                         // go-redis v9
cfg.APIOptions = append(cfg.APIOptions, dynamobench.Middleware())      // aws-sdk-go-v2
bench, _ := sendproof.New(
    sendproof.WithProvider(db.Provider()),
    sendproof.WithDataStore(catalog.Store()), sendproof.WithDataStore(redisbench.Store("cache")),
    sendproof.WithDataStore(dynamobench.Store("orders")),
)
bench.HandlePreview(mux, "POST /items", createItem)
bench.HandleUnavailable(mux, "DELETE /sessions/{id}", "Clears the Redis session", deleteSession)
```

### PHP

```php
// config/sendproof.php (Laravel)
'data_stores' => [
    'mongodb' => ['connection' => 'mongodb', 'name' => 'catalog'],
    'redis' => ['connections' => ['default'], 'name' => 'cache'],
    'dynamodb' => ['clients' => [DynamoDbClient::class]],
],
Route::delete('/sessions/{id}', DeleteSession::class)->sendproofPreview(false, 'Clears the Redis session');
// Symfony: sendproof.data_stores in YAML; #[AllowPreview(false, reason: 'Clears the Redis session')]
```

### Ruby

```ruby
Rails.application.configure do
  config.sendproof.use Sendproof::ActiveRecord::Provider.new(database: "inventory_dev")
  config.sendproof.data_store Sendproof::Mongoid::Store.new(name: "catalog")
  config.sendproof.data_store Sendproof::Redis::Store.new(name: "cache")       # registers redis-client middleware
  config.sendproof.data_store Sendproof::DynamoDB::Store.new(name: "orders")   # adds the Seahorse plugin
end

class SessionsController < ApplicationController
  sendproof_preview only: %i[create update]
  sendproof_no_preview only: :destroy, reason: "Clears the Redis session"
end
```

### Rust

```rust
let bench = Sendproof::new(Config::builder("Inventory")
    .provider(PgProvider::new(pool))
    .data_store(MongoStore::new(client.database("catalog")).name("catalog"))   // handlers take a Mongo extractor
    .data_store(RedisStore::new(redis_pool).name("cache"))                      // handlers take a Redis extractor
    .data_store(DynamoStore::interceptor())                                     // add to the aws-sdk config
    .preview_operation("POST", "/items")
    .preview_unavailable("DELETE", "/sessions/{id}", "Clears the Redis session")
    .build()?);
```

## Work breakdown, batch one

One helper per language, in this order. Node goes first because it can lift the reference almost directly and sets the patterns the rest copy; the other seven can then run in parallel. A pattern-following brief suits Sonnet. The MongoDB transaction and escape-tripwire parts are safety-critical, so an Opus review gates each language before merge.

| Order | Language | Also covers | Notes |
| --- | --- | --- | --- |
| 1 | Node | Express, Fastify, Hono, NestJS | Lift `guard.mjs` into `core`; ioredis, node-redis, AWS SDK v3, driver and Mongoose. |
| 2 | Go | net/http, chi, gin, echo, GORM | Native Redis and AWS hooks; Mongo wrapper. |
| 2 | Python | FastAPI, Django, Flask | `contextvars` crosses `run_in_thread`; check async and sync clients both. |
| 2 | .NET | ASP.NET Core | The EF MongoDB spike first. |
| 2 | Java and Kotlin | Spring, Ktor | Spring Data transaction manager path first. |
| 2 | Ruby | Rails | Mongoid path first. |
| 2 | PHP | Laravel, Symfony | Laravel MongoDB path first; check the Predis processor. |
| 2 | Rust | axum, actix | Extractors, like the SQL ones. |

Each language's work, in order:

1. Core: classifier, embedded tables with a parity test, the shared vectors, scope fields, the guard, the pipeline order, the 409 response, discovery fields and the `preview: false` mark.
2. Transaction-control guard in each SQL provider and the two shared-rule fixture routes.
3. Redis hook, then DynamoDB hook, then MongoDB (topology detection, session binding, change capture, tripwire).
4. Fixture routes from [the fixture contract](../../spec/conformance/fixture.md#data-store-routes) on the binding's SQLite (Java: H2) profile, with `"stores": ["mongodb", "redis", "dynamodb"]` and `"sharedRules": ["secret-columns", "raw-commit"]` in `bindings.json`.
5. A page in the binding's docs: setup, the `preview: false` mark, and the coverage warning (unhooked clients are not covered).

### Also in each language's batch-one work: MySQL Previews

MySQL deadlocks (error 1213) when three or more Previews insert the same new key at once and the first rolls back, at every isolation level. The Go, Rust, Python and Node MySQL providers now run one Preview at a time per process (see [verified databases](../bindings/databases.md)). Java, .NET, PHP and Ruby have no MySQL conformance entry yet: each of those helpers adds one for its main framework, applies the same per-process turn-taking to its MySQL provider with a regression test, and adds the new tests to the counts in `docs/bindings/databases.md`.

### Also in each language's batch-one work: capabilities the UI needs

Each binding fills two capabilities fields defined in `spec/capabilities.schema.json`: `binding` (its language and framework, so the workbench shows the `preview: false` snippet in the host's own language) and `database.system` (the SQL provider id, such as `sqlite` or `postgresql`, so the workbench shows the right store mark instead of guessing from the database name).

### Acceptance checks for each language

- `node tests/conformance/run.mjs <binding-id>` passes with the compose services up, with no data-store or shared-rule check reported as not implemented, and the binding's other profiles still pass.
- The binding's unit tests run every case in `classification-cases.json` and fail when the embedded tables differ from `spec/data-stores/`.
- A unit test turns the guard off (or removes the hook) and shows the binding's own guard tests fail, as the reference's `negative.mjs` does for the shared checks.
- A unit test shows a handler that catches the blocked error and returns 200 still gets the 409.
- MongoDB: a unit or integration test shows a write sent without the Preview session during a Preview yields 500, not a confirmation.
- The Opus review signs off the MongoDB session binding, the tripwire and the pipeline order.

### Review findings every language checks

The Go review found three patterns that apply to every binding. Each review and each remaining language checks them:

1. **Handler code never holds the Preview's MongoDB session.** Session-scoped helpers (`withTransaction`, `startSession`, "session from context") must not hand the binding's Preview session to handler code, or the handler can commit it. Guarded handles attach the session per call instead.
2. **The tripwire proves it's installed on the guarded client itself.** Seeing commands from some other client doesn't count: the check uses the guarded client's own detection `hello`, so a guarded client without the monitor can't report `rolledBack: true` while a raw write persists.
3. **Every cleanup step runs.** A failure in one store's abort or close must not skip the SQL rollback or the other stores. The Preview then answers 500.

The Ruby review added three more:

4. **Derived clients stay guarded.** Driver calls that return a new client, database or collection with other options (`client.with(...)`, `with_options`, `withReadPreference`, `WithWriteConcern`, `Clone`, `getDatabase(name, options)`) must return guarded handles, or writes through them commit for real.
5. **Cancellation runs the whole cleanup.** Timeouts, interrupts and task cancellation (Ruby `Timeout`/`Interrupt`, Python `CancelledError`, which is a `BaseException`, Java `InterruptedException`, .NET `OperationCanceledException`, a dropped Rust future, a Go context cancel) still abort every store, roll back SQL and release the MySQL Preview turn. A held turn hangs every later Preview.
6. **Client-side interpolation doesn't leak secrets.** Drivers that inline parameters into the SQL text (Trilogy, PDO with emulated prepares, PyMySQL and mysqlclient) must still report secret values as redacted parameters, never in the logged statement text.

Go also fails every open Preview with 500 when it sees a write with no request attribution while a Preview is open, unless the context is marked detached (background workers). Bindings whose runtime can attribute writes to a request (async context, thread or fiber locals, request context) do the same; a runtime that can't documents the gap.

### After batch one lands: MySQL transaction escapes in every language

The Ruby review found that a MySQL `CALL` can commit the Preview transaction; `spec/data-stores.md` now refuses `CALL` (exact-name opt-out) and adds an `@@in_transaction` backstop. Once the reviews finish, one cross-language pass, for every MySQL and MariaDB provider in all eight languages:

- checks the whole refused list (explicit and implicit commits, `CALL`) is enforced before sending, with the backstop;
- adds a shared conformance route and check (for example `POST /items/{id}/ddl`, running `CREATE TABLE` after the insert) that every MySQL entry passes;
- checks review findings 4-6 above in Go and Rust, which were reviewed before those findings were written (Node has been checked);
- checks in every language a finding from the Java review: once a Preview has ended for any reason (including the 50 s limit), its MongoDB session and guarded handles refuse every further call, so a late handler write can't run outside the transaction. Go kept a "tiny window" here; close it;
- PHP: checks Laravel Octane on Swoole/OpenSwoole, where one worker runs requests concurrently in coroutines, so "every write in the process belongs to the Preview" doesn't hold; either attribute writes per coroutine or refuse Preview under concurrent workers, with a test;
- makes sure CI gives every new MySQL entry (`ruby-rails-mysql`, `php-laravel-mysql`, `java-spring-mysql`, the .NET one) the `BENCH_MYSQL_URL` and database it needs.

### Closing batch one

Once the last MySQL-escape helpers finish:

- Make `--max-connections=1000` permanent for the compose `mysql` service (raised at runtime during the parallel runs; changing compose then would have recreated the container under running helpers).
- Ruby on PostgreSQL: add the `pg` gem (libpq is installed) and run the ActiveRecord provider tests on PostgreSQL, since the backstop code there is untested.
- PHP on SQL Server: untested, because `pdo_sqlsrv` needs Microsoft's ODBC driver, whose install asks to accept Microsoft's licence. Ask the person first.
- One full run of every suite and the whole conformance matrix, then a demo rebuild.

### Closing batch two

Once every language's batch-two review signs off: add the new store packages (for example Node `@sendproof/cassandra`, `@sendproof/elasticsearch`, `@sendproof/cosmosdb`, `@sendproof/firestore`, and each language's equivalents) to the release tooling and consumer smoke tests as for batch one; update every language's rows in `docs/bindings/databases.md` and the batch-two status line above; run the full suite once with the heavy stores up.

### After batch one lands: release tooling

`tools/release/*.mjs` lists packages per registry by hand and knows none of the new store packages (Node `@sendproof/redis`, `/dynamodb`, `/mongodb`; Go `redisbench`, `dynamobench`, `mongobench`; the Rust, Python, .NET, Java, Ruby and PHP store packages). Once every language is reviewed, one pass adds them to each registry script, the CI publish jobs, the consumer smoke tests and, for PHP, the split mirror repos, then runs `pack-all --verify`. The Rust review adds its three crates to `crates.mjs` already.

## Work breakdown, batch two

Batch two adds one classification table per store under `spec/data-stores/`, extends `classification-cases.json`, and adds guard-only hooks. All four stores are `guard` only (see [Batch two stores](../../spec/data-stores.md#batch-two-stores)).

**Status:** the foundation is done (2026-11-22). The four tables, their shared cases, the Cosmos DB and Firestore recordings, the reference hooks for Cassandra and OpenSearch with their conformance checks, the compose `heavy-stores` services and the CI heavy-stores jobs are in place. No binding has started batch two.

In the tables below, **confirmed** means the hook uses a documented, public extension point of that library; the Node Cosmos DB and Firestore rows were also confirmed by recording the SDK's traffic for `spec/data-stores/recordings/`. **Spike** means the first hour of that language's work must prove the hook sees every request before it is sent, and the fallback is named. Unsupported stores are documented as such in the binding's data-store page.

### Cassandra

The unit is the CQL statement, so a hook at the statement API (above the driver's own prepare) sees the text for every call, including prepared ones. Post-hoc trackers (`RequestTracker`, `QueryObserver`) run after sending and can't guard.

| Language | Library | Hook | Status |
| --- | --- | --- | --- |
| Node | `cassandra-driver` 4 | Wrap the client's `execute`, `batch`, `eachRow` and `stream`; `batch` is always refused in a Preview. | Confirmed |
| Python | `cassandra-driver` (DataStax, also ScyllaDB's fork) | Wrap `Session.execute` and `execute_async`; a `BoundStatement` carries `prepared_statement.query_string`. | Confirmed |
| .NET | `CassandraCSharpDriver` 3 | `ISession` decorator (`Execute`, `ExecuteAsync`, `Prepare`); `BatchStatement` is refused. | Confirmed |
| Java and Kotlin | DataStax Java driver 4, Spring Data Cassandra | `java.lang.reflect.Proxy` over `CqlSession`; Spring: a `BeanPostProcessor` wraps the `CqlSession` bean, which `CqlTemplate` and repositories use. | Confirmed |
| Go | `github.com/apache/cassandra-gocql-driver/v2` (gocql) | `Session` is a struct, so a wrapper type with `Query(...).Exec/Iter/Scan` and `Batch`; handlers use the wrapper. | Confirmed (wrapper) |
| PHP, Ruby | none maintained | The DataStax PHP extension and Ruby gem are unmaintained. | Unsupported |
| Rust | `scylla` | Wrapper over `Session` (`query_unpaged`, `execute_unpaged`, `batch`), like the existing extractors. | Confirmed (wrapper) |

### Elasticsearch and OpenSearch

One hook per client, below the typed API, sees method, path and body. Classify with `elasticsearch.json`; report `opensearch` or `elasticsearch` as the store.

| Language | Libraries | Hook | Status |
| --- | --- | --- | --- |
| Node | `@elastic/elasticsearch` 8, `@opensearch-project/opensearch` 2 | A `Transport` subclass passed as the client's `Transport` option, overriding `request(params, options)`. | Confirmed |
| Python | `elasticsearch` 8, `opensearch-py` 2 | A `transport_class` whose `perform_request(method, target, body=…)` guards first. | Confirmed |
| .NET | `Elastic.Clients.Elasticsearch` 8, `OpenSearch.Client` | A request invoker (`IRequestInvoker`, an `HttpRequestInvoker` subclass) given to `ElasticsearchClientSettings`; OpenSearch: an `HttpConnection` subclass given to `ConnectionSettings`. | Confirmed |
| Java and Kotlin | `elasticsearch-java` 8, `opensearch-java` 2, Spring Data Elasticsearch | Decorate `ElasticsearchTransport` / `OpenSearchTransport` (`performRequest` sees the endpoint's method and URL); Spring: a `BeanPostProcessor` on the transport bean. | Confirmed |
| Go | `go-elasticsearch` 8, `opensearch-go` 4 | An `http.RoundTripper` wrapper set as `Config.Transport`; it returns an error before the inner round trip. | Confirmed |
| PHP | `elasticsearch/elasticsearch` 8, `opensearch-project/opensearch-php` 2 | A decorating PSR-18 client passed to `ClientBuilder::setHttpClient`. | Confirmed |
| Ruby | `elasticsearch` 8, `opensearch-ruby` 3 | A Faraday middleware first in every connection's stack, added as the HTTP transport builds each connection (sniffing and reloads included); a client built before the store has its connection collection rebuilt; a client on another HTTP transport makes the store refuse to start, or fails as it is built. | Done and reviewed (2026-11-22); `ruby-rails` lists `opensearch` |
| Rust | `elasticsearch`, `opensearch` crates | The `Transport` is a concrete struct with no middleware; typed calls can't be intercepted by a wrapper. | **Spike**: a custom `reqwest` client through `TransportBuilder`, or wrap `Elasticsearch::send` and expose only the wrapper |

### Cosmos DB

Hooks on the HTTP pipeline derive the operation with `fromRequest` in `cosmosdb.json`; every request also carries the trigger headers.

| Language | Library | Hook | Status |
| --- | --- | --- | --- |
| Node | `@azure/cosmos` 4 | A request plugin (`plugins: [{ on: 'request', plugin }]`): it sees `operationType` (lower case), `resourceType` and the headers. The option isn't in the public docs, so pin the minor version and keep the recording test. | Confirmed by recording (4.10.2) |
| Python | `azure-cosmos` 4 | **Spike**: whether `CosmosClient` honours azure-core `per_call_policies`; fallback: a custom `transport` (azure-core `HttpTransport`) that classifies each `HttpRequest`. | Spike |
| .NET | `Microsoft.Azure.Cosmos` 3 | A `RequestHandler` in `CosmosClientOptions.CustomHandlers`. `RequestMessage.OperationType` is internal, so classify from method, URI and headers. | Confirmed |
| Java and Kotlin | `azure-cosmos` 4 | The client has no public pre-send policy hook (diagnostics handlers run after). **Spike**: a wrapper over `CosmosContainer`/`CosmosAsyncContainer` and `CosmosScripts`; Spring Data Cosmos through a wrapped `CosmosAsyncClient` bean. | Spike |
| Go | `azcosmos` | An azcore `policy.Policy` in `ClientOptions.PerCallPolicies`. | Confirmed |
| PHP, Ruby, Rust | no official SDK | | Unsupported |

### Firestore

Every gRPC hook must cover streaming calls as well as unary ones: `RunQuery`, `BatchGetDocuments` and `Listen` stream, and `Write` is a bidirectional stream that must be refused before its first message. A unary-only interceptor lets `Write` through.

| Language | Library | Hook | Status |
| --- | --- | --- | --- |
| Node | `@google-cloud/firestore` 7 | **Spike**: gax `interceptors` in the client options for gRPC; the REST transport (`preferRest: true`) was recorded and is the fallback, hooked at its HTTP request function. | Spike |
| Python | `google-cloud-firestore` 2 | **Spike**: `Client` doesn't take a transport; a channel wrapped with `grpc.intercept_channel` (unary-unary, unary-stream and stream-stream interceptors) given to `FirestoreGrpcTransport`, reached through the client's internals. Fallback: wrap the client's `_firestore_api`. | Spike |
| .NET | `Google.Cloud.Firestore` 3 | `FirestoreClientBuilder.CallInvoker = channel.Intercept(guard)` with an `Interceptor` overriding the unary and streaming calls; then `FirestoreDb.Create(project, client)`. | Confirmed |
| Java and Kotlin | `google-cloud-firestore` 3 | A gRPC `ClientInterceptor` (covers every call type) through `InstantiatingGrpcChannelProvider.setInterceptorProvider`. | Confirmed |
| Go | `cloud.google.com/go/firestore` | `option.WithGRPCDialOption(grpc.WithChainUnaryInterceptor(…))` **and** `grpc.WithChainStreamInterceptor(…)`. | Confirmed |
| PHP | `google/cloud-firestore` (needs the grpc extension) | **Spike**: gax `transportConfig.grpc.interceptors`. | Spike |
| Ruby | `google-cloud-firestore` 2 | A gRPC `ClientInterceptor` (all four call types) added where `Gapic::ServiceStub` creates each Firestore stub, so `config.interceptors` can't drop it; `BulkWriter` writes are refused as they are queued. A client built before the store makes it refuse to start; REST clients raise. | Done and reviewed (2026-11-22); recordings replayed |
| Rust | no official SDK | | Unsupported |

### Order and acceptance

One helper per language once its batch-one work is reviewed, in any order. Each language's work: embed the four tables with a parity test, run every batch-two case in `classification-cases.json`, add the hooks above with the store's display name and `Db` entries, replay the recordings for Cosmos DB and Firestore (and show the replay fails with the hook removed), add the Cassandra and OpenSearch fixture routes from [the fixture contract](../../spec/conformance/fixture.md#data-store-routes), and list `"cassandra"` and `"opensearch"` in the entry's `stores`. The review findings above apply unchanged; finding 4 (derived clients stay guarded) applies to every client that returns another client, such as Elasticsearch's `child()` and Cosmos DB's `database().container()`.

Batch two's conformance needs Cassandra and OpenSearch from the `heavy-stores` compose profile; Cosmos DB and Firestore have emulators that are large or Linux-only, so they get unit tests against recorded requests rather than a service in CI.

## Workbench UI changes

Another helper will mock these; they must keep the current layout and every existing feature, and must not shift content when data arrives.

1. **Store-aware change list.** Each change shows a store icon and the right nouns: SQL shows "Table" and "Row", MongoDB "Collection" and "Document", DynamoDB "Table" and "Item", Redis "Key prefix" and "Key". The key column shows `_id`, the primary-key attributes or the key.
2. **Nested document diffs.** `before` and `after` render as a collapsible tree with changed paths highlighted (`profile.city: Leeds → York`), unchanged branches collapsed by default, and arrays compared by index. Extended JSON values (`$oid`, `$date`) show as typed badges. `[REDACTED]` values keep a distinct muted style.
3. **Db command log pane.** SQL and Db entries share one "Queries" list with store filter chips. Each row shows the store icon, operation, target, rows and time; expanding it shows the sanitized statement in monospace. A blocked entry shows a "Blocked" badge.
4. **"Preview unavailable" before running.** For an operation in `previewUnavailable`, the Preview action is disabled with its `reason` shown inline beside the button (not only in a tooltip), and Send stays available.
5. **"Preview unavailable" after running.** A 409 with `code: "preview_unavailable"` renders a result state, not an error: the `detail` sentence, the store icon and refused operation, the line "Nothing was written", and actions to Send or Send with trace. Its loading state mirrors the layout of the result that follows.
6. **Coverage disclosure.** The environment panel lists `dataStores` with each mode ("MongoDB: rolled back", "Redis: writes blocked") and states that other stores and unhooked clients are not covered.
7. **Store icons.** One monochrome glyph per store at the size of the existing table icon, with the store name as text beside it, so no meaning depends on a logo. Whether to use vendor logos is a decision for the lead (trademark guidelines vary).
8. **Small screens.** The tree diff and query rows wrap without horizontal scroll at 320 px and at large user font sizes.

## CI additions

The batch-one steps below and the batch-two jobs are applied in `.github/workflows/check.yml`. `node tests/conformance/run.mjs --matrix` emits a comma-separated `stores` field for each entry.

In the `conformance` job, after `npm ci --prefix tests/conformance`:

```yaml
      # MongoDB needs a replica-set command line, which service containers can't set, so the
      # data stores come from compose.yml. Only the stores this entry lists are started.
      - name: Start data stores
        if: matrix.stores != ''
        env:
          STORES: ${{ matrix.stores }}
        run: docker compose -f tests/conformance/compose.yml up -d --wait ${STORES//,/ }
```

After "Run shared HTTP checks":

```yaml
      - name: Prove the data-store checks catch a missing guard
        if: matrix.id == 'data-stores-reference'
        run: |
          node --test tests/conformance/fixtures/data-stores-reference/classification.test.mjs tests/conformance/fixtures/data-stores-reference/recordings.test.mjs
          node tests/conformance/fixtures/data-stores-reference/negative.mjs
      - name: Stop data stores
        if: always() && matrix.stores != ''
        run: docker compose -f tests/conformance/compose.yml down -v
```

### Batch two: the heavy-stores jobs

Cassandra and OpenSearch need about 3 GB of containers, so they run in separate jobs, `heavy-stores-matrix` and `heavy-stores`, on the weekly schedule (`0 4 * * 1`), on manual dispatch (`workflow_dispatch`), and on pull requests labelled `heavy-stores`. A label added to an open pull request counts from its next push, because the workflow doesn't listen for `labeled` events (that would rerun every job for any label).

- `heavy-stores-matrix` selects the entries whose `stores` name `cassandra`, `opensearch` or `elasticsearch`.
- `heavy-stores` sets up the entry's toolchain like the conformance job, checks the entry is on SQLite or H2 (store entries live on each binding's SQLite or H2 profile, and this job starts no database service), starts the entry's stores with `--profile heavy-stores`, prepares the fixture, runs `node tests/conformance/run.mjs <id>` with every store the entry lists, runs `negative.mjs` for `data-stores-reference`, and removes the containers.
- The plan first said to drop heavy entries from the main matrix. That would have taken `data-stores-reference` and every binding that lists a heavy store out of pull-request CI entirely, so `conformance-matrix` instead removes the heavy stores from each entry's `stores`, and the conformance job passes the rest as `BENCH_STORES`. The runner then checks only those stores and reports the heavy ones as skipped ("CI runs these in the heavy-stores job"). `negative.mjs` reads `BENCH_STORES` too, so it expects exactly the guard checks of the stores in the run.

## Running the checks locally

```sh
docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb
docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra opensearch
node tests/conformance/run.mjs data-stores-reference
node --test tests/conformance/fixtures/data-stores-reference/classification.test.mjs tests/conformance/fixtures/data-stores-reference/recordings.test.mjs
node tests/conformance/fixtures/data-stores-reference/negative.mjs
docker compose -f tests/conformance/compose.yml --profile heavy-stores down -v
```

Without the heavy stores, run the batch-one checks only with `BENCH_STORES=mongodb,redis,dynamodb` in front of the `run.mjs` and `negative.mjs` commands. The runner defaults to the compose ports; set `BENCH_MONGODB_SERVER_URL`, `BENCH_REDIS_SERVER_URL`, `BENCH_DYNAMODB_SERVER_URL`, `BENCH_CASSANDRA_SERVER` (`host:port`) or `BENCH_OPENSEARCH_SERVER_URL` to use other services. Cassandra and OpenSearch together need about 3 GB of free Docker disk and 4 GB of memory.

## Decisions (approved 2026-11-21)

- The blocked-Preview status is 409, with an RFC 9457 problem body.
- A handler COMMIT (SQL) or `commitTransaction` (MongoDB) answers 500 without confirmation, not 409.
- MongoDB Previews don't queue on a busy document; a `WriteConflict` reaches the handler.
- Host-declared reads (`TreatAsRead`) are allowed, by exact name only.
- `preview: false` publishes a reason in capabilities, and a binding never infers it.
- Batch two is guard-only for all four stores.
- Store icons are vendor logos, using each vendor's official SVG, with the store name always beside them.
- Change records carry an optional `via` field (`"upsert"`, `"replace"`) so the UI can label upserts and whole-document replacements.
- Updates open on Diff with "Changes only" off.
- The .NET attribute is `[SendproofPreview(Enabled = false, Reason = "...")]`.
- The UI follows the approved v6 mocks (`mocks/screens/113-131`, `m26-m31`; `mocks/README.md`, v6 section).

## How the Node binding did it

Node went first so the other languages can copy its shape. Everything below is in `adapters/node/`; the user-facing page is [adapters/node/data-stores.md](../../adapters/node/data-stores.md).

### File layout

| Piece | Where |
| --- | --- |
| Embedded tables | `core/src/stores/tables.ts`, generated from `spec/data-stores/*.json` by `core/scripts/embed-store-tables.mjs` (`npm run embed-store-tables --workspace @sendproof/core`). Never edit it by hand. |
| Classifiers | `core/src/stores/classify.ts`: `classifyRedis`, `classifyMongo`, `classifyDynamo`, `partiqlVerb`. Pure functions; each takes an optional exact-match `treatAsRead` set. |
| Guard and errors | `core/src/stores/guard.ts`: `guard(store, operation, kind, detail?)`, `refuseInPreview(message)`, `PreviewWriteBlockedError`, `PreviewTransactionControlError`, `sanitizeDocument`, `storeLabel`, `readSet`, `writeReason`. |
| Scope fields | `core/src/capture.ts`: the request's `Capture` (already in `AsyncLocalStorage`) gained `blocked`, `fault`, `block()`, `refuse()` and `db()`. `currentPreview()` returns the Preview capture even after it finished, so a late write is still refused. `change()` now redacts at any depth (`redactDeep` in `secrets.ts`). |
| Pipeline order, 409, discovery | `createBench` in `core/src/index.ts`: stores' `around` wrap the dispatch; after the handler every store's `finishPreview` runs inside the SQL provider's callback (with no SQL provider and at least one store, the dispatch runs unwrapped, so a MongoDB-only or guard-only app can Preview); then a failed finish or a fault answers 500, a block answers 409 (`blockedPreview`), otherwise the envelope. A handler that throws after a block still gets 409 when the provider rethrew that same error. `dataStores` come from `store.describe()`; `previewUnavailable` from operations registered with `preview: false`. |
| Capabilities `binding` and `database.system` | Each framework package passes `{ language: 'node', framework: 'Express' \| 'Fastify' \| 'Hono' \| 'NestJS' }` to `createBench`; each SQL provider exposes `system` (`sqlite`, `postgresql`, `mysql`, `mariadb`, `mssql`, or the driver's own id), and discovery sends `database` as `{ name, system }` when it has one. Tested in `tests/capabilities.test.mts`. |
| `DataStore` interface | `core/src/types.ts`: `system`, `describe()`, optional `around(capture, dispatch)` and `finishPreview(capture)`. |
| Store hooks | One package per store: `redis/src/index.ts` (ioredis, node-redis), `dynamodb/src/index.ts` (initialize-step middleware), `mongodb/src/{engine,driver,mongoose,index}.ts`. |
| `preview: false` | `unavailableOperation()` in core validates the mark; `unavailable(method, path, { reason?, stores? }, …handlers)` in Express, Fastify and Hono; `@SendproofPreview(method, path, { enabled: false, reason })` in NestJS. The route is registered for Send only, so a Preview finds no operation. |
| Transaction-control guard | SQLite: `sqlite/src/index.ts` records a fault for `COMMIT`/`ROLLBACK`/`BEGIN` (`endsTransaction` in `core/src/statements.ts`). Knex, Drizzle, TypeORM and Prisma already refused them and fail the Preview. |
| Fixture routes | `examples/fixture-stores.mjs` (store routes, hooked only when the runner passes their variables) and the accounts and commit routes in `examples/fixture-service.mjs`, shared by the Express, Fastify, Hono and NestJS fixtures. |

### Tests

| File | What it proves |
| --- | --- |
| `tests/stores-core.test.mts` | `embedded data-store tables match spec/data-stores` (parity), `the classifiers pass every shared classification vector`, host reads, deep redaction, the guard's mark, `a blocked Preview answers 409 even when the handler catches the error and returns 200`, `the guard checks fail when the hook is removed` (the negative test), the pipeline order, discovery, `preview: false`, and `Preview runs without a SQL provider when the only stores are hooked ones`. |
| `tests/redis.test.mts` | Per client (ioredis, node-redis): reads, writes, `GETDEL`, pipelines and `MULTI` refused before any byte is sent (read back by an unhooked client), observed Send, and the same checks failing unhooked. |
| `tests/dynamodb.test.mts` | Base and document clients, PartiQL `SELECT` versus `UPDATE`, inline PartiQL literals replaced by `?`, credentials never captured, the checks failing unhooked. |
| `tests/mongodb.test.mts` | Driver: preview mode, nested redacted changes, `via`, `$out` blocked, `a write sent without the Preview session fails the Preview with 500` (the tripwire), a foreign session and a handler commit refused, `withTransaction` joining, guard mode on a standalone server (simulated `hello`), the checks failing unhooked. Mongoose: models, queries, `insertMany`, aggregation and `connection.transaction()` joining; `Model.collection` writes failing with 500. Concurrency and escapes: `before images come from the transaction start, not from later commits by others`, `a handler commitTransaction never confirms, before or after it reaches the server` (driver refused before send; Mongoose `connection.db` caught by monitoring), `a stage added through the cursor builder is guarded before sending`, `a Preview keeps the mode it began in when detection later succeeds`, `a Preview that outlives its time limit is aborted and never confirmed`, `concurrent Previews and Sends never share a session` (including a handler that throws), and `a WriteConflict between two Previews reaches the handler`. |
| `tests/support/stores.mts` | The shared harness: an Express app with SQLite (or none, with `sqlProvider: false`), `assertBlocked`, `assertUnconfirmed`, and `needs(store)`, which skips a test when its compose service doesn't answer a protocol request (Redis `PING`, MongoDB `hello`, an HTTP request to DynamoDB). |

Run them with the compose services up: `npm test --prefix adapters/node`. The store tests skip, with the compose command in the reason, when a service is down. An open port is not enough to run them: Docker accepts and drops connections while a container starts, and a Redis client pointed at such a port reconnects forever and kept `npm test` from exiting. Probe with a real request, and give test clients no reconnects and an immediate `disconnect()` on cleanup.

### What later languages should copy, and what they can skip

- **Mark first, response second.** The guard records the block on the request scope before throwing, and the pipeline reads the scope, never the handler's status. Copy the `swallow` route test: it catches the refusal and returns 200.
- **Classify batches before queueing.** Pipelines and `MULTI` are checked as a whole before the first command is written; refusing one command mid-pipeline corrupts reply matching in both Node Redis clients. ioredis auto-pipelining mixes requests in one batch, so it is refused at registration.
- **MongoDB uses monitoring for everything after the guard.** Command monitoring (in the request's async context) supplies the tripwire, the 263 block, the change candidates (`insert` documents, `update`/`delete`/`findAndModify` filters, `upserted` replies, client `bulkWrite` ops) and the `Db` log entries. The guarded proxies only inject the session and run the guard. Driver internals run under a private async-local flag so the engine's own reads and abort are ignored.
- **Join, don't nest.** The Preview session's `startTransaction`, `withTransaction`, `commitTransaction`, `abortTransaction` and `endSession` are replaced on the session object for the Preview; commit and abort record a fault. The engine calls the prototype methods to abort.
- **Refuse transaction commands by name, and trip on them.** Replacing the session's methods isn't enough: a raw `{ commitTransaction: 1 }` with the Preview session (`db.admin().command(…, { session })`) commits the Preview transaction. The guard refuses `commitTransaction` and `abortTransaction` command documents before sending, and the tripwire fails the Preview when monitoring sees one it couldn't stop (Mongoose's `connection.db`). Don't rely on a later capture read failing: a write with nothing to read back (an insert whose `_id` the server assigns) leaves the Preview confirmable.
- **The tripwire checks the transaction, not just the session.** A write counts as inside the Preview only when it carries the Preview's `lsid` and `autocommit: false`.
- **Before images at the transaction's snapshot time.** The first reply to a command the Preview session sends carries the transaction's read timestamp as `operationTime`. Read `before` images and filter matches at that time with `readConcern: { level: "snapshot", atClusterTime }`, outside the transaction. The majority-committed view showed a concurrent commit as a Preview change (a document another request inserted appeared as a `delete`). The Node driver drops `atClusterTime` from read-concern options, so the engine sends a raw `find` command; treat `NamespaceNotFound` and `SnapshotUnavailable` as "absent at the start". Fall back to the majority view only when no reply carried a time.
- **A Preview keeps the mode it began in.** Record the mode per Preview at the start. A shared, mutable mode let a Preview that began in `guard` mode (detection failed) have its writes treated as joining a transaction it never had, once a later detection succeeded.
- **Guard builders, not just calls.** An aggregation cursor's `out()`, `merge()` and `addStage()` add a writing stage after `aggregate()` returned. Wrap returned cursors and classify the pipeline with the new stage when the builder is called; builders return the wrapped cursor so chaining keeps the guard.
- **Time-limit the transaction.** Each Preview's transaction has its own timer (`previewTimeoutMs`, 50 seconds, below the server's 60-second lifetime) that records a fault and aborts it, so a hung handler never holds a transaction until the server kills it.
- **Previews without a SQL provider.** When the host gives data stores but no SQL provider, run the dispatch unwrapped; the store hooks still abort and guard. Don't require a SQL provider to Preview.
- **Sanitize PartiQL text.** Statements may inline values; replace single-quoted strings and numbers with `?` and keep double-quoted names.
- **Fail closed on unknown methods.** A guarded MongoDB handle refuses, in a Preview, any method its table doesn't list.

### Spikes, resolved

- node-redis 5: every typed command goes through the inner client's public `sendCommand`; `createClient()` returns an object inheriting from that inner client (`_self`), so hooks go on `_self`. `MULTI` and pipelines go through `_executeMulti` and `_executePipeline`, which are hooked to classify the batch first. node-redis 4's send path is private: unsupported.
- Mongoose 8: `transactionAsyncLocalStorage` covers queries, `save()`, `Model.create`, `insertMany`, `Model.bulkWrite`, `Connection.bulkWrite` and aggregations, so the Preview runs its dispatch inside it. Guarding before send in `guard` mode needs the plugin's `pre` hooks; model statics such as `Model.updateOne` are queries and covered. `Model.collection.*` bypasses both and is caught by the tripwire.
- AWS SDK v3: the document client's commands resolve through the base command, so `context.commandName` is the base name (`UpdateItemCommand`) and one middleware on the shared stack covers both clients.
