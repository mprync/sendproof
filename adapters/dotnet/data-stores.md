# Data stores in the .NET binding

Sendproof Preview promises that a confirmed Preview never leaves a write behind. For SQL, the EF Core provider's rollback guarantees it. For MongoDB, Redis and DynamoDB, the .NET binding hooks each store's client, following the rules in [spec/data-stores.md](../../spec/data-stores.md):

| Store | Package | Mode | What a Preview does |
| --- | --- | --- | --- |
| MongoDB replica set or sharded cluster | `Sendproof.MongoDB` | `preview` | Runs every command in one transaction, reports document changes, and aborts it. |
| MongoDB standalone server | `Sendproof.MongoDB` | `guard` | Runs reads. The first write stops the Preview. |
| Redis (StackExchange.Redis) | `Sendproof.Redis` | `guard` | Runs reads. The first write stops the Preview. |
| DynamoDB (AWS SDK for .NET) | `Sendproof.DynamoDB` | `guard` | Runs reads. The first write stops the Preview. |

Send and observed Send are never blocked. Their writes commit as usual, and an observed Send traces every store command as a `Db` log entry.

## Coverage: only hooked clients are covered

> [!WARNING]
> The binding covers a store only through the client the hook sees. Other clients are not covered: their writes are neither blocked nor rolled back. That includes a `MongoClient` or `IMongoCollection<T>` the application created itself, a second multiplexer for the same Redis, an `AmazonDynamoDBClient` with its own `TelemetryProvider`, and a raw socket. (A DynamoDB client created before `AddDynamoDB` is still checked, with limits; see [DynamoDB](#dynamodb).) Register every client through the container, at startup, before the `Add…` call for its store.

Writes from code that belongs to no request (a hosted service, a timer) are not hooked clients' business, but they cannot be told apart from a Preview's own write that lost its request context. While a Preview is open, such a write fails every open Preview with 500 (it never claims a rollback it can't vouch for). Wrap genuinely independent background work in `using var _ = DetachedWork.Begin();` to exempt it. Ordinary and observed requests are attributed through the async context and never trigger this.

## Register the stores

Register each client first, then hook it. Each `Add…` replaces the client's registration with a guarded decorator, so everything resolved from the container is covered.

```csharp
builder.Services.AddSingleton<IMongoClient>(new MongoClient(mongoUrl));
builder.Services.AddSingleton<IConnectionMultiplexer>(ConnectionMultiplexer.Connect(redisUrl));

builder.Services.AddSendproof()
    .WithApiName("Inventory")
    .AddEntityFrameworkCore<AppDbContext>()
    .AddMongoDB(mongo => mongo.WithName("catalog"))
    .AddRedis(redis => redis.WithName("cache").TreatAsRead("MYMODULE.GET"))
    .AddDynamoDB(dynamo => dynamo.WithName("orders"));

// After AddDynamoDB: every AmazonDynamoDBClient created from now on carries the guard.
builder.Services.AddSingleton<IAmazonDynamoDB>(new AmazonDynamoDBClient());
```

`WithName` is the label the workbench shows. It must be a display name such as `catalog`, never a URL, host name or credentials; a value that looks like one is refused.

The SQL provider is optional when you register data stores. An app whose only database is MongoDB, or that has only Redis or DynamoDB, can Preview without `AddEntityFrameworkCore`: MongoDB rolls back its own transaction and the guarded stores block writes. A SQL database you give no provider is then not covered, like any unhooked client.

### MongoDB

`AddMongoDB` builds its own `MongoClient` from the registered client's settings (so command monitoring is subscribed before it connects, keeping any `ClusterConfigurator` you set) and registers a decorator for `IMongoClient`. Its databases, collections and index managers have the driver's own API; handlers inject `IMongoClient` as usual. The concrete `MongoClient` type is not registered, so inject the interface.

- During a Preview, each call is routed to its session overload with the Preview session, so the command carries the Preview's `lsid`, `txnNumber` and `autocommit: false`. A call that passes a session of its own is refused and the Preview answers 500.
- Handler code never holds the Preview's real session. `StartSession()` hands out a guarded view: its `StartTransaction` and `WithTransaction` join the Preview transaction; its `CommitTransaction` and `AbortTransaction` never reach the server and fail the Preview with 500, like a raw SQL `COMMIT`; `Fork()` and `WrappedCoreSession` are refused for the same reason. Its `Client` is the guarded client.
- Every handle that comes back from a guarded one stays guarded: `GetDatabase`, `GetCollection`, `Indexes`, `OfType`, the `With…` copies of a client, database or collection (`WithReadPreference`, `WithWriteConcern`, `WithReadConcern`), and the `Database` and `Client` back-references.
- `IMongoClient.Cluster` sends commands with no session and no guard, and GridFS uses it, so reading it during a Preview blocks the Preview (409, "GridFS and other direct cluster access can't join the Preview's MongoDB session") before anything is sent. Create a `GridFSBucket` inside the request: one created earlier already holds the cluster, so only the tripwire sees its commands. The Preview then answers 500, and the collections and indexes GridFS creates on first use may stay behind.
- An aggregation is rendered and checked when it runs, so a `$out` or `$merge` at any depth, or one added through the fluent builder (`.Out()`, `.Merge()`), is blocked before it is sent, with the reason "Preview unavailable: MongoDB can't run $out inside a transaction".
- Each Preview keeps the mode it began in: a Preview that began in `guard` mode keeps blocking writes even if topology detection succeeds mid-request.
- `before` images are read at the transaction's snapshot time, so a document another request commits during the Preview is never reported as a Preview change.
- The tripwire watches every command the client sends. A write during a Preview without the Preview's session and `autocommit: false` fails the Preview with 500 (a rollback can't be claimed for it), and so does a `commitTransaction` that reaches the server. The detection `hello` carries a one-off token that the client's own command events must see: a client without the monitor installed runs in `guard` mode with the reason "Sendproof's command monitoring isn't installed", never `preview`.
- A Preview may hold its transaction for 50 seconds by default (`WithPreviewTimeout`), below MongoDB's 60-second limit. A handler still running at the limit loses the transaction: later commands fail, nothing commits, and the Preview answers 500.
- A failed abort answers 500, after the session is still ended and the SQL transaction rolled back.
- Two Previews that write the same document don't queue: the second gets a `WriteConflict` and the handler decides what to answer. The Preview still rolls back.
- `EstimatedDocumentCount()` (`count`), `Indexes.List()`, `CreateCollection` and the other commands in the `notInTransaction` list fail inside a transaction, so the binding blocks them before sending. Inserting into a new collection creates it and rolls back.

**EF Core MongoDB provider.** `MongoDB.EntityFrameworkCore` supports `Database.BeginTransaction()` on a replica set, so the existing `AddEntityFrameworkCore<TContext>()` provider covers it: it accepts this non-relational provider, rolls back through EF's own transaction and reports changes from the change tracker with the collection name and `store: "mongodb"`. A context that also uses `IMongoClient` directly needs `AddMongoDB` as well. This provider has no transaction interceptors, so the binding refuses the handler's `Database.CommitTransaction()`, `CurrentTransaction.Commit()` and `Database.RollbackTransaction()` through EF's `TransactionCommitting` and `TransactionRollingBack` diagnostic events, before anything reaches the server; the Preview then answers 500. The rollback is refused because the provider saves a single document with no transaction at all, so a save after it would write for real.

### Redis

`AddRedis` wraps the registered `IConnectionMultiplexer` in a decorator whose `IDatabase`, `IBatch`, `ITransaction`, `IServer` and `ISubscriber` handles check every call before it is sent. Each StackExchange.Redis method maps to the Redis command it sends, and the shared table decides: `GETDEL` and `GETEX` are writes, `EVAL` is a write and `EVAL_RO` (`ScriptEvaluateReadOnly`) a read, `Execute("SET", …)` is classified by its command name, `PUBLISH` and `FLUSHDB` are writes. A method the map doesn't know is a write, so a new library method fails closed.

Batches and transactions are checked when each command is queued, so a refused write is never queued and never sent. Session commands (`AUTH`, `HELLO`, `PING`) are allowed and never logged, and the password never appears in a capture.

For `RedisCache` (`Microsoft.Extensions.Caching.StackExchangeRedis`), the multiplexer is created inside the cache, so guard it yourself:

```csharp
builder.Services.AddSendproof().AddRedis(redis => redis.WithoutDecoratingTheRegisteredMultiplexer());
builder.Services.AddStackExchangeRedisCache(options =>
    options.ConnectionMultiplexerFactory = async () =>
        (await ConnectionMultiplexer.ConnectAsync(redisUrl)).WithSendproofGuard(builder.Services.BuildServiceProvider()));
```

`IDistributedCache.Get` with sliding expiration issues a write, which the guard correctly blocks.

> [!WARNING]
> `TreatAsRead("MYMODULE.GET")` is your statement that the command never writes, matched by exact name. A command you list wrongly is not blocked, and a Preview of it may leave a write behind.

### DynamoDB

`AddDynamoDB` adds one pipeline handler, before the marshaller, to every `AmazonDynamoDBClient` created after it runs, through `RuntimePipelineCustomizerRegistry`. The operation is the request type without its `Request` suffix. A refused request is never serialized or signed, so credentials, the `Authorization` header and signatures never reach a capture. `DynamoDBContext` shares the client and is covered with it.

A client created **before** `AddDynamoDB` has no pipeline handler, but it still asks the SDK's global tracer provider (`AWSConfigs.TelemetryProvider`) for a span on every request, before sending it. The guard wraps that provider, delegating to whatever was registered, so such a client never writes silently: an action that is a write by name is blocked there (409, nothing sent), and a PartiQL request, whose statements the tracer can't read, fails the Preview with 500. Its reads run but aren't logged. A tracer provider the host registers after `AddDynamoDB` (an OpenTelemetry instrumentation, say) is wrapped again before the next Preview. A client given its own `TelemetryProvider` in its config bypasses the global one and is not covered; create clients after `AddDynamoDB` so the pipeline handler covers them fully.

`UpdateItem`, `PutItem` and `DeleteItem` are writes whatever their conditions or `ReturnValues`; `TransactWriteItems` and `BatchWriteItem` are writes even when they hold only condition checks. `ExecuteStatement`, `BatchExecuteStatement` and `ExecuteTransaction` are a read only when every statement is a `SELECT` (after whitespace and comments); anything else, or text it can't parse, is a write. PartiQL literals in `Db` entries become `?`.

## Mark an operation `preview: false`

An author who knows an operation writes to a guarded store can say so, so the workbench explains it before anyone runs it. Sendproof never infers the mark.

```csharp
// Minimal API
app.MapDelete("/sessions/{id}", Handler)
   .WithSendproofPreview(enabled: false, reason: "Clears the Redis session", "redis");

// MVC controller action
[SendproofPreview(Enabled = false, Reason = "Clears the Redis session", Stores = ["redis"])]
[HttpDelete("/sessions/{id}")]
public IActionResult DeleteSession(string id) => …;
```

The operation is listed under `previewUnavailable` in capabilities (not in `previewOperations`), a Preview of it never runs the handler, and Send and observed Send are unaffected.

## What a blocked Preview looks like

When the guard refuses a write, the command never reaches the store and the handler gets a `PreviewWriteBlockedException` (with `Store` and `Operation`). The Preview then answers 409 with `application/problem+json` and no `Preference-Applied`, whatever the handler made of the exception, even if it caught it and returned 200:

```json
{ "type": "about:blank", "title": "Preview unavailable", "status": 409, "code": "preview_unavailable",
  "detail": "Preview unavailable: this operation writes to Redis", "store": "redis", "operation": "INCR", "rolledBack": false }
```

The order is fixed: each store finishes (changes captured, transactions aborted), then the SQL transaction rolls back, and every step runs even if another failed. A failed abort or rollback, a recorded fault (a handler commit, an escaped write, an unattributed write) answers 500 without confirmation; otherwise a blocked write answers 409; otherwise the Preview is confirmed. A Preview whose handler throws after a blocked write still answers 409.

A raw `COMMIT`, `BEGIN` or similar statement through an EF Core context, and a handler calling `Database.CommitTransaction()` or `Database.RollbackTransaction()`, are refused during a Preview and fail it with 500 (MySQL's implicitly committing statements too). Rolling back to a savepoint stays allowed.

## MySQL Previews take turns

On MySQL and MariaDB the EF Core provider lets one Preview run at a time per process; see [verified databases](../../docs/bindings/databases.md#concurrent-previews-on-mysql-and-sqlite-run-one-at-a-time).

## Limits

- Redis, DynamoDB and a standalone MongoDB only block writes: they can't roll back.
- A client, collection or connection the hooks never saw is not covered. See [Coverage](#coverage-only-hooked-clients-are-covered).
- A DynamoDB client created before `AddDynamoDB` is checked only through the global tracer: its writes block and its PartiQL fails the Preview, but its reads aren't logged. Create clients after `AddDynamoDB`.
- `AddMongoDB` creates a second client from the registered one's settings; the registered one stays idle, and disposing the decorator disposes both.
- MongoDB transactions need a replica set or sharded cluster, are limited to 16 MB per document and the server's cache, and fail on the commands listed above.
- Reading the unattributed-write rule: it needs `AsyncLocal` flow. Code that suppresses the execution context (`ExecutionContext.SuppressFlow`) looks unattributed.
- Run the store tests with the compose services up: `docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb mysql`, then `dotnet test`. A test skips, with that command in its reason, when its service doesn't answer.
