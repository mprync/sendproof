# Data stores in the Go binding

Sendproof Preview promises that a confirmed Preview never leaves a write behind. For SQL, the `dbsql` provider guarantees it. For MongoDB, Redis and DynamoDB, the Go binding hooks each store's client, following the rules in [spec/data-stores.md](../../spec/data-stores.md):

| Store | Module | Mode | What a Preview does |
| --- | --- | --- | --- |
| MongoDB replica set or sharded cluster | `mongobench` | `preview` | Runs every command in one transaction, reports document changes, and aborts it. |
| MongoDB standalone server | `mongobench` | `guard` | Runs reads. The first write stops the Preview. |
| Redis (go-redis v9) | `redisbench` | `guard` | Runs reads. The first write stops the Preview. |
| DynamoDB (AWS SDK for Go v2) | `dynamobench` | `guard` | Runs reads. The first write stops the Preview. |

Each hook is a module of its own (`github.com/mprync/sendproof/adapters/go/redisbench` and so on), so an application only downloads the client libraries it uses. The shared write classification, tables and vectors are in the `stores` package of the core module. They are embedded from [spec/data-stores/](../../spec/data-stores/) by `go generate ./stores`, and a test fails when a copy differs.

Send and observed Send are never blocked. Their writes commit as usual, and an observed Send traces every store command as a `Db` log entry. These work with net/http, chi, Gin, Echo and GORM alike: the hooks live on the store clients, not on the router.

## Coverage: only hooked clients are covered

> [!WARNING]
> The binding covers a store only through the client you hook and only for calls that carry the request's context. Other clients are not covered: their writes are neither blocked nor rolled back. That includes a client created inside a handler, a second client for the same store, go-redis Pub/Sub connections, MongoDB change streams and GridFS, and rueidis. **Pass `r.Context()` (or a context derived from it) to every store call**, and hook every client your handlers use, at startup.

### Calls without the request's context

Go hands the request to a store call only through the context you pass. A hooked client called with `context.Background()` can't tell which request the call belongs to, so the guard can't block it and MongoDB can't put it in the Preview's transaction. The write runs. So that a Preview never confirms a rollback that didn't happen, such a write fails every Preview that is open at that moment with 500.

Writes made with the context of any other request that passed through `bench.Middleware` never fail a Preview. Background work that runs while Previews may be open, such as a job worker or a scheduled task writing through a hooked client, should mark its context:

```go
ctx := sendproof.Detached(context.Background()) // this work belongs to no request
rdb.Incr(ctx, "jobs:processed")
```

Use `sendproof.Detached` only outside request handlers. A handler that writes with a detached context escapes its Preview, like an unhooked client. Store calls on routes outside `bench.Middleware` count as unattributed too.

## Register the stores

Hook each client at startup and pass the stores to `sendproof.New`:

```go
// MongoDB: Connect installs the store's command monitor and returns only the guarded client.
catalog := mongobench.New(mongobench.WithName("catalog"))
mongoClient, _ := catalog.Connect(options.Client().ApplyURI(mongoURL))
defer mongoClient.Disconnect(context.Background())
documents := mongoClient.Database("catalog").Collection("documents") // handlers use this

// Redis: a go-redis hook.
rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
rdb.AddHook(redisbench.Hook())

// DynamoDB: an AWS SDK middleware, added to the client's API options.
cfg, _ := config.LoadDefaultConfig(ctx)
cfg.APIOptions = append(cfg.APIOptions, dynamobench.Middleware())
orders := dynamodb.NewFromConfig(cfg)

bench, _ := sendproof.New(
    sendproof.WithEnvironment("Development"),
    sendproof.WithProvider(db.Provider()), // the SQL provider is optional when stores are registered
    sendproof.WithDataStore(catalog),
    sendproof.WithDataStore(redisbench.Store("cache")),
    sendproof.WithDataStore(dynamobench.Store("orders")),
)
```

The name is the label the workbench shows. It must be a display name such as `catalog`, never a URL, host name or credentials; a value that looks like one panics at startup (the constructors take startup configuration, like `regexp.MustCompile`).

`sendproof.WithProvider` is optional when you register data stores. An application whose only database is MongoDB, or that has only Redis or DynamoDB, can Preview without a SQL provider: MongoDB rolls back its own transaction and the guarded stores block writes. A SQL database you give no provider for is then not covered, like any unhooked client. With several SQL providers, Preview stays unavailable.

