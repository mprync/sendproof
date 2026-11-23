# Data stores in the PHP binding

Sendproof Preview promises that a confirmed Preview never leaves a write behind. For SQL, the rollback provider guarantees it. For MongoDB, Redis, DynamoDB, Elasticsearch, OpenSearch and Firestore, the PHP binding hooks each store's client, following the rules in [spec/data-stores.md](../../spec/data-stores.md). It works in Laravel and Symfony, and the hooks live in `sendproof/core`, so a plain PHP application can use them too.

| Store | Client | Mode | What a Preview does |
| --- | --- | --- | --- |
| MongoDB replica set or sharded cluster | `mongodb/laravel-mongodb` connection; `mongodb/mongodb` library | `preview` | Runs every command in one transaction, reports document changes, and aborts it. |
| MongoDB standalone server | the same | `guard` | Runs reads. The first write stops the Preview. |
| Redis | Predis; phpredis through Laravel's Redis manager | `guard` | Runs reads. The first write stops the Preview. |
| DynamoDB | `aws/aws-sdk-php` `DynamoDbClient` | `guard` | Runs reads. The first write stops the Preview. |
| Elasticsearch | `elasticsearch/elasticsearch` 8 and 9 `Client` | `guard` | Runs reads, including searches sent as a `POST`. The first write stops the Preview. |
| OpenSearch | `opensearch-project/opensearch-php` 2 `Client`, on its PSR-18 transport or its legacy `ClientBuilder` transport | `guard` | Runs reads, including searches sent as a `POST`. The first write stops the Preview. |
| Firestore | `google/cloud-firestore` 2 `FirestoreClient` (needs `ext-grpc`) | `guard` | Runs reads. The first write stops the Preview. |

A Preview never changes a guard-only store. It can read or stop at the first write with HTTP 409.

### Preview session limits

The PHP adapter rolls back PDO or DBAL transactions for SQLite, MySQL, MariaDB, SQL Server and PostgreSQL within each request. The MongoDB hook aborts its driver session on the same schedule. Both run with `previewSessions: false`. Octane or FrankenPHP worker mode could support holding those transactions in a future release. Standalone MongoDB, Redis, DynamoDB, Elasticsearch, OpenSearch and Firestore use guard mode.

### Stores the PHP binding doesn't support

| Store | Why |
| --- | --- |
| Cassandra | No maintained PHP driver: the DataStax PHP extension is unmaintained, and nothing else gives a hook at the statement level. A handler that writes to Cassandra is not guarded. Mark such an operation `preview: false`. |
| Azure Cosmos DB | Microsoft ships no PHP SDK, so there is no client to hook. A handler that calls the REST API directly is not guarded. Mark such an operation `preview: false`. |

Their classification tables (`cassandra.json`, `cosmosdb.json`) are embedded in `core/src/Stores/Tables.php` so the parity test covers every table of the batch, but nothing in the binding uses them.

Send and observed Send are never blocked. Their writes commit as usual, and an observed Send traces every store command as a `Db` log entry.

The MongoDB hook needs `ext-mongodb` 1.21 or later (2.x with `mongodb/mongodb` 2.1 or later). phpredis needs `ext-redis`. The Firestore client needs `ext-grpc` and `ext-protobuf` is recommended. Install the client packages you use; Sendproof lists them as suggestions and loads a hook only when its package is present.

## Coverage: only hooked clients are covered

> [!WARNING]
> The binding covers a store only through the client you hook. Other clients are not covered: their writes are neither blocked nor rolled back. That includes a client you create inside a handler, a second client for the same store, a phpredis `\Redis` object you build yourself (Symfony Cache creates its own), the raw phpredis client behind `Redis::connection()->client()`, and a raw socket. Hook every client your handlers use, at startup.

