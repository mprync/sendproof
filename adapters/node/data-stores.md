# Data stores in the Node binding

Sendproof Preview promises that a confirmed Preview never leaves a write behind. For SQL, the rollback provider guarantees it. For MongoDB, Redis, DynamoDB, Cassandra, Elasticsearch, OpenSearch, Cosmos DB and Firestore, the Node binding hooks each store's client, following the rules in [spec/data-stores.md](../../spec/data-stores.md):

| Store | Package | Mode | What a Preview does |
| --- | --- | --- | --- |
| MongoDB replica set or sharded cluster | [`@sendproof/mongodb`](mongodb) | `preview` | Runs every command in one transaction, reports document changes, and aborts it. |
| MongoDB standalone server | [`@sendproof/mongodb`](mongodb) | `guard` | Runs reads. The first write stops the Preview. |
| Redis | [`@sendproof/redis`](redis) | `guard` | Runs reads. The first write stops the Preview. |
| DynamoDB | [`@sendproof/dynamodb`](dynamodb) | `guard` | Runs reads. The first write stops the Preview. |
| Cassandra, ScyllaDB | [`@sendproof/cassandra`](cassandra) | `guard` | Runs reads. The first write stops the Preview. |
| Elasticsearch 8, OpenSearch 2 | [`@sendproof/elasticsearch`](elasticsearch) | `guard` | Runs reads (including searches sent as `POST`). The first write stops the Preview. |
| Azure Cosmos DB for NoSQL | [`@sendproof/cosmosdb`](cosmosdb) | `guard` | Runs reads. The first write stops the Preview. |
| Google Cloud Firestore | [`@sendproof/firestore`](firestore) | `guard` | Runs reads. The first write stops the Preview. |

