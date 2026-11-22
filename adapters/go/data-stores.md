# Data stores in the Go binding

Sendproof Preview promises that a confirmed Preview never leaves a write behind. For SQL, the `dbsql` provider guarantees it. For the other stores, the Go binding hooks each store's client, following the rules in [spec/data-stores.md](../../spec/data-stores.md):

| Store | Module | Mode | What a Preview does |
| --- | --- | --- | --- |
| MongoDB replica set or sharded cluster | `mongobench` | `preview` | Runs every command in one transaction, reports document changes, and aborts it. |
| MongoDB standalone server | `mongobench` | `guard` | Runs reads. The first write stops the Preview. |
| Redis (go-redis v9) | `redisbench` | `guard` | Runs reads. The first write stops the Preview. |
| DynamoDB (AWS SDK for Go v2) | `dynamobench` | `guard` | Runs reads. The first write stops the Preview. |
| Cassandra and ScyllaDB (`cassandra-gocql-driver/v2`, imported as `gocql`) | `cassandrabench` | `guard` | Runs reads. The first write, every batch included, stops the Preview. |
| Elasticsearch (`go-elasticsearch` 8 and later) | `searchbench` | `guard` | Runs reads. The first write stops the Preview. |
| OpenSearch (`opensearch-go` 4 and later) | `searchbench` | `guard` | Runs reads. The first write stops the Preview. |
| Azure Cosmos DB for NoSQL (`azcosmos`) | `cosmosbench` | `guard` | Runs reads. The first write stops the Preview. |
| Google Cloud Firestore (`cloud.google.com/go/firestore`, gRPC) | `firestorebench` | `guard` | Runs reads. The first write stops the Preview. |

Each hook is a module of its own (`github.com/mprync/sendproof/adapters/go/redisbench` and so on), so an application only downloads the client libraries it uses. The shared write classification, tables and vectors are in the `stores` package of the core module. They are embedded from [spec/data-stores/](../../spec/data-stores/) by `go generate ./stores`, and a test fails when a copy differs.

Send and observed Send are never blocked. Their writes commit as usual, and an observed Send traces every store command as a `Db` log entry. These work with net/http, chi, Gin, Echo and GORM alike: the hooks live on the store clients, not on the router.

## Coverage: only hooked clients are covered

> [!WARNING]
> The binding covers a store only through the client you hook and only for calls that carry the request's context. Other clients are not covered: their writes are neither blocked nor rolled back. That includes a client created inside a handler, a second client for the same store, go-redis Pub/Sub connections, MongoDB change streams and GridFS, rueidis, and a raw `*gocql.Session`, an Elasticsearch, OpenSearch, Cosmos DB or Firestore client built without its guard. **Pass `r.Context()` (or a context derived from it) to every store call**, and hook every client your handlers use, at startup.

### Calls without the request's context

Go hands the request to a store call only through the context you pass. A hooked client called with `context.Background()` can't tell which request the call belongs to, so MongoDB can't put it in the Preview's transaction. The same holds for a client's own background goroutine, such as a Firestore `BulkWriter`, a bulk indexer or a goroutine your handler started without the context. While any Preview is open, such a write to a guarded store (Redis, DynamoDB, Cassandra, Elasticsearch, OpenSearch, Cosmos DB, Firestore, a standalone MongoDB server) is taken to be that Preview's write: it is **refused before it is sent**, exactly like a write with the request's context, and every open Preview answers 409. MongoDB's guarded handles refuse such a write before sending too, and every open Preview answers 409 in either mode, because nothing reached the server. Only a raw `*mongo.Client` outside the guard is left to the monitor, which sees the write after it was sent and fails every open Preview with 500.

A write that carries the context of a Preview that has **ended**, such as from a goroutine the handler started with `context.WithoutCancel(r.Context())` that is still running after the response, is refused before it is sent, for as long as the process runs: the context stays marked as a Preview. A goroutine that dropped the context and writes after every Preview has ended can't be told apart from background work, and is not refused.

