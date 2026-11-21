# Data stores in the Java and Kotlin binding

Sendproof Preview promises that a confirmed Preview never leaves a write behind. For SQL, the rollback provider guarantees it. For MongoDB, Redis and DynamoDB, the Java binding (Spring Boot) and the Kotlin binding (Ktor) hook each store's client, following the rules in [spec/data-stores.md](../../spec/data-stores.md):

| Store | Module | Mode | What a Preview does |
| --- | --- | --- | --- |
| MongoDB replica set or sharded cluster | `sendproof-mongodb` | `preview` | Runs every command in one transaction, reports document changes, and aborts it. |
| MongoDB standalone server | `sendproof-mongodb` | `guard` | Runs reads. The first write stops the Preview. |
| Redis | `sendproof-redis` | `guard` | Runs reads. The first write stops the Preview. |
| DynamoDB | `sendproof-dynamodb` | `guard` | Runs reads. The first write stops the Preview. |

Send and observed Send are never blocked. Their writes commit as usual, and an observed Send traces every store command as a `Db` log entry. `sendproof-spring-boot` and `sendproof-ktor` depend on the three modules. Each store's client library is compile-only there, so your application brings the one it uses.

## Coverage: only hooked clients are covered

> [!WARNING]
> The binding covers a store only through the client it hooked: the Spring Data MongoDB `MongoDatabaseFactory` and the Spring Data Redis `RedisConnectionFactory` that Spring creates, the clients you pass to `MongoStore` and `RedisStore.jedis`, and every DynamoDB client (see below). Other clients are not covered: their writes are neither blocked nor rolled back. That includes a MongoDB or Redis client created inside a handler, a second client for the same store, a raw Lettuce connection, a Redis Cluster or Sentinel client, reactive Spring Data MongoDB (`ReactiveMongoTemplate` and reactive repositories), reactive Spring Data Redis access, and a raw socket. Hook every client your handlers use, at startup.

## Spring Boot

Spring Data MongoDB and Spring Data Redis are hooked automatically when Sendproof is enabled and the client library is on the classpath. The `MongoDatabaseFactory` and `RedisConnectionFactory` beans are replaced by decorators, so `MongoTemplate`, repositories, `StringRedisTemplate` and the rest use the guarded ones. Name them with properties, or register a store on the builder:

```properties
sendproof.stores.mongodb.name=catalog
sendproof.stores.redis.name=cache
# sendproof.stores.mongodb.enabled=false leaves a store unhooked
```

```java
@Bean Sendproof sendproof() {
  return Sendproof.builder().apiName("Inventory")
      .dataStore(MongoStore.springData().name("catalog").build())
      .dataStore(RedisStore.spring().name("cache").treatAsRead("MYMODULE.GET").build())
      .dataStore(ordersStore)                        // a DynamoDbStore, below
      .build();
}
```

`name` is the label the workbench shows. It must be a display name such as `catalog`, never a URL, host name or credentials; a value that looks like one is refused. Any `DataStore` bean is registered too.

The Preview needs a SQL provider or at least one hooked store. An application whose only database is MongoDB, Redis or DynamoDB can Preview without a SQL provider.

### MongoDB with Spring Data

During a Preview the binding starts one session and one transaction (read concern `snapshot`, write concern `majority`) and binds the session as the thread's Spring Data session, so `MongoTemplate`, repositories and the application's own `@Transactional` methods join it with no change. A handler's `PROPAGATION_REQUIRED` transaction participates and never commits.

- The session a handler can reach is a guard around the Preview's session. Its `startTransaction` does nothing, `withTransaction` runs its body in the Preview transaction, and its `commitTransaction` and `abortTransaction` never reach the server: they fail the Preview with 500, like a raw SQL `COMMIT`. `close` does nothing; the Preview ends its session.
- A new session during a Preview (`REQUIRES_NEW`, `getSession`, `MongoTemplate.withSession`) is refused and fails the Preview with 500, because its commit would escape the rollback.
- A raw `{ commitTransaction: 1 }` or `{ abortTransaction: 1 }` command through a guarded handle is refused before it is sent.
- `$out` and `$merge` stages, at any depth of an aggregation, and the commands MongoDB refuses in a transaction (`count`, an explicit `create`, `listCollections`) are blocked before they are sent, with a reason such as "Preview unavailable: MongoDB can't run $out inside a transaction".
- A Preview keeps the mode it began in. A Preview that began while the topology couldn't be detected stays in `guard` mode even if detection later succeeds.
- A Preview may hold its transaction for 50 seconds by default (`MongoStore.builder().previewTimeout(...)`), below MongoDB's 60-second transaction lifetime. A handler still running at the limit loses the transaction and the Preview answers 500.