None of the batch-two stores (Cassandra, Elasticsearch, OpenSearch, Cosmos DB, Firestore) has a rollback a handler can use, so they only ever guard. See [Supported libraries and unsupported stores](#supported-libraries-and-unsupported-stores).

Send and observed Send are never blocked. Their writes commit as usual, and an observed Send traces every store command as a `Db` log entry.

## Coverage: only hooked clients are covered

> [!WARNING]
> The binding covers a store only through the client you pass to `mongoStore`, `mongooseStore`, `redisStore`, `dynamoStore`, `cassandraStore`, `elasticsearchStore`, `opensearchStore`, `cosmosStore` or `firestoreStore`. Other clients are not covered: their writes are neither blocked nor rolled back. That includes a client created inside a handler, a second client for the same store, a Redis cluster client, a pool you create separately (`createClientPool()`), and a raw socket. Hook every client your handlers use, at startup.

## Register the stores

Hook each client at startup and pass the stores to `sendproof()` as `dataStores`. The same option works in Express, Fastify, Hono and NestJS (`SendproofModule.forRoot`).

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { sendproof } from '@sendproof/express';
import { dynamoStore } from '@sendproof/dynamodb';
import { mongoStore } from '@sendproof/mongodb';
import { redisStore } from '@sendproof/redis';

const catalog = mongoStore(new MongoClient(mongoUrl), { name: 'catalog' }); // handlers use catalog.client
const cache = redisStore(new Redis(redisUrl), { name: 'cache' });           // hooks the client in place
const orders = dynamoStore(new DynamoDBClient({}), { name: 'orders' });     // adds middleware in place

const bench = sendproof({ previewProvider: db, dataStores: [catalog, cache, orders] });
```

The batch-two stores register the same way (`cassandraStore`, `elasticsearchStore`, `opensearchStore`, `cosmosStore`, `firestoreStore`); each has its own section below.

`name` is the label the workbench shows. It must be a display name such as `catalog`, never a URL, host name or credentials; a value that looks like one is refused.

`previewProvider` (the SQL rollback provider) is optional when you pass `dataStores`. An app whose only database is MongoDB, or that has only Redis or DynamoDB, can Preview without one: MongoDB rolls back its own transaction and the guarded stores block writes. A SQL database you give no provider for is then not covered, like any unhooked client.

```ts
const bench = sendproof({ dataStores: [mongoStore(new MongoClient(url), { name: 'catalog' })] });
```

### MongoDB with the driver

`mongoStore(client)` returns a store whose `client` is a guarded `MongoClient` with the driver's own API. Handlers must use it, not the original client:

```ts
const catalog = mongoStore(new MongoClient(url), { name: 'catalog' });
app.get('/documents/:id', async (req, res) => {
  res.json(await catalog.client.db().collection('documents').findOne({ _id: req.params.id }));
});
```

- Call `mongoStore` before the client connects, or create the client with `{ monitorCommands: true }`. The store relies on command monitoring and refuses a connected client without it.
- The store proves its monitor is installed on this client: the `hello` it sends to detect the topology must reach its own listener. If it doesn't (monitoring turned off before connecting), or the listener was later removed from the client, discovery reports `guard` mode with "Preview unavailable: MongoDB command monitoring isn't reaching the binding…" and every Preview answers 500 before the handler runs.
- During a Preview, every database and collection method adds the Preview session to its options. A call that passes its own session is refused, and the Preview answers 500.
- `client.startSession()` and `client.withSession()` hand out the Preview session. Its `startTransaction` and `withTransaction` run inside the Preview transaction, and its `endSession` does nothing: the Preview ends the session after the handler. Its `commitTransaction` and `abortTransaction` never reach the server and fail the Preview with 500, like a raw SQL `COMMIT`. The store patches the driver's `ClientSession` class rather than the session object, so calling the driver's method directly, such as `ClientSession.prototype.commitTransaction.call(session)`, is refused too. Other sessions behave as usual. A raw `{ commitTransaction: 1 }` or `{ abortTransaction: 1 }` command through `db.command()` is refused the same way.
- An aggregation cursor's `out()`, `merge()` and `addStage()` are checked when you call them, so a `$out` or `$merge` added after `aggregate()` is blocked before it is sent. A cursor's `clone()` is guarded the same way.
- Derived handles stay guarded: `db(name, options)`, `collection(name, options)`, `admin()` and `clone()` return guarded handles.
- A Preview may hold its transaction for `previewTimeoutMs`, 50 seconds by default (below MongoDB's 60-second transaction lifetime). A handler still running at the limit loses the transaction: its later commands fail, nothing commits, and the Preview answers 500. Once a Preview has ended for any reason, its guarded handles, bulk builders and Mongoose operations refuse every further call ("The Preview has ended…") before it reaches the driver, and a call already past that check when the transaction is aborted runs in a fresh transaction that is never committed, so a late handler write can't run outside the transaction.

### MongoDB with Mongoose 8

```ts
await mongoose.connect(url, { monitorCommands: true });
const catalog = mongooseStore(mongoose, { name: 'catalog' });
const Item = mongoose.model('Item', itemSchema); // define models after mongooseStore
```

Call `mongooseStore` after `mongoose.connect` and before defining models: it adds a global plugin, which only reaches models compiled afterwards, and it refuses an instance that already has models. Queries, `save()`, `Model.create`, `insertMany`, `bulkWrite`, aggregations, `connection.transaction()`, `connection.withSession()` and `startSession()` all join the Preview transaction through Mongoose's `transactionAsyncLocalStorage`, which the store turns on. The session they hand out is sealed like the driver's: the handler can't commit, abort or end it, even through the session found in `transactionAsyncLocalStorage`.

Mongoose creates collections and indexes for a new model in the background. Await `Model.init()` for each model before the app serves requests, or wrap the model definitions in `detached()`, so those writes aren't taken for a Preview's (see [Background work](#background-work-detached)).

`Model.collection.*` and `connection.db.*` bypass Mongoose's middleware. During a Preview, a write through them reaches MongoDB without the Preview session and commits; the store sees it through command monitoring and fails the Preview with 500, so no rollback is claimed for it. The same goes for a raw `commitTransaction` sent through `connection.db` with the Preview session: it may commit the Preview's writes, so the Preview fails with 500. Use model methods in previewed handlers.

### Redis

`redisStore(client)` hooks an ioredis 5 or node-redis 5 client in place, before or after it connects. Pipelines and `MULTI` are classified before anything is written, so a refused write sends no command of the batch, not even `MULTI`. `client.duplicate()` returns a hooked copy. With node-redis, `withTypeMapping()`, `withCommandOptions()` and the other derived clients share the hook, and a pool made with `client.createPool()` hooks each of its clients before their first command.

- ioredis with `enableAutoPipelining` is refused at registration: auto-pipelining batches commands from different requests, so a refused write can't be removed from the batch safely. Use a separate client without it for previewed handlers.
- node-redis 4 is not supported: its command path is private and can't be hooked.

### DynamoDB

`dynamoStore(client)` adds one middleware at the AWS SDK v3 `initialize` step, which runs before a request is serialized or signed, so credentials and signatures never reach a capture. A `DynamoDBDocumentClient` made with `DynamoDBDocumentClient.from(client)` shares the base client's middleware stack: hooking either covers both.

### Cassandra and ScyllaDB

`cassandraStore(client, { name })` hooks a `cassandra-driver` 4 `Client` in place, before or after it connects. The hook sits at the statement API, above the driver's own prepare: `execute`, `eachRow`, `stream` and `batch` all receive the CQL text (a prepared call too), so every call is classified by its text before a request is built. The driver's `Mapper` and `concurrent.executeConcurrent` call those methods on the client and are covered the same way.

```ts
import { Client } from 'cassandra-driver';
import { cassandraStore } from '@sendproof/cassandra';

const tickets = cassandraStore(new Client({ contactPoints, localDataCenter, keyspace }), { name: 'tickets' });
```

- `SELECT`, `USE`, `DESCRIBE` and `LIST …` are reads. Everything else is a write, and so is a read with a second statement after a semicolon, and text the guard can't read (an unterminated quote or comment).
- Every `batch` is a write, including an empty one, because its statements may be prepared ids the guard can't read. A lightweight transaction (`IF NOT EXISTS`, `IF …`) is a write even when its condition fails.
- `executeGraph` (DataStax Graph) is refused in a Preview: a traversal may write and the guard can't read it.
- A `Db` entry's statement is the CQL with every quoted string, `$$` string and number replaced by `?`; bound values are never logged. A `batch` is logged as `BEGIN BATCH <statement>; …; APPLY BATCH`. `eachRow` and `stream` entries are recorded when the statement is sent, without a row count.
- Cassandra has no rollback, so a Preview never runs a write. A second `Client`, or one created later, is not covered.

### Elasticsearch and OpenSearch

`elasticsearchStore(client)` hooks a `@elastic/elasticsearch` 8 client and `opensearchStore(client)` an `@opensearch-project/opensearch` 2 client, in place. The hook wraps the client's transport, which every API method, helper (`helpers.bulk`, `helpers.scrollSearch` …) and a direct `client.transport.request()` sends through, so it sees the method, path and body before a connection is chosen. Each store reports its own id (`elasticsearch` or `opensearch`).

```ts
import { Client } from '@opensearch-project/opensearch';
import { opensearchStore } from '@sendproof/elasticsearch';

const search = opensearchStore(new Client({ node: url }), { name: 'search' });
```

- Requests are classified by method and endpoint, not by method alone. A `POST` to `_search`, `_msearch`, `_count`, `_mget` or `_field_caps` is a read. `_bulk`, `_update`, `_update_by_query`, `_delete_by_query`, `_reindex`, index and template management and every `PUT` are writes, and so is an endpoint the table doesn't know (except `GET` and `HEAD`).
- Point-in-time, scroll, async-search and SQL cursor handles are session state: opening and closing them runs and isn't logged.
- An SQL endpoint (`_sql`, `_plugins/_sql`) is a read only when its body holds one `SELECT`, `SHOW` or `DESCRIBE` statement, or is a cursor page. OpenSearch's legacy SQL can run `DELETE`, so anything else is a write.
- `client.child()` returns a hooked client with its own transport. OpenSearch re-registers `client.extend()` methods on a child before the child can be hooked; the store registers them again once its transport is guarded.
- On OpenSearch, `client.extend()` methods registered before the hook bind the unhooked transport, so `opensearchStore` refuses a client that already has any. Register the store first, then extend.
- A `Db` entry's statement is the request body with every literal replaced by `"?"` (one line per NDJSON line for `_bulk` and `_msearch`). The path isn't logged, because it can hold document ids; `target` is the index. Neither engine has a rollback.
- Not covered: a second client, and the connection pool used directly (`client.connectionPool`).

### Cosmos DB

`cosmosStore(client, { name })` hooks an `@azure/cosmos` 4.10 `CosmosClient` in place by adding a request plugin (`{ on: 'request' }`) first in line. The SDK runs it for every HTTP request it makes, metadata and query-plan reads included, before the request is sent. It sees the SDK's `operationType` and the request's method, path and headers; a call is a write when either says so, or when it names a trigger. `client.database(id).container(id)` and everything else derived from the client share its request pipeline and stay guarded.

```ts
import { CosmosClient } from '@azure/cosmos';
import { cosmosStore } from '@sendproof/cosmosdb';

const orders = cosmosStore(new CosmosClient({ endpoint, key }), { name: 'orders' });
```

- `Read`, `ReadFeed`, `Query` and `QueryPlan` are reads. `Create`, `Upsert`, `Replace`, `Patch`, `Delete`, batches and bulk operations are writes, and so is a stored procedure, even one that only reads, and any request that names a pre-trigger or post-trigger.
- The `plugins` option is not in the SDK's public documentation. The package pins `@azure/cosmos` to the 4.10 line, `cosmosStore` throws at registration when the client doesn't have the options object it adds the plugin to, and the replay of the recorded requests in `spec/data-stores/recordings/` fails when an SDK upgrade changes what the plugin sees.
- A `Db` entry's statement is the query text with inline literals replaced by `?` (values are `@` parameters and never logged); documents are never logged. `target` is the container and `namespace` the database. The authorization header and the account key are never read.
- Cosmos DB can only roll back a transactional batch inside one logical partition, so arbitrary handlers can't Preview. A second `CosmosClient` is not covered.

### Firestore

`firestoreStore(firestore, { name })` hooks a `@google-cloud/firestore` 7 `Firestore` instance in place. Every RPC the SDK makes (unary, streaming, over gRPC or the REST fallback) runs as an operation on a pooled client that the instance hands out; the hook wraps that pool so each operation gets a guarded view of its client, which classifies the RPC by method name before it calls it.

```ts
import { Firestore } from '@google-cloud/firestore';
import { firestoreStore } from '@sendproof/firestore';

const orders = firestoreStore(new Firestore({ projectId }), { name: 'orders' });
```

- `GetDocument`, `ListDocuments`, `BatchGetDocuments`, `RunQuery`, `RunAggregationQuery`, `PartitionQuery`, `Listen` and `ListCollectionIds` are reads. `BeginTransaction`, `Rollback` and a `Commit` with no writes run unlogged. A `Commit` is judged by its `writes`, so a `Commit` with any is a write. `BatchWrite` (`BulkWriter`), the `Write` stream, which is refused before its first message, and any method the table doesn't know are writes.
- `collection()`, `doc()`, batches, transactions and `BulkWriter` send through the instance, so they stay guarded. A transaction that reads, then writes, is refused at its `Commit`; its reads and its rollback run.
- The pool is private SDK API: the package pins the 7.x line, `firestoreStore` throws at registration when the instance has no pool to hook, and a test fails when a new method appears on the SDK's GAPIC client. google-gax drops an `interceptors` client option, and its public `grpc` option loads clients through a process-wide cache that would let a gRPC interceptor miss, or leak onto, other instances.
- A `Db` entry's statement is the request message as JSON with every literal, document paths included, replaced by `"?"`; `target` is the collection. OAuth tokens and authorization metadata are never read.
- A second `Firestore` instance, and a GAPIC client made directly from `Firestore.v1`, are not covered. Firestore can roll a transaction back, but only when every read precedes the first write and its reads don't see its own buffered writes, which arbitrary handlers break.

## Supported libraries and unsupported stores

| Store | Supported | Not supported |
| --- | --- | --- |
| Cassandra | `cassandra-driver` 4 (also ScyllaDB) | DataStax Enterprise's `dse-driver`, and any client other than the hooked `Client` |
| Elasticsearch | `@elastic/elasticsearch` 8 | The 7.x client; the pool used directly |
| OpenSearch | `@opensearch-project/opensearch` 2 | The 1.x client; `@opensearch-project/opensearch` 3, which isn't tested |
| Cosmos DB | `@azure/cosmos` 4.10 | Other minor versions, until the recordings test passes on them |
| Firestore | `@google-cloud/firestore` 7 | The web SDK (`firebase/firestore`), Datastore mode, and `firebase-admin` (not tested) |

Every batch-two store needs no extra setup beyond hooking its client. Stores the Node binding doesn't hook at all, such as Neo4j, Couchbase, Memcached or Kafka, are not covered: their writes are neither blocked nor rolled back.

## Background work: `detached()`

Each store write is attributed to the request that sent it. The binding attributes every request a Node HTTP server in the process serves, whatever the framework or middleware order, and Hono's middleware does the same on other runtimes.

While a Preview is open, a store write with no request attribution fails every open Preview with 500: it may be a write of the Preview's that lost its async context, and the binding can't tell. The write itself is not blocked. Wrap background work that writes to a hooked store, such as a queue consumer, a scheduled job or startup seeding, in `detached()`:

```ts
import { detached } from '@sendproof/core';

setInterval(() => detached(() => redis.incr('heartbeat')), 60_000);
queue.on('job', job => detached(() => processJob(job)));
```

`detached()` changes nothing inside a request: a Preview's guard still blocks the write, so a handler can't use it to let a write through. With no Preview open, unattributed writes are never reported.

## Mark an operation `preview: false`

An operation you know writes to a guarded store, such as one that clears a Redis session, can be marked `preview: false`. The workbench then shows "Preview unavailable" with your reason before anyone tries, and a Preview of it is refused (404 or 409, never confirmed) without running the handler. Send still runs it. The binding never infers the mark; without it the operation is advertised and the guard decides at run time.

Give a `reason`, the `stores` it writes, or both. With only `stores`, the reason is "Preview unavailable: this operation writes to Redis" (for the first store).

```ts
// Express and Hono
bench.unavailable('DELETE', '/sessions/{id}', { reason: 'Clears the Redis session', stores: ['redis'] }, deleteSession);

// Fastify
app.sendproof.unavailable('DELETE', '/sessions/{id}', { stores: ['redis'] }, deleteSession);

// NestJS
@SendproofPreview('DELETE', '/sessions/{id}', { enabled: false, reason: 'Clears the Redis session' })
@Delete('/sessions/:id')
deleteSession() { … }
```

## What a blocked Preview returns

When the guard refuses a write, the command never reaches the store and the handler gets a `PreviewWriteBlockedError` (from `@sendproof/core`, with `store` and `operation`). The Preview then answers 409 with `application/problem+json`, whatever the handler made of the error:

```json
{ "type": "about:blank", "title": "Preview unavailable", "status": 409, "code": "preview_unavailable",
  "detail": "Preview unavailable: this operation writes to Redis", "store": "redis", "operation": "INCR", "rolledBack": false }
```

The SQL transaction rolls back as usual. A failed rollback or abort, a handler `COMMIT` or `commitTransaction`, or a write that escaped the MongoDB session answers 500 without confirmation instead.

In `preview` mode MongoDB blocks only what a transaction can't run, such as `$out`, `$merge`, `count` or `listCollections`, with a reason like "Preview unavailable: MongoDB can't run $out inside a transaction".

## Host-declared reads

Each store takes `treatAsRead`, a list of exact command names the guard should let through, such as a custom Redis module read:

```ts
redisStore(client, { treatAsRead: ['MYMODULE.GET'] });
```

The name is the one the store logs as the operation: a Cassandra statement key (`SELECT`), an Elasticsearch or OpenSearch endpoint name from the table (`search`, `sql.query`, or `POST /{}/_future` for an endpoint the table doesn't list), a Cosmos DB operation type (`Query`) or a Firestore RPC method (`RunQuery`).

> [!WARNING]
> `treatAsRead` is your statement that the command never writes. The guard trusts it: a listed command that does write is not blocked, and its write happens during the Preview. Names match exactly, with no wildcards.

## MongoDB limits

These come from MongoDB's transaction limits; see [MongoDB in Preview](../../spec/data-stores.md#mongodb-in-preview).

- A Preview whose handler runs longer than `previewTimeoutMs` (50 seconds by default) fails with 500, and nothing is written.
- Two Previews that write the same document don't queue: the second gets a `WriteConflict`, and the handler decides what to answer. The Preview still rolls back.
- Keep a Preview under about 1,000 changed documents.
- Document `before` images are read at the Preview transaction's snapshot time, so a concurrent commit by another request never shows up as a change.
- `createCollection()` fails inside a Preview, because MongoDB refuses an explicit `create` in a transaction with snapshot read concern. Inserting into a new collection creates it and rolls back.

## Logs and redaction

Every store command in a Preview or observed-Send trace is a `Db` log entry with the store, operation, target, sanitized statement, rows and time. Statements never carry values: MongoDB statements keep field names and operators with every literal as `"?"`, Redis statements keep the command and key names (`SET session:42 ?`), and DynamoDB statements are the PartiQL text with every inline string or number literal replaced by `?`. The batch-two stores follow the same rule per store (see each store's section above): CQL and Cosmos DB query text with literals replaced by `?`, Elasticsearch and OpenSearch request bodies and Firestore request messages as JSON with every literal as `"?"`. Session commands such as `AUTH` and `hello` are never logged.

Change records for MongoDB carry `store`, `namespace`, the collection as `table`, `{ _id }` as `key`, and whole nested documents as `before` and `after`. A field with a secret name, such as `password_hash` or `apiKey`, is `"[REDACTED]"` at any depth. `via` is `"upsert"` or `"replace"` when the change came from an upsert or a whole-document replacement.