Clients that queue writes and send them later (a Firestore `BulkWriter`, an Elasticsearch or OpenSearch bulk indexer) must be refused when the write is queued, on the caller's goroutine, not when the batch is sent. Use `firestorebench.NewBulkWriter` and `searchbench.ElasticsearchBulkIndexer` / `OpenSearchBulkIndexer`, whose queueing methods take the caller's context and refuse there. An unwrapped one is refused only when it sends, while some Preview is open; the refusal is never retried, so its flush or close returns.

Writes made with the context of any other request that passed through `bench.Middleware` are never refused for this reason. Background work that runs while Previews may be open, such as a job worker or a scheduled task writing through a hooked client, must mark its context, or it is refused while a Preview is open:

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

// Cassandra: Connect creates the gocql session and returns only the guarded wrapper.
cluster := gocql.NewCluster("cassandra:9042")
cluster.Keyspace = "inventory"
tickets, _ := cassandrabench.Connect(cluster) // handlers use this
defer tickets.Close()

// Elasticsearch or OpenSearch: wrap the client's Transport (its Perform interface).
es, _ := elasticsearch.NewClient(elasticsearch.Config{Addresses: []string{esURL}})
es.Transport = searchbench.ElasticsearchTransport(es.Transport)
os, _ := opensearchapi.NewClient(opensearchapi.Config{Client: opensearch.Config{Addresses: []string{osURL}}})
os.Client.Transport = searchbench.OpenSearchTransport(os.Client.Transport)

// Cosmos DB: an azcore per-call policy in the client options.
cosmos, _ := azcosmos.NewClientFromConnectionString(connection, cosmosbench.ClientOptions(nil))

// Firestore: a gRPC unary and stream interceptor, as client options.
fs, _ := firestore.NewClient(ctx, project, firestorebench.ClientOptions()...)