### Redis with Spring Data Redis

Each `RedisConnection` method is mapped to its Redis command by name (`hGetAll` is `HGETALL`), classified, and refused before it reaches Lettuce or Jedis when it writes. Pipelines and `MULTI` are checked command by command as they are queued, so a refused write is never queued, and a `MULTI` that was opened is discarded, whether the write came through the connection or one of its command groups (`stringCommands()` and the rest). A method the mapping doesn't know is a command the table doesn't list, so it is treated as a write. `commands()` returns the guarded connection. A Preview that asks for the native Lettuce or Jedis connection (`getNativeConnection()`) or a reactive connection fails with 500, because neither is guarded.

### DynamoDB with the AWS SDK for Java v2

`DynamoDbStore` is an `ExecutionInterceptor`. Add it to the override configuration of each client you build; Sendproof doesn't build the client. `beforeExecution` runs before a request is serialized or signed, so credentials and signatures never reach a capture. The Enhanced Client calls the same low-level client, so hooking that client covers both, sync or async.

A DynamoDB client built without the interceptor, for example inside a handler, is still guarded. `sendproof-dynamodb` lists a fallback guard in the SDK's `software/amazon/awssdk/services/dynamodb/execution.interceptors`, which the SDK adds to every DynamoDB client it builds. It refuses writes during a Preview the same way, but it doesn't apply a store's `treatAsRead` names or log `Db` entries, so still add the store to the clients you build. A DAX client is not covered.

```java
DynamoDbStore orders = DynamoDbStore.interceptor().name("orders").build();
DynamoDbClient dynamo = DynamoDbClient.builder()
    .overrideConfiguration(c -> c.addExecutionInterceptor(orders))
    .build();
```

Register `orders` on the builder, or as a bean.

### The MongoDB tripwire on your own client

If you create the `MongoClient` yourself instead of letting Spring Boot do it, register the store's listener on it, or Preview runs in `guard` mode:

```java
MongoStore store = MongoStore.builder().name("catalog").build();
MongoClient raw = MongoClients.create(MongoClientSettings.builder()
    .applyConnectionString(new ConnectionString(url))
    .addCommandListener(store.commandListener()).build());
MongoClient client = store.sync(raw);   // handlers use this guarded client
```

The store proves the listener is installed by sending its own `hello` with a token and waiting to see that token on that client. A client without the listener, or a listener that only saw another client's commands, reports `guard` mode with the reason "the Sendproof command listener isn't registered on this MongoDB client".

## Ktor

Register the stores in the plugin and hand your handlers the guarded clients:

```kotlin
val catalog = MongoStore.builder().name("catalog").build()
val reactive = MongoClients.create(
    MongoClientSettings.builder().applyConnectionString(ConnectionString(url))
        .addCommandListener(catalog.commandListener())
        .contextProvider(catalog.reactiveContextProvider() as ReactiveContextProvider).build())
val mongo = catalog.coroutine(reactive)                          // handlers use this MongoClient
val cache = RedisStore.builder().name("cache").build()
val jedis: JedisPooled = cache.jedis(HostAndPort("localhost", 6379), DefaultJedisClientConfig.builder().build())
val orders = DynamoDbStore.interceptor().name("orders").build()  // add to your DynamoDbClient as above

install(Sendproof) {
    provider = JdbcPreviewProvider(PreviewDataSource(hikari)) { "inventory" }   // optional with stores
    dataStores += catalog; dataStores += cache; dataStores += orders
}
```

- **MongoDB** uses the Kotlin coroutine driver over the reactive streams driver. `contextProvider` is required: the reactive driver reports command events on its own threads, so each operation carries its request's capture from the thread that subscribes to it.
- **Redis** uses Jedis 5. The pool's connections are guarded, so single commands, pipelines and `MULTI` are checked before the first byte is written. Raw Lettuce is not covered.
- Handlers run the stores' blocking calls on `Dispatchers.IO`. The plugin begins and finishes store sessions off the event loop.
- A cancelled call (the client went away, a timeout, a cancelled parent job) is never confirmed, and the plugin still aborts every store, rolls back SQL and hands on the MySQL Preview turn before the cancellation continues.

## Mark an operation `preview: false`

An operation you know writes to a guarded store can be marked `preview: false`. The workbench then shows "Preview unavailable" with your reason before anyone tries, and a Preview of it is refused (409, never confirmed) without running the handler. Send still runs it. The binding never infers the mark; without it the operation is advertised and the guard decides at run time.

Give a `reason`, the `stores` it writes, or both. With only `stores`, the reason is "Preview unavailable: this operation writes to Redis" (for the first store). A method-level mark overrides a class-level `@SendproofPreview`.