One case the driver makes visible: the MongoDB extension pools clients that have the same URI and options, and command monitoring sees every command of a pooled client. A second, unhooked `MongoDB\Client` with the same connection string as a hooked one therefore shares its monitor, and a write through it during a Preview is caught as what it is, a write that escaped the Preview session and committed: the Preview answers 500 rather than claim a rollback. Two hooked clients on one URI don't interfere: each command is handled once, by the Preview transaction its session belongs to.

Each MongoDB hook proves its monitor is installed on its own client: its topology `hello` carries a unique comment, and the hook must see it. When it doesn't (the subscriber was removed, say), discovery shows the store in `guard` mode with the reason "Sendproof's command monitor doesn't see this MongoDB client's commands", and a Preview answers 500 rather than run without the tripwire.

When the hook can't send its `hello` or get an answer, discovery shows the store in `guard` mode with the reason "Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, so this Preview runs in guard mode" (`MongoEngine::UNREACHABLE_REASON`), distinct from a standalone server's reason (`MongoEngine::STANDALONE_REASON`), and it asks again at the next Preview or discovery.

### A MongoDB abort that never reached the server

The driver ignores a failed `abortTransaction`, as the transactions specification requires, so the hook checks the server's own reply through monitoring: the abort counts only when the server acknowledged it or answered that the transaction no longer exists (`NoSuchTransaction`). When a command was sent on the Preview session and no reply acknowledged the abort (the connection dropped), the Preview answers 500 at once, and the session is held, so the driver can't reuse its id, until the hook ends the transaction with `killSessions`. Without that the transaction would hold its locks until the server's 60-second lifetime limit. A normal Preview sends no `killSessions`, and nothing is ever committed either way.

PHP has no background threads, so the kill runs from a shutdown function once the request is done. Under PHP-FPM it first calls `fastcgi_finish_request()`, so the client already has its 500 while the hook retries with backoff (100 ms doubling to 2 s) for about 10 s after the abort was lost. The driver doesn't recheck a server whose check failed for 5 seconds, so the kill can land up to 5 seconds after the network is back. The driver has no per-command timeout, so the hook can't bound a single try: with the default `serverSelectionTryOnce` a try against an unreachable server fails at once, or after `connectTimeoutMS` (10 s by default) for a host that drops packets. With `serverSelectionTryOnce=false` one try can take the whole `serverSelectionTimeoutMS`. If the server stays unreachable, a warning with the session id goes to the application's PSR-3 logger: Laravel's log, or Symfony's `logger` service. Without one (plain PHP), it goes to `error_log()`; pass your own logger with `MongoEngine::useLogger()`.

A long-lived worker (Octane, RoadRunner, FrankenPHP, a kept Symfony kernel) runs shutdown functions only when it exits, so the adapters also kill lost sessions once each request is done: Laravel in an `$app->terminating()` callback, which Octane runs after every request, and Symfony in a `kernel.terminate` listener. The kill then runs after the response is sent, and the worker takes its next request once it is done. A plain PHP long-lived worker should call `MongoEngine::endLostTransactions()` between requests. The hook also tries once more as the next Preview begins.

