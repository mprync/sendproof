# Data stores in the Node binding

Sendproof Preview promises that a confirmed Preview never leaves a write behind. For SQL, the rollback provider guarantees it. For MongoDB, Redis and DynamoDB, the Node binding hooks each store's client, following the rules in [spec/data-stores.md](../../spec/data-stores.md):

| Store | Package | Mode | What a Preview does |
| --- | --- | --- | --- |
| MongoDB replica set or sharded cluster | [`@sendproof/mongodb`](mongodb) | `preview` | Runs every command in one transaction, reports document changes, and aborts it. |
| MongoDB standalone server | [`@sendproof/mongodb`](mongodb) | `guard` | Runs reads. The first write stops the Preview. |
| Redis | [`@sendproof/redis`](redis) | `guard` | Runs reads. The first write stops the Preview. |
| DynamoDB | [`@sendproof/dynamodb`](dynamodb) | `guard` | Runs reads. The first write stops the Preview. |

Send and observed Send are never blocked. Their writes commit as usual, and an observed Send traces every store command as a `Db` log entry.

## Coverage: only hooked clients are covered

> [!WARNING]
> The binding covers a store only through the client you pass to `mongoStore`, `mongooseStore`, `redisStore` or `dynamoStore`. Other clients are not covered: their writes are neither blocked nor rolled back. That includes a client created inside a handler, a second client for the same store, a Redis cluster or pool client, and a raw socket. Hook every client your handlers use, at startup.

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
- During a Preview, every database and collection method adds the Preview session to its options. A call that passes its own session is refused, and the Preview answers 500.
- `client.startSession()` and `client.withSession()` hand out the Preview session. Its `startTransaction` and `withTransaction` run inside the Preview transaction; its `commitTransaction` and `abortTransaction` never reach the server and fail the Preview with 500, like a raw SQL `COMMIT`. A raw `{ commitTransaction: 1 }` or `{ abortTransaction: 1 }` command through `db.command()` is refused the same way.
- An aggregation cursor's `out()`, `merge()` and `addStage()` are checked when you call them, so a `$out` or `$merge` added after `aggregate()` is blocked before it is sent.
- A Preview may hold its transaction for `previewTimeoutMs`, 50 seconds by default (below MongoDB's 60-second transaction lifetime). A handler still running at the limit loses the transaction: its later commands fail, nothing commits, and the Preview answers 500.

### MongoDB with Mongoose 8

```ts
await mongoose.connect(url, { monitorCommands: true });
const catalog = mongooseStore(mongoose, { name: 'catalog' });
const Item = mongoose.model('Item', itemSchema); // define models after mongooseStore
```

Call `mongooseStore` after `mongoose.connect` and before defining models: it adds a global plugin, which only reaches models compiled afterwards, and it refuses an instance that already has models. Queries, `save()`, `Model.create`, `insertMany`, `bulkWrite`, aggregations and `connection.transaction()` all join the Preview transaction through Mongoose's `transactionAsyncLocalStorage`, which the store turns on.

`Model.collection.*` and `connection.db.*` bypass Mongoose's middleware. During a Preview, a write through them reaches MongoDB without the Preview session and commits; the store sees it through command monitoring and fails the Preview with 500, so no rollback is claimed for it. The same goes for a raw `commitTransaction` sent through `connection.db` with the Preview session: it may commit the Preview's writes, so the Preview fails with 500. Use model methods in previewed handlers.

### Redis

`redisStore(client)` hooks an ioredis 5 or node-redis 5 client in place, before or after it connects. Pipelines and `MULTI` are classified before anything is written, so a refused write sends no command of the batch, not even `MULTI`. `client.duplicate()` returns a hooked copy.

- ioredis with `enableAutoPipelining` is refused at registration: auto-pipelining batches commands from different requests, so a refused write can't be removed from the batch safely. Use a separate client without it for previewed handlers.
- node-redis 4 is not supported: its command path is private and can't be hooked.

### DynamoDB

`dynamoStore(client)` adds one middleware at the AWS SDK v3 `initialize` step, which runs before a request is serialized or signed, so credentials and signatures never reach a capture. A `DynamoDBDocumentClient` made with `DynamoDBDocumentClient.from(client)` shares the base client's middleware stack: hooking either covers both.

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

Every store command in a Preview or observed-Send trace is a `Db` log entry with the store, operation, target, sanitized statement, rows and time. Statements never carry values: MongoDB statements keep field names and operators with every literal as `"?"`, Redis statements keep the command and key names (`SET session:42 ?`), and DynamoDB statements are the PartiQL text with every inline string or number literal replaced by `?`. Session commands such as `AUTH` and `hello` are never logged.

Change records for MongoDB carry `store`, `namespace`, the collection as `table`, `{ _id }` as `key`, and whole nested documents as `before` and `after`. A field with a secret name, such as `password_hash` or `apiKey`, is `"[REDACTED]"` at any depth. `via` is `"upsert"` or `"replace"` when the change came from an upsert or a whole-document replacement.