```java
@SendproofPreview(enabled = false, reason = "Clears the Redis session", stores = "redis")
@DeleteMapping("/sessions/{id}") void deleteSession(@PathVariable String id) { … }
```

```kotlin
sendproofPreview(enabled = false, reason = "Clears the Redis session") { delete("/sessions/{id}") { … } }
```

## What a blocked Preview returns

When the guard refuses a write, the command never reaches the store and the handler gets a `PreviewWriteBlockedException` (with `store()` and `operation()`). The Preview then answers 409 with `application/problem+json`, whatever the handler made of the exception:

```json
{ "type": "about:blank", "title": "Preview unavailable", "status": 409, "code": "preview_unavailable",
  "detail": "Preview unavailable: this operation writes to Redis", "store": "redis", "operation": "INCR", "rolledBack": false }
```

The SQL transaction rolls back as usual. A failed rollback or abort, a handler `COMMIT` or `commitTransaction`, or a write that escaped the MongoDB session answers 500 without confirmation instead. Every cleanup step runs even when one fails: a store that can't abort never skips the SQL rollback or another store's abort.

## Writes with no request behind them

While a Preview is open, a MongoDB write that carries no request attribution fails every open Preview with 500, because nothing can say it isn't a Preview's own write that escaped. Both adapters mark every ordinary request, so a Send is never mistaken for one. Code that runs outside any request, such as a scheduler or a background worker, writes to MongoDB inside `CaptureContext.detached { … }` to be exempt. Without it, such a write fails whatever Previews happen to be open. A write that carries an open Preview's own session from another thread is that Preview's write and is captured as such.

Redis and DynamoDB hooks guard by call, not by command monitoring, so they don't have this check: a Redis client that was never hooked is simply not covered, and every DynamoDB client is guarded by the fallback above.

## Host-declared reads

Each store takes `treatAsRead`, a list of exact command names the guard should let through, such as a custom Redis module read.

> [!WARNING]
> `treatAsRead` is your statement that the command never writes. The guard trusts it: a listed command that does write is not blocked, and its write happens during the Preview. Names match exactly, with no wildcards.

## MongoDB limits

These come from MongoDB's transaction limits; see [MongoDB in Preview](../../spec/data-stores.md#mongodb-in-preview).

- Two Previews that write the same document don't queue: the second gets a `WriteConflict`, and the handler decides what to answer. The Preview still rolls back.
- Keep a Preview under about 1,000 changed documents.
- Document `before` images are read at the Preview transaction's snapshot time, so a concurrent commit by another request never shows up as a change.
- An explicit `createCollection` fails inside a Preview, because MongoDB refuses an explicit `create` in a transaction with snapshot read concern. Inserting into a new collection creates it and rolls back.
- Handles derived with other options (`withWriteConcern`, `withReadPreference`, `withCodecRegistry`, `withDocumentClass`, `getCollection(name, type)`) stay guarded. `withTimeout` does too, but the driver refuses to change `timeoutMS` inside a transaction, so a call through it fails in a Preview.
- Once the Preview ends, or reaches its time limit while the handler is still running, the session the handler holds refuses every call, so nothing it sends afterwards can run outside the aborted transaction.
- Spring Data MongoDB's session holder is package-private, so the binding builds it reflectively. A Spring Data version that changes it fails at the first Preview with a message saying so.

## Logs and redaction

Every store command in a Preview or observed-Send trace is a `Db` log entry with the store, operation, target, sanitized statement, rows and time. Statements never carry values: MongoDB statements keep field names and operators with every literal as `"?"`, Redis statements keep the command and key names (`SET session:42 ?`), and DynamoDB statements are the PartiQL text with every inline string or number literal replaced by `?`. Session commands such as `AUTH` and `hello` are never logged.

Change records for MongoDB carry `store`, `namespace`, the collection as `table`, `{ _id }` as `key`, and whole nested documents as `before` and `after`. A field with a secret name, such as `password_hash` or `apiKey`, is `"[REDACTED]"` at any depth. `via` is `"upsert"` or `"replace"` when the change came from an upsert or a whole-document replacement.

## Tests

`gradle test` runs the unit tests of every module. The MongoDB, Redis, DynamoDB and Spring Data tests use the compose services and skip, saying so, when a service doesn't answer:

```sh
docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb
sh adapters/java/scripts/gradle.sh test
node tests/conformance/run.mjs java-spring
node tests/conformance/run.mjs kotlin-ktor
```

The classification tables in `sendproof-core/src/main/resources/.../stores/` are copies of `spec/data-stores/`. A test fails when they differ; refresh them with `sh adapters/java/scripts/gradle.sh :sendproof-core:syncStoreTables`.