PHP serves one request at a time in each worker process, so every command a process sends while a Preview is open belongs to that Preview, and the Preview's scope lasts to the end of the request (terminating callbacks and `dispatchAfterResponse()` jobs included). There is no unattributed in-process write to fail on, and no detached marker to set. The spec's rule for writes with no request (a client's background writer) is met the same way: PHP has no background threads, so a deferred write, such as a Firestore `BulkWriter` flushed from a destructor, a shutdown function or an after-response callback, runs in the Preview's own request, finds the scope still open and is refused before it is sent (a unit test queues a write, lets the Preview end and flushes late). The same holds for any work the handler starts that writes after the response (`defer()`, `terminating()`, `kernel.terminate`, shutdown functions, after `fastcgi_finish_request()`): the ended Preview's scope stays marked as a Preview until the worker's next request begins, and tests show such a write refused on Elasticsearch, OpenSearch (both transports) and Firestore. A long-lived worker (Octane, RoadRunner, FrankenPHP, a kept Symfony kernel) starts a fresh scope with the next request, so code that stashes a closure in a long-lived service and runs it during a later request writes as that request; like a thread that dropped its context, it can't be told apart from that request's own work. Work in another process (a queue worker, an Octane task worker) uses that process's clients: it is not part of the Preview and not covered. Fiber or event-loop servers that run several requests in one process (ReactPHP, AMPHP, Swoole coroutines) are not supported.

## Register the stores

Hooks are installed only when Sendproof is enabled for the environment (`enabled` is true and the environment is listed). A disabled application never touches a client.

### Laravel

```php
// config/sendproof.php
'data_stores' => [
    'mongodb' => ['connection' => 'mongodb', 'name' => 'catalog'],
    'redis' => ['name' => 'cache'],
    'dynamodb' => ['clients' => [Aws\DynamoDb\DynamoDbClient::class], 'name' => 'orders'],
    'elasticsearch' => ['clients' => [Elastic\Elasticsearch\Client::class], 'name' => 'search'],
    'opensearch' => ['clients' => [OpenSearch\Client::class], 'name' => 'articles'],
    'firestore' => ['clients' => [Google\Cloud\Firestore\FirestoreClient::class], 'name' => 'docs'],
],
```

- `mongodb.connection` names a `mongodb/laravel-mongodb` connection. Its client and database are replaced in place by guarded ones, so Eloquent models, the query builder and `DB::connection('mongodb')` all use them. A connection rebuilt after `DB::purge()` or `DB::reconnect()` gets the same guarded client.
- `redis` hooks Laravel's Redis manager: every Predis or phpredis connection it creates afterwards is guarded, including the ones the cache, session and queue drivers use.
- `dynamodb.clients` lists container ids or class names of `DynamoDbClient` services. Every client the container resolves for them is hooked, including the new client a binding that isn't shared builds on each resolve. For a client the container doesn't hold, call `Sendproof::hookDynamoDb($client)` once, at startup.
- `elasticsearch.clients`, `opensearch.clients` and `firestore.clients` list container ids or class names of `Elastic\Elasticsearch\Client`, `OpenSearch\Client` and `Google\Cloud\Firestore\FirestoreClient` services. They work like `dynamodb.clients`: every client the container resolves is hooked, including the new client of a binding that isn't shared, and an id that resolves to anything else fails at startup. For a client the container doesn't hold, call `Sendproof::hookElasticsearch($client)`, `hookOpenSearch($client)` or `hookFirestore($client)` once, at startup. `elasticsearch` and `opensearch` also take `path_prefix` when the hosts carry a path (`https://proxy/search`).

`name` is the label the workbench shows. It must be a display name such as `catalog`, never a URL, host name or credentials; a value that looks like one is refused.

### Symfony

```yaml
# config/packages/sendproof.yaml
sendproof:
    enabled: true
    data_stores:
        mongodb: { clients: [app.mongo_client], name: catalog }
        redis: { clients: [app.predis], name: cache }
        dynamodb: { clients: [Aws\DynamoDb\DynamoDbClient], name: orders }
        elasticsearch: { clients: [app.elasticsearch], name: search }
        opensearch: { clients: [app.opensearch], name: articles }
        firestore: { clients: [app.firestore], name: docs }
```

Each id names a service. A Predis, DynamoDB, Elasticsearch, OpenSearch or Firestore service gets a service configurator that hooks it when the container builds it; a `MongoDB\Client` service is decorated under its own id, so everything that uses it gets the guarded client. An id that is not a service fails the container build. Sendproof builds every listed client at the start of a Preview, so the hooks are in place even for a handler that uses a client lazily.

The Symfony bundle guards Predis only. A phpredis `\Redis`, `\RedisArray` or `\RedisCluster` service, including the one Symfony Cache builds from a `redis://` DSN, is not covered: guarding it means a subclass that overrides every one of the extension's several hundred command methods, with no single send path to hook as Laravel's connection offers. Use a Predis client (`class: Predis\Client`, or `RedisAdapter::createConnection($dsn, ['class' => \Predis\Client::class])`) for the Redis your handlers write to, and list that service.

A Symfony kernel kept between requests (RoadRunner, FrankenPHP worker mode) resets the request's recorder through `kernel.reset` at the start of the next request, so a Preview's scope never reaches the next request's writes. The Laravel middleware does the same for Octane and other long-lived workers.

### Without a framework

```php
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\DynamoDb\DynamoGuard;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\MongoDb\MongoStore;
use Sendproof\Core\Stores\Redis\{PredisGuard, RedisHook};

$recorder = new Recorder();                                  // one per request
$guard = new Guard(fn () => $recorder);
PredisGuard::install($predis, new RedisHook($guard));        // hooks the client in place
DynamoGuard::install($dynamo, $guard);                       // adds a handler-list middleware
$mongo = MongoStore::hook($client, $guard, 'catalog');       // handlers use $mongo->client()
```

Pass the stores to `Sendproof\Core\Preview\PreviewRunner::run()` as its last argument.

`previewProvider` (the SQL provider) is optional when you hook stores. An application whose only database is MongoDB, or that has only Redis or DynamoDB, can Preview without one: MongoDB rolls back its own transaction and the guarded stores block writes. Set `'provider' => null` (Laravel) or `provider: null` (Symfony). A SQL database you give no provider for is then not covered, like any unhooked client.

### MongoDB with Laravel

Eloquent models, the query builder, `Schema` and `DB::connection('mongodb')->getCollection()` all go through the guarded database, so they join the Preview transaction. During a Preview:

- Every database and collection call adds the Preview session to its options. A call that passes its own session is refused, and the Preview answers 500.
- The handler's own `DB::connection('mongodb')->transaction()` (or a session from `getClient()->startSession()`) joins the Preview's. Its commit never reaches the server, so nothing the handler writes is committed. MongoDB has no savepoints, so a handler that **aborts** its joined transaction after writing in it can't be honoured: the Preview answers 500 instead of showing writes the handler undid.
- A raw `{ commitTransaction: 1 }` or `{ abortTransaction: 1 }` command through `command()` is refused before it is sent. One that reached the server around the hook (through the raw `Manager`) fails the Preview with 500, because it may have committed the Preview's writes.
- An aggregation with `$out` or `$merge` at any depth, an explicit `createCollection`, and `count` are blocked before they are sent, with a reason such as "Preview unavailable: MongoDB can't run $out inside a transaction". `countDocuments` works.
- GridFS (`getGridFSBucket()`, `selectGridFSBucket()`) is refused in every Preview. A bucket takes no session, so its uploads would commit outside the Preview transaction.
- A method the guard doesn't know is refused in a Preview. A unit test fails when `mongodb/mongodb` grows a public method that is neither guarded nor listed as inert.
- A Preview may hold its transaction for `preview_timeout_ms`, 50 seconds by default (below MongoDB's 60-second transaction lifetime). PHP can't interrupt a handler that is busy, so the limit is checked at every MongoDB command and again when the handler returns: past the limit the next command is refused, the transaction is aborted, and the Preview answers 500 without confirmation. A handler that hangs without sending a command holds the transaction until it returns or the server's own 60-second limit aborts it; nothing is committed either way.
- Once a Preview has ended, for any reason, the guarded handles refuse every further call with `PreviewTransactionControlException`, so code that still runs in the Preview's request (a terminating callback, an after-response job run inline) can't send anything on a session whose transaction is gone.
- A Preview that never reaches its end (`exit`, a fatal error, `max_execution_time`) still aborts: the driver aborts an open transaction when the session is freed at shutdown, PDO rolls back an open SQL transaction when the request ends, and the MySQL turn's lock file closes with the request. A transaction a long-lived worker still holds when the next Preview begins is aborted then.

`MongoDB\Laravel` runs its own listener that reports each command as a query event. Sendproof leaves those out of the `Sql` log: a MongoDB command is logged once, as a `Db` entry, with no values.

### MongoDB with the library

`MongoStore::hook()` returns a store whose `client()` is a `GuardedClient`, a `MongoDB\Client` with the library's own API. Handlers must use it, not the original client. `startSession()` returns a session the Preview adopts: every command sent with it moves onto the Preview's transaction, so `withTransaction()` and `startTransaction()` work and nothing of them commits.

### Redis

Laravel's Redis connections and Predis clients are hooked in place.

- **Predis**: a command processor catches every command a pipeline or `transaction()` callback queues, so a refused write throws inside the callback before anything is written. A connection decorator catches the rest: `executeRaw()`, hand-built commands and the buffer a pipeline writes, which is parsed and classified command by command before any byte of it is sent. A refused write inside `MULTI` discards the transaction. Cluster, replication and Sentinel clients keep their own connection class; the decorator goes on every node inside it and on the factory it creates new nodes with, so a node discovered later is guarded too. Those nodes let through the read-only topology commands the client sends by itself (`CLUSTER SLOTS` and the Sentinel lookups).
- **phpredis (Laravel)**: the connection's `command()`, `pipeline()` and `transaction()` classify each command before the client writes it. The pipeline or `MULTI` object a callback receives, and the client that `Redis::multi()` hands back, are wrapped, so a queued write throws before `exec()`, and the refusal sends `DISCARD`, so a handler that swallows it doesn't leave the connection queueing later commands. Subscribing is refused as a write.

Session commands (`AUTH`, `HELLO`, `SELECT`, `PING`…) are never guarded or logged, so the password never reaches a capture.

### DynamoDB

`DynamoGuard` adds one middleware at the start of the AWS SDK's handler list, which runs before a request is validated, serialised or signed, so credentials and signatures never reach a capture. `Marshaler`, `WriteRequestBatch` and the session handler all send through the client, so hooking it covers them.

### Elasticsearch and OpenSearch

One shared table (`elasticsearch.json`) classifies both engines by HTTP method and path, and the 409 and the `Db` entry report `elasticsearch` or `opensearch` as the store. A `POST` is not a write by itself: `_search`, `_msearch`, `_count`, `_mget` and the other read endpoints take their query in a `POST` body and run. `_bulk`, `_update_by_query`, `_delete_by_query`, `_reindex`, every document write and every index, alias, template and script change are writes, as is any request the table doesn't know. The SQL endpoints (`_sql`, `_plugins/_sql`) are reads only for a single `SELECT`, `SHOW` or `DESCRIBE`. Point-in-time and scroll handles are session state: they run and aren't logged. `treat_as_read` names an endpoint by its operation name, such as `update_by_query`.

- **Elasticsearch** (`elasticsearch/elasticsearch` 8 and 9): the transport sends every typed call, helper and raw `sendRequest()` through one PSR-18 client, and through an HTTPlug async client in async mode. `ElasticsearchGuard::install()` replaces both in place, so it covers a client that already exists; a refused async write throws from the call itself, before a promise exists. To build a client with the guard from the start, pass `ElasticsearchGuard::httpClient($inner, $guard)` to both `ClientBuilder::setHttpClient()` and `setAsyncHttpClient()`. Paths of the transport's own hosts (`https://host/search`) are ignored when classifying.
- **OpenSearch** (`opensearch-project/opensearch-php` 2): the library has two ways to send. `OpenSearchGuard::install()` finds which one a client uses and hooks it in place: the PSR-18 transport (`GuzzleClientFactory`, `SymfonyClientFactory`) gets a decorated HTTP client, and the legacy `ClientBuilder` transport (deprecated by the library since 2.4) gets a wrapped RingPHP handler on every connection and on the factory that makes more, so connections a sniffing pool discovers later are guarded too. A client with another kind of transport is refused at startup rather than left unguarded. To build a client with the guard from the start, use `OpenSearchGuard::httpClient()` with `TransportFactory::setHttpClient()`, or `OpenSearchGuard::handler()` with `ClientBuilder::setHandler()`. The library's `ClientBuilder` has no `setHttpClient()`; that exists only on the PSR-18 side.

The guard reads only the method, path, query and body of a request. It never reads or logs a header, an API key, a password or a signature, and a host name never reaches a `Db` entry.

### Firestore

`FirestoreGuard::install()` replaces the transport of the SDK's generated client, which `FirestoreClient`, `DocumentReference`, `Query`, `Transaction`, `BulkWriter` and the rest share. Every call of the SDK reaches the network through the four methods of gax's `TransportInterface`, over gRPC or REST alike, so the guard sees unary calls and streams, and `Write`, a bidirectional stream, is refused before it opens. Reads (`BatchGetDocuments`, `RunQuery`, `RunAggregationQuery`, `ListDocuments`, `ListCollectionIds`, `PartitionQuery`, `Listen`) run. `BeginTransaction` and `Rollback` hold and release a transaction and change no data, so they are allowed and not logged. `Commit` is a write when it carries at least one write; an empty `Commit` that ends a read-only transaction is allowed, and one the hook can't read is a write. `BatchWrite` and the document methods are writes, and so is a method of another service or API version; Admin methods are reads only when they start with `Get` or `List`. To build a client with the guard from the start, give `FirestoreGuard::transport($inner, $guard)` to the client's `transport` option.

The Admin client (`Google\Cloud\Firestore\Admin\V1\Client\FirestoreAdminClient`) and a generated V1 client used on its own are separate clients: pass them to `FirestoreGuard::install()` too, or they are not covered. Installing the Admin client also hooks its operations client, so cancelling or deleting a long-running operation is refused too (every `google.longrunning.Operations` method counts as a write, as a method of another service). Statements in `Db` entries are the request's proto3 JSON with every value replaced by `?`.

## Mark an operation `preview: false`

An operation you know writes to a guarded store, such as one that clears a Redis session, can be marked `preview: false`. The workbench then shows "Preview unavailable" with your reason before anyone tries, and a Preview of it is refused (409, never confirmed) without running the handler. Send still runs it. The binding never infers the mark; without it the operation is advertised and the guard decides at run time.

Give a `reason`, the `stores` it writes, or both. With only `stores`, the reason is "Preview unavailable: this operation writes to Redis" (for the first store).

```php
// Laravel
Route::delete('/sessions/{id}', DeleteSession::class)->sendproofPreview(false, 'Clears the Redis session');
Route::delete('/sessions/{id}', DeleteSession::class)->sendproofPreview(false, stores: ['redis']);
```

```php
// Symfony
#[AllowPreview(false, reason: 'Clears the Redis session')]
#[Route('/sessions/{id}', methods: ['DELETE'])]
public function delete(string $id): Response { … }
```

## What a blocked Preview returns

When the guard refuses a write, the command never reaches the store and the handler gets a `Sendproof\Core\Stores\PreviewWriteBlockedException` (with `store` and `operation`). The Preview then answers 409 with `application/problem+json`, whatever the handler made of the exception:

```json
{ "type": "about:blank", "title": "Preview unavailable", "status": 409, "code": "preview_unavailable",
  "detail": "Preview unavailable: this operation writes to Redis", "store": "redis", "operation": "INCR", "rolledBack": false }
```

The SQL transaction rolls back as usual. A failed rollback or abort, a handler `COMMIT` or `commitTransaction`, or a write that escaped the MongoDB session answers 500 without confirmation instead. During a Preview Sendproof also refuses any SQL statement that would end or escape the Preview transaction (`COMMIT`, `ROLLBACK`, `BEGIN`, `SET autocommit`, and on MySQL the statements it commits implicitly) before it reaches the database, and fails the Preview with 500 even if the handler catches the refusal. Savepoints stay allowed.

## Host-declared reads

Each store takes `treat_as_read`, a list of exact command names the guard should let through, such as a custom Redis module read:

```php
'redis' => ['treat_as_read' => ['MYMODULE.GET']],
```

> [!WARNING]
> `treat_as_read` is your statement that the command never writes. The guard trusts it: a listed command that does write is not blocked, and its write happens during the Preview. Names match exactly, with no wildcards.

## MongoDB limits

These come from MongoDB's transaction limits; see [MongoDB in Preview](../../spec/data-stores.md#mongodb-in-preview).

- A Preview whose handler runs longer than `preview_timeout_ms` (50 seconds by default) fails with 500, and nothing is written.
- Two Previews that write the same document don't queue: the second gets a `WriteConflict`, and the handler decides what to answer. The Preview still rolls back.
- Keep a Preview under about 1,000 changed documents.
- Document `before` images are read at the Preview transaction's snapshot time, so a concurrent commit by another request never shows up as a change.
- `createCollection()` fails inside a Preview, because MongoDB refuses an explicit `create` in a transaction with snapshot read concern. Inserting into a new collection creates it and rolls back.

## Elasticsearch, OpenSearch and Firestore limits

- A Preview never changes these stores, so it can't show what a write would have done: the first write stops it with a 409. Mark a route you know writes with `preview: false` to say so before anyone tries.
- A hook covers only the client it is installed on. A second client, one built inside a handler, an `Admin` or generated Firestore client you didn't pass to `install()`, and a raw socket or `curl` call are not guarded. A client built before the hook is covered by `install()`; a client built after it is covered when the container resolves it from a listed id, and otherwise by calling `install()` (or the manager's `hook*()` method) yourself.
- `Transport::setAsyncClient()` on an Elasticsearch client, or `Connection` replacement on an OpenSearch legacy pool, after the hook, with an unguarded object, bypasses it. Sendproof can't see that call; don't do it.
- OpenSearch clients with a transport other than the two the library ships are refused at startup.
- The hooks replace private properties of the client libraries (Elasticsearch's transport client, OpenSearch's transport client, connection and factory handlers, gax's transport), which have no setters. If a release renames, removes or makes read-only one of them, hooking the client throws `LogicException` at startup rather than leave it sending unguarded. A unit test loads stand-ins with the property renamed to prove it.
- A refusal is thrown above the clients' node pools and retry loops: it isn't a PSR-18 network exception and is thrown before a RingPHP future exists, so a refused write never marks a node dead, never moves to another node and is never retried (a test checks a two-node pool after a refusal).
- A Firestore `BulkWriter` (and the bulk helpers of the search clients) send on the caller's call, so a refusal reaches the caller at once and is never retried: the writer retries only `ApiException`s, and `flush(true)` and `close()` return straight away. The spec asks for queued writes to be refused when they are queued; `BulkWriter` queues with no call the guard can see, so in PHP the refusal comes when the batch is sent (on `flush()`, `close()`, or the enqueue that fills a batch). A handler that only queues a write and never sends it has its Preview confirmed, and the write stays in the writer: a `BulkWriter` kept across requests by a long-lived worker would send it in a later request. Don't keep a `BulkWriter` beyond the request that created it.
- Reads are logged with the request body's literals replaced by `?` and, for a search, the number of hits returned. A request or reply body over 1 MiB is not parsed for the log. A request body that isn't seekable is not read: its `Db` entry has no statement, and a SQL request with such a body is treated as a write.
- Firestore needs `ext-grpc` at run time. The hook itself is pure PHP. Most of its tests run the real SDK over a fake transport; with `ext-grpc` loaded, one more runs it over a real gRPC channel (gax's `GrpcTransport`) to a local stand-in server that logs each call as it opens (verified with `ext-grpc` 1.85.4).
- The `Listen` stream is a read and is logged when it opens, without rows. A stream's replies arrive after the hook has returned, so a stream's `Db` entry carries no row count.

## Previews on MySQL take turns

MySQL and MariaDB deadlock when three or more Previews insert the same new key at once and the first rolls back. The Eloquent and Doctrine providers therefore let one Preview run at a time on each MySQL database. PHP serves requests in separate worker processes, so the turn is an advisory file lock in the system temporary directory, which orders the Previews of every process on the host, a wider guarantee than the per-process turn of the other bindings. Previews sent to different hosts of one application still run at the same time and can still deadlock; the Preview then fails safely and nothing is written. Sends and observed Sends never wait.

- **The lock file** is `sendproof-turn-<hash>.lock` in `sys_get_temp_dir()`, one per database (host, port and name; never shown). Every PHP process that serves Previews must be able to open it for writing, so run them as one user, or give them a shared temporary directory. A process that can't open it fails the Preview before it starts.
- **Release**: the turn is released when the Preview's transaction ends, and the operating system releases the lock when the request ends or the process dies, after a fatal error or a crash too.
- **No deadlock with the application**: a Preview takes the turn before it opens its transaction and before the handler runs, and Sends never take it, so a Preview never waits for the turn while holding a database lock. A Preview whose connections include two that point at the same database takes the turn once. A Preview that waits longer than 60 seconds fails without running. See [verified databases](../../docs/bindings/databases.md).

## Logs and redaction

Every store command in a Preview or observed-Send trace is a `Db` log entry with the store, operation, target, sanitized statement, rows and time. Statements never carry values: MongoDB statements keep field names and operators with every literal as `"?"`, Redis statements keep the command and key names (`SET session:42 ?`), DynamoDB statements are the PartiQL text with every inline string or number literal replaced by `?`, Elasticsearch and OpenSearch statements are the request body with every value replaced by `?` (one line per NDJSON line), and Firestore statements are the request in proto3 JSON with every value replaced by `?`. Session commands such as `AUTH` and `hello` are never logged.

Change records for MongoDB carry `store`, `namespace`, the collection as `table`, `{ _id }` as `key`, and whole nested documents as `before` and `after` in MongoDB Extended JSON relaxed form. A field with a secret name, such as `password_hash` or `apiKey`, is `"[REDACTED]"` at any depth. `via` is `"upsert"` or `"replace"` when the change came from an upsert or a whole-document replacement.

## Development

The classification tables are embedded in `core/src/Stores/Tables.php`, generated from `spec/data-stores/` by `composer embed-store-tables` (in `adapters/php/core`). A unit test fails when the copy and the spec differ. The store tests run against the compose services and skip, with the command to start them, when a service doesn't answer:

```sh
docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb
docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait opensearch
sh adapters/php/scripts/test.sh
node tests/conformance/run.mjs php-laravel php-symfony
BENCH_STORES=mongodb,redis,dynamodb node tests/conformance/run.mjs php-laravel php-symfony   # what CI's main matrix runs
```

The Elasticsearch and OpenSearch tests run on the real client libraries over a fake transport (the OpenSearch ones also against the `opensearch` service, which they skip when it doesn't answer). The Firestore tests run the real SDK over a fake gax transport, and replay every request of [spec/data-stores/recordings/firestore.json](../../spec/data-stores/recordings/README.md) through the hook, outside and inside a Preview, with a variant that removes the hook and fails. The conformance entries list `opensearch`: `php-laravel` uses the PSR-18 transport and `php-symfony` the legacy `ClientBuilder` transport, so the two between them cover both.

`core` resolves `elasticsearch/elasticsearch` 9. `test.sh` also runs the search and layout tests against 8 (`elastic/transport` 8) from the small composer project in `core/compat/elasticsearch-8`, which `prepare.sh` installs.

The Firestore SDK requires `ext-grpc`, which the development setup doesn't install; `composer.json` declares `config.platform.ext-grpc` so `composer install` still resolves it. Remove that line if you run Firestore for real. `pecl install grpc` may not find a release; build it from the PECL source package instead (download `grpc-<version>.tgz` from pecl.php.net, then `phpize`, `./configure`, `make`, about 15 minutes, and enable `grpc.so` in a `conf.d` file). `FirestoreGrpcChannelTest` then runs over a real channel; it starts its stand-in server with Node and the Node binding's `@grpc/grpc-js`, and skips without them.