bench, _ := sendproof.New(
    sendproof.WithEnvironment("Development"),
    sendproof.WithProvider(db.Provider()), // the SQL provider is optional when stores are registered
    sendproof.WithDataStore(catalog),
    sendproof.WithDataStore(redisbench.Store("cache")),
    sendproof.WithDataStore(dynamobench.Store("orders")),
    sendproof.WithDataStore(cassandrabench.Store("tickets")),
    sendproof.WithDataStore(searchbench.Store("articles")),                          // searchbench.OpenSearch() for OpenSearch
    sendproof.WithDataStore(cosmosbench.Store("orders")),
    sendproof.WithDataStore(firestorebench.Store("orders")),
)
```

The name is the label the workbench shows. It must be a display name such as `catalog`, never a URL, host name or credentials; a value that looks like one panics at startup (the constructors take startup configuration, like `regexp.MustCompile`).

`sendproof.WithProvider` is optional when you register data stores. An application whose only database is MongoDB, or that has only guarded stores, can Preview without a SQL provider: MongoDB rolls back its own transaction and the guarded stores block writes. A SQL database you give no provider for is then not covered, like any unhooked client. With several SQL providers, Preview stays unavailable.

Use `sendproof.WithFramework("chi")` (or `"Gin"`, `"Echo"`) so the workbench writes its `preview: false` snippet for your framework; the default is `net/http`.

### MongoDB

`mongobench.Store.Connect` creates the client and returns a guarded `*mongobench.Client`. Its `Database` and `Collection` handles have the driver's own method names (`InsertOne`, `UpdateOne`, `Aggregate`, `FindOne` and so on). A method the guarded handle does not have is not offered, so it cannot be called unguarded by accident. `Distinct` also returns an `error`, because a `DistinctResult` cannot carry the error of a refused call.

- Prefer `store.Connect(opts)`: the application then never holds an unguarded `*mongo.Client`. When the client is built elsewhere, create it with `mongo.Connect(store.ClientOptions(opts))` and wrap it with `store.Client(client)` or `store.Database(client.Database(name))`. The store relies on command monitoring on that client; a Preview without it answers 500 rather than run unmonitored.
- During a Preview in `preview` mode each call joins the Preview's transaction (snapshot read concern, majority write concern). A call that passes a different session in its context is refused, and the Preview answers 500.
- `Client.StartSession(ctx)` and `Client.UseSession` join the Preview transaction. `Session.StartTransaction` is a no-op and `WithTransaction` runs its body in the Preview's transaction. During a Preview the context these give your function carries no driver session (`mongo.SessionFromContext` returns `nil`): the guarded handles add the Preview's session to each call, and the Preview's transaction is never within reach of handler code. Outside a Preview, `Session.Context(ctx)` binds your own session for the calls between `StartTransaction` and `CommitTransaction`. `CommitTransaction`, `AbortTransaction` and a raw `{commitTransaction: 1}` or `{abortTransaction: 1}` through `Database.RunCommand` are refused before they are sent and fail the Preview with 500, like a raw SQL `COMMIT`. If one reaches the server by another route, such as a raw client given the request's context, the command monitor sees it and fails the Preview with 500, because it may have committed the Preview's writes.
- A pipeline given to `Aggregate` is scanned at any depth (`$facet`, `$lookup` and `$unionWith` sub-pipelines included) for `$out` and `$merge` before anything is sent.
- A Preview may hold its transaction for `WithPreviewTimeout`, 50 seconds by default (below MongoDB's 60-second transaction lifetime). A handler still running at the limit loses the transaction: its later commands fail, nothing commits, and the Preview answers 500. Once a Preview has ended for any reason, its guarded handles refuse every further call. A call already past that check when the Preview ends finishes inside the transaction first: the abort waits for it, so no call reaches the server after the abort, when the session has no transaction and the write would commit on its own.
- The driver ignores a failed `AbortTransaction`, and the server would then keep the transaction and its locks until its 60-second lifetime limit. The store checks the server's own answer through the command monitor: the abort counts only when the server acknowledged it or answered that the transaction no longer exists (`NoSuchTransaction`). When a command was sent on the Preview session and the abort got no such answer (the connection dropped), the Preview answers 500 at once, and in the background the store ends the transaction with `killSessions` on the Preview's session, retrying with backoff (100 ms doubling to 2 s) for up to 10 s. Each try gives up after 2 s, or the time left, so a server that can't be reached is retried rather than waited on for the driver's 30-second server selection timeout. If that fails too it logs a `slog` warning with the session id, and the server ends the transaction at its lifetime limit. The session is ended only after that, so the driver can't reuse its id meanwhile. A Preview whose abort was acknowledged sends no `killSessions`. Nothing is committed either way: no `commitTransaction` is ever sent for a Preview session.
- When the `hello` that detects the topology can't be sent or answered, discovery reports `guard` mode with `mongobench.UnreachableReason`, "Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, so this Preview runs in guard mode", and the store detects again on the next Preview. A server that answers as a standalone gets `mongobench.StandaloneReason`, "Preview unavailable: this MongoDB server doesn't support transactions".
- The monitor also sees a write that a raw `*mongo.Client` makes with the request's context. It carries no Preview session, so the Preview answers 500 and never claims a rollback it did not do. That is a safety net, not coverage: the write has already happened. Use the guarded handles in previewed handlers.
- An existing client monitor is kept: `ClientOptions` chains it.

### Redis

`redisbench.Hook()` returns a go-redis v9 hook (`Client`, `ClusterClient` and `Ring` all take `AddHook`). Pipelines and `TxPipeline` batches are classified as a whole before the first command is written, so a refused write sends no command of the batch, not even `MULTI`. Connection-setup commands (`AUTH`, `HELLO`, `SELECT`, `CLIENT SETINFO`, `CLIENT MAINT_NOTIFICATIONS`) are never guarded or logged.

### DynamoDB

`dynamobench.Middleware()` adds one middleware at the SDK's Initialize step, which runs before a request is serialized and signed, so credentials, the `Authorization` header and signatures never reach a capture. Adding it twice to the same client is refused.

### Cassandra and ScyllaDB

`gocql.Session` is a struct with no hook before a statement is sent (a `QueryObserver` runs afterwards), so the guard is a wrapper and the spike's fallback applies: **handlers use `cassandrabench.Session`**, which has gocql's own method names (`Query`, `Bind`, `Batch`, `ExecuteBatch`, `Exec`, `Scan`, `MapScan`, `ScanCAS`, `Iter`, `WithContext`, `Consistency`, `PageSize` and the rest). A method gocql's `Query`, `Batch` or `Session` has and the wrapper does not is not offered, and every query or batch derived from the wrapper stays guarded.

- The wrapper sits above the driver's own prepare, so it classifies the CQL text of every call, prepared or not. `SELECT`, `USE`, `DESCRIBE` and `LIST ROLES`-style statements are reads. Every `BATCH` is a write (an empty one too), and so is a lightweight transaction (`IF NOT EXISTS`, `IF EXISTS`, `IF <condition>`), `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, DDL, `GRANT` and `REVOKE`. A text with a second statement after a semicolon, an unterminated quote or comment, or no statement at all is a write.
- Prefer `cassandrabench.Connect(cluster)`: the application then never holds a raw `*gocql.Session`. `cassandrabench.Wrap(session)` guards a session built elsewhere, but the caller's own reference to the raw session stays unguarded.
- Give each call the request's context: `Query(...).WithContext(r.Context())`, or `ExecContext`, `ScanContext` and `IterContext`.
- A `Query.Iter()` or `Batch.Iter()` returns `*cassandrabench.Iter`, which has `Scan`, `MapScan`, `Close`, `Columns`, `NumRows`, `PageState`, `WillSwitchPage` and `Scanner`. After a refused statement its `Close` returns the refusal.
- The Db entry has `target` (the table), `namespace` (the keyspace) and a statement with every quoted string, `$$` string, number, hex and UUID literal replaced by `?`. Bound values are never logged. A batch sent outside a Preview is logged as `BEGIN BATCH <statement>; …; APPLY BATCH`.
- ScyllaDB's own fork (`github.com/scylladb/gocql`) has another import path and types, so the wrapper does not take it.

