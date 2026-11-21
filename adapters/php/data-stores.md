# Data stores in the PHP binding

Sendproof Preview promises that a confirmed Preview never leaves a write behind. For SQL, the rollback provider guarantees it. For MongoDB, Redis and DynamoDB, the PHP binding hooks each store's client, following the rules in [spec/data-stores.md](../../spec/data-stores.md). It works in Laravel and Symfony, and the hooks live in `sendproof/core`, so a plain PHP application can use them too.

| Store | Client | Mode | What a Preview does |
| --- | --- | --- | --- |
| MongoDB replica set or sharded cluster | `mongodb/laravel-mongodb` connection; `mongodb/mongodb` library | `preview` | Runs every command in one transaction, reports document changes, and aborts it. |
| MongoDB standalone server | the same | `guard` | Runs reads. The first write stops the Preview. |
| Redis | Predis; phpredis through Laravel's Redis manager | `guard` | Runs reads. The first write stops the Preview. |
| DynamoDB | `aws/aws-sdk-php` `DynamoDbClient` | `guard` | Runs reads. The first write stops the Preview. |

Send and observed Send are never blocked. Their writes commit as usual, and an observed Send traces every store command as a `Db` log entry.

The MongoDB hook needs `ext-mongodb` 1.21 or later (2.x with `mongodb/mongodb` 2.1 or later). phpredis needs `ext-redis`. Install the client packages you use; Sendproof lists them as suggestions and loads a hook only when its package is present.

## Coverage: only hooked clients are covered

> [!WARNING]
> The binding covers a store only through the client you hook. Other clients are not covered: their writes are neither blocked nor rolled back. That includes a client you create inside a handler, a second client for the same store, a phpredis `\Redis` object you build yourself (Symfony Cache creates its own), the raw phpredis client behind `Redis::connection()->client()`, and a raw socket. Hook every client your handlers use, at startup.

One case the driver makes visible: the MongoDB extension pools clients that have the same URI and options, and command monitoring sees every command of a pooled client. A second, unhooked `MongoDB\Client` with the same connection string as a hooked one therefore shares its monitor, and a write through it during a Preview is caught as what it is, a write that escaped the Preview session and committed: the Preview answers 500 rather than claim a rollback. Two hooked clients on one URI don't interfere: each command is handled once, by the Preview transaction its session belongs to.

Each MongoDB hook proves its monitor is installed on its own client: its topology `hello` carries a unique comment, and the hook must see it. When it doesn't (the subscriber was removed, say), discovery shows the store in `guard` mode with the reason "Sendproof's command monitor doesn't see this MongoDB client's commands", and a Preview answers 500 rather than run without the tripwire.

## Register the stores

Hooks are installed only when Sendproof is enabled for the environment (`enabled` is true and the environment is listed). A disabled application never touches a client.

### Laravel

```php
// config/sendproof.php
'data_stores' => [
    'mongodb' => ['connection' => 'mongodb', 'name' => 'catalog'],
    'redis' => ['name' => 'cache'],
    'dynamodb' => ['clients' => [Aws\DynamoDb\DynamoDbClient::class], 'name' => 'orders'],
],
```

- `mongodb.connection` names a `mongodb/laravel-mongodb` connection. Its client and database are replaced in place by guarded ones, so Eloquent models, the query builder and `DB::connection('mongodb')` all use them. A connection rebuilt after `DB::purge()` or `DB::reconnect()` gets the same guarded client.
- `redis` hooks Laravel's Redis manager: every Predis or phpredis connection it creates afterwards is guarded, including the ones the cache, session and queue drivers use.
- `dynamodb.clients` lists container ids or class names of `DynamoDbClient` services. Every client the container resolves for them is hooked, including the new client a binding that isn't shared builds on each resolve. For a client the container doesn't hold, call `Sendproof::hookDynamoDb($client)` once, at startup.

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
```

Each id names a service. A Predis or DynamoDB service gets a service configurator that hooks it when the container builds it; a `MongoDB\Client` service is decorated under its own id, so everything that uses it gets the guarded client. An id that is not a service fails the container build. Sendproof builds every listed client at the start of a Preview, so the hooks are in place even for a handler that uses a client lazily.

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

## Previews on MySQL take turns

MySQL and MariaDB deadlock when three or more Previews insert the same new key at once and the first rolls back. The Eloquent and Doctrine providers therefore let one Preview run at a time on each MySQL database. PHP serves requests in separate worker processes, so the turn is an advisory file lock in the system temporary directory, which orders the Previews of every process on the host, a wider guarantee than the per-process turn of the other bindings. Previews sent to different hosts of one application still run at the same time and can still deadlock; the Preview then fails safely and nothing is written. Sends and observed Sends never wait.

- **The lock file** is `sendproof-turn-<hash>.lock` in `sys_get_temp_dir()`, one per database (host, port and name; never shown). Every PHP process that serves Previews must be able to open it for writing, so run them as one user, or give them a shared temporary directory. A process that can't open it fails the Preview before it starts.
- **Release**: the turn is released when the Preview's transaction ends, and the operating system releases the lock when the request ends or the process dies, after a fatal error or a crash too.
- **No deadlock with the application**: a Preview takes the turn before it opens its transaction and before the handler runs, and Sends never take it, so a Preview never waits for the turn while holding a database lock. A Preview whose connections include two that point at the same database takes the turn once. A Preview that waits longer than 60 seconds fails without running. See [verified databases](../../docs/bindings/databases.md).

## Logs and redaction

Every store command in a Preview or observed-Send trace is a `Db` log entry with the store, operation, target, sanitized statement, rows and time. Statements never carry values: MongoDB statements keep field names and operators with every literal as `"?"`, Redis statements keep the command and key names (`SET session:42 ?`), and DynamoDB statements are the PartiQL text with every inline string or number literal replaced by `?`. Session commands such as `AUTH` and `hello` are never logged.

Change records for MongoDB carry `store`, `namespace`, the collection as `table`, `{ _id }` as `key`, and whole nested documents as `before` and `after` in MongoDB Extended JSON relaxed form. A field with a secret name, such as `password_hash` or `apiKey`, is `"[REDACTED]"` at any depth. `via` is `"upsert"` or `"replace"` when the change came from an upsert or a whole-document replacement.

## Development

The classification tables are embedded in `core/src/Stores/Tables.php`, generated from `spec/data-stores/` by `composer embed-store-tables` (in `adapters/php/core`). A unit test fails when the copy and the spec differ. The store tests run against the compose services and skip, with the command to start them, when a service doesn't answer:

```sh
docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb
sh adapters/php/scripts/test.sh
node tests/conformance/run.mjs php-laravel php-symfony
```