Use `sendproof.WithFramework("chi")` (or `"Gin"`, `"Echo"`) so the workbench writes its `preview: false` snippet for your framework; the default is `net/http`.

### MongoDB

`mongobench.Store.Connect` creates the client and returns a guarded `*mongobench.Client`. Its `Database` and `Collection` handles have the driver's own method names (`InsertOne`, `UpdateOne`, `Aggregate`, `FindOne` and so on). A method the guarded handle does not have is not offered, so it cannot be called unguarded by accident. `Distinct` also returns an `error`, because a `DistinctResult` cannot carry the error of a refused call.

- Prefer `store.Connect(opts)`: the application then never holds an unguarded `*mongo.Client`. When the client is built elsewhere, create it with `mongo.Connect(store.ClientOptions(opts))` and wrap it with `store.Client(client)` or `store.Database(client.Database(name))`. The store relies on command monitoring on that client; a Preview without it answers 500 rather than run unmonitored.
- During a Preview in `preview` mode each call joins the Preview's transaction (snapshot read concern, majority write concern). A call that passes a different session in its context is refused, and the Preview answers 500.
- `Client.StartSession(ctx)` and `Client.UseSession` join the Preview transaction. `Session.StartTransaction` is a no-op and `WithTransaction` runs its body in the Preview's transaction. During a Preview the context these give your function carries no driver session (`mongo.SessionFromContext` returns `nil`): the guarded handles add the Preview's session to each call, and the Preview's transaction is never within reach of handler code. Outside a Preview, `Session.Context(ctx)` binds your own session for the calls between `StartTransaction` and `CommitTransaction`. `CommitTransaction`, `AbortTransaction` and a raw `{commitTransaction: 1}` or `{abortTransaction: 1}` through `Database.RunCommand` are refused before they are sent and fail the Preview with 500, like a raw SQL `COMMIT`. If one reaches the server by another route, such as a raw client given the request's context, the command monitor sees it and fails the Preview with 500, because it may have committed the Preview's writes.
- A pipeline given to `Aggregate` is scanned at any depth (`$facet`, `$lookup` and `$unionWith` sub-pipelines included) for `$out` and `$merge` before anything is sent.
- A Preview may hold its transaction for `WithPreviewTimeout`, 50 seconds by default (below MongoDB's 60-second transaction lifetime). A handler still running at the limit loses the transaction: its later commands fail, nothing commits, and the Preview answers 500. Once a Preview has ended for any reason, its guarded handles refuse every further call. A call already past that check when the Preview ends finishes inside the transaction first: the abort waits for it, so no call reaches the server after the abort, when the session has no transaction and the write would commit on its own.
- The monitor also sees a write that a raw `*mongo.Client` makes with the request's context. It carries no Preview session, so the Preview answers 500 and never claims a rollback it did not do. That is a safety net, not coverage: the write has already happened. Use the guarded handles in previewed handlers.
- An existing client monitor is kept: `ClientOptions` chains it.

### Redis

`redisbench.Hook()` returns a go-redis v9 hook (`Client`, `ClusterClient` and `Ring` all take `AddHook`). Pipelines and `TxPipeline` batches are classified as a whole before the first command is written, so a refused write sends no command of the batch, not even `MULTI`. Connection-setup commands (`AUTH`, `HELLO`, `SELECT`, `CLIENT SETINFO`, `CLIENT MAINT_NOTIFICATIONS`) are never guarded or logged.

### DynamoDB

`dynamobench.Middleware()` adds one middleware at the SDK's Initialize step, which runs before a request is serialized and signed, so credentials, the `Authorization` header and signatures never reach a capture. Adding it twice to the same client is refused.

## Mark an operation `preview: false`

An operation you know writes to a guarded store, such as one that clears a Redis session, can be marked `preview: false`. The workbench then shows "Preview unavailable" with your reason before anyone tries, and a Preview of it is refused (HTTP 409, without running the handler). Send still runs it. The binding never infers the mark; without it the operation is advertised and the guard decides at run time.

```go
// net/http: registers the route and marks it
bench.HandleUnavailable(mux, "DELETE /sessions/{id}", "Clears the Redis session", deleteSession)

// With only the stores, the reason is "Preview unavailable: this operation writes to Redis"
bench.HandleUnavailable(mux, "DELETE /sessions/{id}", "", deleteSession, sendproof.ForStores("redis"))

// chi, Gin, Echo: register the handler as usual, and mark the operation
r.Delete("/sessions/{id}", deleteSession)
bench.Unavailable(http.MethodDelete, "/sessions/{id}", "Clears the Redis session", sendproof.ForStores("redis"))
```

## What a blocked Preview returns

When the guard refuses a write, the command never reaches the store and the handler gets a `*sendproof.PreviewWriteBlockedError` (with `Store`, `Operation` and `Reason`). The Preview then answers 409 with `application/problem+json`, whatever the handler made of the error, including a handler that catches it and answers 200 or panics with it:

```json
{ "type": "about:blank", "title": "Preview unavailable", "status": 409, "code": "preview_unavailable",
  "detail": "Preview unavailable: this operation writes to Redis", "store": "redis", "operation": "INCR", "rolledBack": false }
```

The SQL transaction rolls back as usual. A failed rollback or abort, a handler `COMMIT` or `commitTransaction`, a write that escaped the MongoDB session, or a store write sent without a request context while the Preview ran answers 500 without confirmation instead; the failure outranks a blocked write.

In `preview` mode MongoDB blocks only what a transaction can't run, such as `$out`, `$merge`, `count` (`EstimatedDocumentCount`), an explicit `create` (`CreateCollection`) or `listCollections`, with a reason like "Preview unavailable: MongoDB can't run $out inside a transaction".

## Host-declared reads

Each hook takes `TreatAsRead`, a list of exact command names the guard should let through, such as a custom Redis module read:

```go
rdb.AddHook(redisbench.Hook(redisbench.TreatAsRead("MYMODULE.GET")))
```

> [!WARNING]
> `TreatAsRead` is your statement that the command never writes. The guard trusts it: a listed command that does write is not blocked, and its write happens during the Preview. Names match exactly, with no wildcards.

## MongoDB limits

These come from MongoDB's transaction limits; see [MongoDB in Preview](../../spec/data-stores.md#mongodb-in-preview).

- A Preview whose handler runs longer than the Preview timeout (50 seconds by default) fails with 500, and nothing is written.
- Two Previews that write the same document don't queue: the second gets a `WriteConflict`, and the handler decides what to answer. The Preview still rolls back.
- Keep a Preview under about 1,000 changed documents.
- Document `before` images are read at the Preview transaction's snapshot time, so a concurrent commit by another request never shows up as a change.
- `CreateCollection` fails inside a Preview, because MongoDB refuses an explicit `create` in a transaction with snapshot read concern. Inserting into a new collection creates it and rolls back.
- Each Preview keeps the mode it began in. A Preview that began without a transaction (a standalone server, or detection failing) never treats its writes as joining one.

## Logs and redaction

Every store command in a Preview or observed-Send trace is a `Db` log entry with the store, operation, target, sanitized statement, rows and time. Statements never carry values: MongoDB statements keep field names and operators with every literal as `"?"`, Redis statements keep the command and key names (`SET session:42 ?`), and DynamoDB statements are the PartiQL text with every inline string or number literal replaced by `?`. Session commands such as `AUTH` and `hello` are never logged.

Change records for MongoDB carry `store`, `namespace`, the collection as `table`, `{ _id }` as `key`, and whole nested documents as `before` and `after` in MongoDB Extended JSON (relaxed). A field with a secret name, such as `password_hash` or `apiKey`, is `"[REDACTED]"` at any depth. `via` is `"upsert"` or `"replace"` when the change came from an upsert or a whole-document replacement.

## Discovery

Capabilities list each registered store with its mode (`dataStores`), the operations marked `preview: false` (`previewUnavailable`), the binding (`binding`: `go` and the framework) and the SQL engine (`database.system`, such as `sqlite` or `postgresql`).

## Running the tests

```sh
docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb
adapters/go/scripts/test.sh                 # vet and race tests of every module
node tests/conformance/run.mjs go-net-http  # after adapters/go/scripts/build-fixture.sh
```

The store tests skip, with the compose command in the reason, when their service does not answer.