### Elasticsearch and OpenSearch

go-elasticsearch (`Client`, `TypedClient` and `BaseClient`) and opensearch-go (`opensearch.Client`, which `opensearchapi.Client` holds) send every request through an exported `Transport` field, their Perform interface, which sits above the connection pool and the retry loop. The guard wraps that field: `es.Transport = searchbench.ElasticsearchTransport(es.Transport)`, `os.Client.Transport = searchbench.OpenSearchTransport(os.Client.Transport)`. The classic and typed APIs, bulk indexers, `Perform` and opensearch-go's `Stream` are covered, and so is every client that shares the wrapped Transport (`elasticsearch.NewTypedFrom` copies it, so wrap first). The wrapper forwards `Metrics`, `DiscoverNodes`, `Close` and instrumentation to the client's own transport; wrapping twice returns the same wrapper.

- Because the refusal happens above the pool, a refused write never marks a node dead and is never retried: other requests, including ordinary traffic outside any Preview, keep every node in rotation (a two-node test checks both clients).
- Pass `searchbench.OpenSearch()` to `Store` so the store reports `opensearch` (the default is `elasticsearch`) in discovery; `OpenSearchTransport` and `OpenSearchBulkIndexer` report `opensearch` in Db entries and the 409 body already.
- A bulk indexer queues items and sends them later from its own goroutines, with its own context. Wrap it with `searchbench.ElasticsearchBulkIndexer(indexer)` or `searchbench.OpenSearchBulkIndexer(indexer)`: `Add` refuses an item during a Preview, or with no request while a Preview is open, on the caller's goroutine before it is queued (operation `bulk`), so nothing is left to flush and `Close` returns at once. An unwrapped indexer is guarded only when it flushes: the flush is refused while some Preview is open, without retries, so `Close` does not hang; a flush that runs after every Preview has ended is sent.
- The shared table classifies by HTTP method and path: `GET` and `HEAD` read, a `POST` to `_search`, `_msearch`, `_count`, `_mget` or `_field_caps` is a read, and `_bulk`, `_update_by_query`, `_delete_by_query`, `_reindex`, every `PUT`, document writes, stored scripts and index, alias and template changes are writes. The SQL endpoints (`_sql`, `_plugins/_sql`) read only for one `SELECT`, `SHOW` or `DESCRIBE`, or the next page of a cursor; the guard reads that request's body (up to 1 MiB, gzip included) and a larger or unreadable one is a write.
- A cluster behind a proxy path (`https://host/search`) needs nothing extra: the client adds the address's path after the guard has classified the request.
- The Db entry's statement is the request body with every literal replaced by `"?"` (one line per document for `_bulk` and `_msearch`), and `target` is the first path segment that names an index. The path is not logged, because it can hold document ids.
- Other Go clients (olivere/elastic, a plain `http.Client`) are not guarded.

### Cosmos DB

`azcosmos` builds its HTTP pipeline on azcore, whose client options take policies that run before a request is sent. `cosmosbench.ClientOptions(base)` returns a copy of `base` (nil for none) with the guard added to `PerCallPolicies`; or append `cosmosbench.Policy()` to your own options. The policy is public azcore API, so it does not depend on azcosmos internals, and the databases, containers and items derived from the client share its pipeline.

- The operation comes from the method, the resource path and the SDK's headers, with the rules in `spec/data-stores/cosmosdb.json`: `Read`, `ReadFeed`, `Query` and `QueryPlan` are reads; `Create`, `Upsert`, `Replace`, `Patch`, `Delete`, `Batch` (transactional or bulk) and stored procedure `ExecuteJavaScript` are writes, and a request that names a trigger is a write whatever it is.
- The Db entry has `target` (the container), `namespace` (the database) and, for a query, its text with inline literals replaced by `?`. Parameter values, documents, the `Authorization` header and the account key are never captured.
- It covers the NoSQL API only; the Cosmos DB APIs for MongoDB, Cassandra, Gremlin and Table are other stores (use `mongobench` or `cassandrabench` for the first two).
- With no emulator in CI, the hook is proven by replaying the requests recorded from a real SDK (`spec/data-stores/recordings/cosmosdb.json`) through an azcore pipeline over a fake transport, and by driving the real `azcosmos` client the same way.

### Firestore

The Go client speaks gRPC only. `firestorebench.ClientOptions()` returns the two dial options as client options for `firestore.NewClient`, `apiv1.NewClient` and `firebase.App.Firestore` (`firestorebench.DialOptions()` returns them as plain gRPC dial options). **Both are needed**: `RunQuery`, `BatchGetDocuments` and `Listen` are streams and `Write` is a bidirectional stream, so a unary-only interceptor lets `Write` through. The stream interceptor refuses a write stream before it is opened, so its first message is never sent.

- Reads are `GetDocument`, `ListDocuments`, `BatchGetDocuments`, `RunQuery`, `RunAggregationQuery`, `PartitionQuery`, `Listen` and `ListCollectionIds`. `BeginTransaction` and `Rollback` are allowed. A `Commit` is a write when it carries at least one write; a read-write transaction that only reads ends with a `Commit` that carries none and is allowed. `BatchWrite` (the bulk writer), `Write` and the document RPCs are writes, and so is any method of another service or API version, unless it is an admin `Get` or `List`.
- The Db entry's statement is the request message as JSON with every literal, document paths included, replaced by `"?"`; `target` is the collection. OAuth tokens and authorization metadata are never read.
- Every collection, document, query, transaction and batch of a client built with these options is guarded, because they share its connection.
- A `BulkWriter` queues writes and sends them later from its own goroutine, with the context it was created with and with retries. Use `firestorebench.NewBulkWriter(ctx, client)`: its `Create`, `Set`, `Update` and `Delete` take the caller's context and refuse a write during a Preview (or with no request while one is open) when it is queued, so nothing is left to send. A raw `client.BulkWriter(ctx)` is refused only when it sends, by its creation context: one created with a `Detached` context sends what a Preview's handler queued. The send-time refusal is not a retryable gRPC code, so `End` returns.
- The Datastore-mode and Firestore-in-Datastore APIs are not covered.
- With no emulator in CI, the hook is proven by replaying the requests recorded from a real SDK (`spec/data-stores/recordings/firestore.json`, recorded on the REST transport; the proto3 JSON body is the gRPC message) through the interceptors, and by driving the real `firestore` client against an in-process fake server.

## Unsupported

Everything the five batch-two stores' sections above do not name is not covered. In particular:

- **Cassandra:** ScyllaDB's `scylladb/gocql` fork, and any driver but `cassandra-gocql-driver/v2`.
- **Elasticsearch and OpenSearch:** only go-elasticsearch 8 and opensearch-go 4, whose clients expose their Perform interface as a `Transport` field.
- **Cosmos DB:** the non-NoSQL APIs, and Gremlin or Table clients.
- **Firestore:** the Datastore API, and a client built without `firestorebench.ClientOptions()`.

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

The SQL transaction rolls back as usual. A failed rollback or abort, a handler `COMMIT` or `commitTransaction`, or a write that escaped the MongoDB session (a MongoDB write sent without a request context included) answers 500 without confirmation instead; the failure outranks a blocked write.

In `preview` mode MongoDB blocks only what a transaction can't run, such as `$out`, `$merge`, `count` (`EstimatedDocumentCount`), an explicit `create` (`CreateCollection`) or `listCollections`, with a reason like "Preview unavailable: MongoDB can't run $out inside a transaction".

## Host-declared reads

The Redis, MongoDB and DynamoDB hooks take `TreatAsRead`, a list of exact command names the guard should let through, such as a custom Redis module read. The batch-two hooks (Cassandra, Elasticsearch, OpenSearch, Cosmos DB, Firestore) classify only with the shared tables and take no such list:

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

Every store command in a Preview or observed-Send trace is a `Db` log entry with the store, operation, target, sanitized statement, rows and time. Statements never carry values: MongoDB statements keep field names and operators with every literal as `"?"`, Redis statements keep the command and key names (`SET session:42 ?`), and DynamoDB statements are the PartiQL text with every inline string or number literal replaced by `?`. Cassandra statements are the CQL text with every literal replaced by `?`; Elasticsearch and OpenSearch statements are the request body with every literal as `"?"`; Cosmos DB statements are the query text with literals replaced by `?`; Firestore statements are the request message as JSON with every literal, document paths included, as `"?"`. Session commands such as `AUTH` and `hello` are never logged. The store ids for `sendproof.ForStores` and the 409 body are `cassandra`, `elasticsearch`, `opensearch`, `cosmosdb` and `firestore`, shown as Cassandra, Elasticsearch, OpenSearch, Cosmos DB and Firestore.

Change records for MongoDB carry `store`, `namespace`, the collection as `table`, `{ _id }` as `key`, and whole nested documents as `before` and `after` in MongoDB Extended JSON (relaxed). A field with a secret name, such as `password_hash` or `apiKey`, is `"[REDACTED]"` at any depth. `via` is `"upsert"` or `"replace"` when the change came from an upsert or a whole-document replacement.

## Discovery

Capabilities list each registered store with its mode (`dataStores`), the operations marked `preview: false` (`previewUnavailable`), the binding (`binding`: `go` and the framework) and the SQL engine (`database.system`, such as `sqlite` or `postgresql`).

## Guard-only limits

Cassandra, Elasticsearch, OpenSearch, Cosmos DB and Firestore have no rollback that an arbitrary handler can use (see [Batch two stores](../../spec/data-stores.md#batch-two-stores)), so a Preview of a handler that writes to one answers 409 and nothing is written; Send is never blocked. Mark an operation you know writes to one `preview: false` (see above) to show the reason before anyone tries. A handler that must write to one of these stores and can't be Previewed is the normal case, not a failure of the hook.

## Running the tests

```sh
docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb
docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra opensearch
adapters/go/scripts/test.sh                 # vet and race tests of every module
node tests/conformance/run.mjs go-net-http  # after adapters/go/scripts/build-fixture.sh
```

The store tests skip, with the compose command in the reason, when their service does not answer (`BENCH_CASSANDRA_SERVER` as `host:port` and `BENCH_OPENSEARCH_SERVER_URL` point the Cassandra and OpenSearch tests elsewhere; the Elasticsearch, Cosmos DB and Firestore tests use fakes and need no service). Cassandra and OpenSearch need about 3 GB of free Docker disk and 4 GB of memory, and CI runs them in its heavy-stores job; set `BENCH_STORES=mongodb,redis,dynamodb` to run the conformance checks without them.
