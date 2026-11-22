# Data stores: Preview and the write guard

Protocol v1.1, an additive minor revision of [Sendproof protocol v1](README.md). Clients and servers that ignore the new fields keep working. This page defines how a binding treats data stores other than its SQL database: document stores, key-value stores and caches.

Every rule here serves one promise: **a confirmed Preview never leaves a write behind.** A store that can roll back joins the Preview transaction. A store that can't is guarded: reads run, and the first write stops the Preview before any byte of that write reaches the store.

## Store modes

Each store a binding knows about runs in one of two modes.

| Mode | Meaning | Stores |
| --- | --- | --- |
| `preview` | Writes run inside a transaction that the binding aborts after the handler. Changes and commands are captured. | MongoDB on a replica set or sharded cluster |
| `guard` | Reads run normally. A write blocks the Preview, which fails with [Preview unavailable](#blocked-preview-response). | Redis, DynamoDB, MongoDB on a standalone server; batch two: Cassandra, Elasticsearch, OpenSearch, Cosmos DB, Firestore |

Observed Send and ordinary Send are unaffected by the mode: writes commit normally and an observed Send traces them.

A binding only covers a store through the hook it installs on that store's client (command monitoring, middleware, an interceptor or a wrapper). A client the binding never saw, such as one created inside a handler, a second client for the same store, or a raw socket, is not covered. Its writes are not blocked and not rolled back. Documentation for every binding says this next to the setup instructions.

Batch two adds Cassandra, Elasticsearch and OpenSearch, Azure Cosmos DB and Google Cloud Firestore. Each runs in `guard` mode; [Batch two stores](#batch-two-stores) lists what would let one move to `preview`.

## Discovery

Capabilities gain two optional arrays. Both are display and planning data: the server still enforces every rule on every request.

```json
{
  "protocolVersion": 1,
  "dataStores": [
    { "system": "mongodb", "name": "catalog", "mode": "preview" },
    { "system": "redis", "name": "cache", "mode": "guard" },
    { "system": "dynamodb", "name": "orders", "mode": "guard" }
  ],
  "previewOperations": [{ "method": "POST", "path": "/items" }],
  "previewUnavailable": [
    { "method": "POST", "path": "/sessions/{id}/refresh", "reason": "Preview unavailable: this operation writes to Redis", "stores": ["redis"] }
  ]
}
```

- `dataStores` lists each store the binding has hooked. `system` is a short store id: `mongodb`, `redis` and `dynamodb` in batch one; `cassandra`, `elasticsearch`, `opensearch`, `cosmosdb` and `firestore` in batch two. The [Db log entry table](#database-command-log-entries) maps each id to its OpenTelemetry `db.system.name`. `name` is an optional host-chosen label; it must never contain a connection string, host name, user or password. `mode` is `preview` or `guard`, and a `guard` entry may carry a `reason`, such as why a MongoDB server can't Preview. A store without a hook does not appear, and the UI says only listed stores are covered.
- `previewUnavailable` lists operations an API author has marked `preview: false`, each with a human-readable `reason` and optionally the `stores` it names. These operations are absent from `previewOperations`. The server treats a Preview of one like a Preview of an unmarked route: no confirmation, outer 404, 405 or 409, and the handler does not run.

### Marking an operation by hand

An API author who knows an operation writes to a guarded store marks it `preview: false` with an optional reason, using the binding's normal route metadata (see each binding's plan in [docs/plans/data-stores.md](../docs/plans/data-stores.md)). The UI then shows "Preview unavailable" with that reason before the user tries. Without the mark, the operation is advertised and the guard decides at run time; both paths are safe, the mark only saves a round trip.

A binding never infers `preview: false` from code. A store in `guard` mode never removes an operation from `previewOperations` by itself, because most operations that touch a cache only read it.

## Write classification

Each guarded store has a shared classification table that every binding embeds unchanged. A binding test loads the table from `spec/data-stores/` (or a generated copy) and fails when they differ.

| Store | Table | Unit of classification |
| --- | --- | --- |
| Redis | [redis.json](data-stores/redis.json) | Upper-case command name, plus `|SUBCOMMAND` for container commands such as `OBJECT|ENCODING` |
| MongoDB | [mongodb.json](data-stores/mongodb.json) | The command document's first key, case-insensitive |
| DynamoDB | [dynamodb.json](data-stores/dynamodb.json) | The API action name, such as `UpdateItem` |
| Cassandra | [cassandra.json](data-stores/cassandra.json) | A CQL statement's first keyword (`LIST` takes its next word), or the native-protocol message for `BATCH` and `EXECUTE` |
| Elasticsearch and OpenSearch | [elasticsearch.json](data-stores/elasticsearch.json) | The HTTP method and path pattern, such as `POST /{index}/_update_by_query` |
| Cosmos DB | [cosmosdb.json](data-stores/cosmosdb.json) | The operation type, such as `Upsert`, or the HTTP request it is derived from |
| Firestore | [firestore.json](data-stores/firestore.json) | The gRPC method, such as `/google.firestore.v1.Firestore/Commit`, or the REST request it is derived from |

Each table lists reads and connection-level commands. **Everything else is a write, including commands the table has never heard of.** A store version that adds a read command stays blocked until the table lists it. That keeps the guard failing closed.

### Redis

Reads are the commands Redis itself flags `readonly` and not `write`, plus a small set of module reads (`JSON.GET`, `FT.SEARCH`, `TS.RANGE` and similar). Session commands such as `AUTH`, `HELLO`, `PING` and `SELECT` are allowed and never logged. The ones that look like reads but are writes:

- `GETEX` and `GETDEL` are writes: one can change the TTL and the other deletes the key.
- `EVAL`, `EVALSHA` and `FCALL` are writes, because a script can write. `EVAL_RO`, `EVALSHA_RO` and `FCALL_RO` are reads, because the server refuses writes inside them.
- `SORT`, `GEORADIUS` and `GEORADIUSBYMEMBER` are writes because they accept `STORE`. Their `_RO` forms are reads.
- `XREADGROUP` is a write: it adds entries to a consumer group's pending list.
- `PUBLISH`, `SPUBLISH` and the subscribe commands are writes: a delivered message can't be recalled.
- `MULTI`, `EXEC`, `DISCARD`, `WATCH` and `UNWATCH` are allowed. Each command queued after `MULTI` is classified on its own. A queued write blocks the Preview **before `EXEC` is sent**, and the binding sends `DISCARD` or closes that connection. Redis runs nothing queued until `EXEC`, so nothing reaches the data. Pipelines are classified the same way, before the first command of the pipeline is written to the socket.

### MongoDB

In `guard` mode (a standalone server), the reads are `find`, `aggregate`, `count`, `distinct`, `getMore`, `killCursors`, the `list*` commands and the statistics commands. The ones that need care:

- `findAndModify`, which backs `findOneAndUpdate`, `findOneAndReplace` and `findOneAndDelete`, is always a write, even when nothing matches.
- `aggregate` is a write when any stage at any depth is `$out` or `$merge`. Scan the whole pipeline, including `$facet`, `$lookup` and `$unionWith` sub-pipelines, rather than only the last stage.
- `explain` takes the classification of the command inside it.
- `bulkWrite`, `mapReduce`, index and collection commands, and user and role commands are writes.

In `preview` mode every command runs in the transaction, so the guard's job is the commands MongoDB refuses inside a transaction (listed under `notInTransaction` in the table): `count`, an explicit `create`, `listCollections`, `listIndexes`, `drop`, `dropIndexes`, `renameCollection`, `createIndexes` on a collection that already existed, `$out`, `$merge`, writes to a capped collection, and anything on the `admin`, `config` or `local` databases or a `system.*` collection. The server would reject these and apply nothing, but the binding blocks the listed commands and stages before sending, so the user sees the reason in place of an application error. The reason reads, for example, "Preview unavailable: MongoDB can't run $out inside a transaction". The rule-based cases (an existing collection, a capped collection) need server state to detect, so the binding instead treats a reply with code 263, `OperationNotSupportedInTransaction`, as a block with the same kind of reason, whatever the handler does with the error.

### DynamoDB

Reads are `GetItem`, `BatchGetItem`, `Query`, `Scan`, `TransactGetItems` and the `Describe*` and `List*` actions. The ones that need care:

- `UpdateItem` is always a write, whatever its `ReturnValues`. So are `PutItem` and `DeleteItem`, including a conditional write whose condition will fail.
- `TransactWriteItems` and `BatchWriteItem` are writes, even when a transaction holds only `ConditionCheck` entries.
- `ExecuteStatement`, `BatchExecuteStatement` and `ExecuteTransaction` carry PartiQL. The request is a read only when every statement is a `SELECT`: skip whitespace, `--` line comments and `/* */` block comments, then compare the first word case-insensitively. An `INSERT`, `UPDATE`, `DELETE`, or any text the binding can't parse, makes the whole request a write.

### Cassandra

Reads are `SELECT`, `USE` (it only changes the connection's keyspace), `DESCRIBE` and the `LIST` statements. The ones that need care:

- Every `BATCH` is a write, both `BEGIN … APPLY BATCH` text and the native protocol's `BATCH` message, whose statements may be prepared ids the hook can't read. An empty batch is refused too.
- A lightweight transaction (`IF NOT EXISTS`, `IF EXISTS`, `IF <condition>`) is a write even when its condition fails.
- `EXECUTE` takes the classification of the text the hook saw prepared. An id the hook never saw prepared is a write. `PREPARE` only parses a statement and is allowed.
- Text is a read only when it holds one statement. A second statement after a semicolon (outside quotes, comments and `$$` strings), an unterminated quote or comment, or no statement at all makes it a write.
- DDL (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`), `GRANT`, `REVOKE` and Cassandra 5's `ADD IDENTITY` are writes.

### Elasticsearch and OpenSearch

One table covers both engines; the hook reports `elasticsearch` or `opensearch` as the store. The table lists endpoints in order and the first match decides; `GET` and `HEAD` are reads on every other path, and anything else is a write. The ones that need care:

- A `POST` is not a write by itself: `_search`, `_msearch`, `_count`, `_mget`, `_field_caps`, `_explain`, the template searches and the other listed read endpoints take their query in a `POST` body.
- `_bulk`, `_update_by_query`, `_delete_by_query` and `_reindex` are always writes, even when their query matches nothing. So are document `PUT`, `POST` and `DELETE`, stored scripts, and index, alias, template, mapping and setting changes.
- The SQL endpoints (`_sql`, `_plugins/_sql`, `_opendistro/_sql`) are reads only when the body's `query` is one `SELECT`, `SHOW` or `DESCRIBE` statement, or the body only fetches the next page of a cursor. OpenSearch's legacy SQL engine can run `DELETE`.
- Point-in-time, scroll, async-search and SQL-cursor handles are session state: opening and closing them is allowed and not logged.
- Match the path after percent-decoding each segment and dropping repeated or trailing slashes, as the server does. An index name never starts with an underscore, so `/_x/_search` is not a search.

### Cosmos DB

Reads are `Read`, `ReadFeed` (including the change feed), `Query`, `QueryPlan` and the `Head` operations; the Cosmos DB query language can't write. The ones that need care:

- A request that names a pre-trigger or post-trigger is a write whatever its operation, because trigger code can write.
- Executing a stored procedure is a write, even one that only reads: the guard can't see its code.
- `Batch` is a write, whether a transactional batch or the bulk mode that sends non-atomic batches, and even when every operation in it is a read. So is a conditional `Patch` whose filter fails.
- A hook on the HTTP pipeline derives the operation from the method, the resource path and the `x-ms-documentdb-isquery`, `x-ms-cosmos-is-query-plan-request`, `x-ms-cosmos-is-batch-request` and `x-ms-documentdb-is-upsert` headers, as `fromRequest` in the table lists. Operation types compare case-insensitively.

### Firestore

Reads are `GetDocument`, `ListDocuments`, `BatchGetDocuments`, `RunQuery`, `RunAggregationQuery`, `PartitionQuery`, `Listen` and `ListCollectionIds`, including the ones that begin a transaction. The ones that need care:

- `BeginTransaction` and `Rollback` are allowed: they change no data.
- `Commit` is a write when it carries at least one write. A `Commit` with no writes only ends a transaction that wrote nothing (the SDKs send one after a read-write transaction that only read), so it is allowed. A hook that can't read the request message treats every `Commit` as a write.
- `BatchWrite`, `Write` (a stream, refused before its first message) and the document RPCs are writes. A method of any other service, or another API version, is a write; admin methods are reads only when they start with `Get` or `List`.

### Host-declared reads

A host can add read commands the table doesn't know, such as a custom Redis module command, through one builder option per store (for example `.TreatAsRead("MYMODULE.GET")`). The option takes exact names only, with no wildcards. It is the host's statement that the command never writes; the documentation says so in a warning.

## When the guard blocks a write

The guard runs before the client sends the command. When it classifies a command as a write during a Preview:

1. It refuses the command with a binding-specific error (`PreviewWriteBlockedException`, `PreviewWriteBlockedError` and so on) that names the store and the command. No byte of the command reaches the store.
2. It marks the Preview as blocked. **The mark, not the handler's response, decides the outcome.** A handler that catches the error and returns 200 still produces a blocked Preview.
3. Any further write to any guarded store in the same Preview is refused the same way. Reads may continue.
4. When the handler returns or throws, the binding rolls back the SQL transaction and aborts any `preview`-mode store transactions, discards the captured response, logs, changes and effects, and answers with the [blocked-Preview response](#blocked-preview-response).
5. If any rollback or abort fails, the binding answers 500 without confirmation, exactly like the `rollback-failure` scenario. A failed rollback outranks a blocked write.

A guarded write outside a Preview, in Send or observed Send, is never blocked.

### Writes the binding can't attribute to a request

The guard knows which request a command belongs to through the runtime's request context (async context, thread or fiber locals, `context.Context`, request extensions). Some writes arrive with no request: a client's own background threads or timers (Firestore `BulkWriter`, bulk helpers, batching writers), tasks the handler spawned without the context, a raw call made with an empty context.

While any Preview is open, a write to a guarded store that carries no request is treated as that Preview's write: it is **refused before it is sent**, exactly as in step 1, and every open Preview is marked blocked and answers 409, whatever the store's mode: nothing reached the store. A 500 is only for a write the binding saw after it was sent (the MongoDB tripwire). Failing the Preview after letting the write through is not enough, because a guarded store can't roll it back. Work that legitimately writes outside any request, such as background jobs, runs inside the binding's `detached` scope and is never refused. Ordinary requests that are not Previews are attributed to their own request, so their writes are never mistaken for unattributed ones.

A write that carries the context of a Preview that has **ended** (a thread or task the handler started, still running after the response) is refused before it is sent, for as long as the process runs: a Preview's context stays marked as a Preview after it ends. A handler-started thread that dropped its context and writes after the Preview ended can't be told apart from background work; bindings document this limit.

In runtimes where a new thread inherits context from the thread that started it (Ruby fiber storage, Java `InheritableThreadLocal`), a thread-pool worker that happens to start during a Preview would inherit it and have every later write refused, including unrelated work. Bindings clear the inherited Preview context at the start of each task in the pool libraries they can hook (concurrent-ruby and the Rails executor, Java `ExecutorService` wrappers, Spring's task executors), so the mark follows the task, not the pool thread; a task posted to such a pool during a Preview then counts as unattributed. Pools they can't hook are listed in the binding's docs, with the advice to start them at boot or run their tasks `detached`.

Clients that queue writes and send them later with automatic retries (Firestore `BulkWriter`, Elasticsearch bulk helpers and bulk indexers) are refused when the write is queued, on the caller's thread, not when the batch is sent: a refusal at send time is retried until the caller's flush or close hangs.

### Mixed SQL and guarded stores

An operation that writes SQL rows and then a guarded store follows the same steps: the SQL transaction rolls back and the Preview fails. An independent read afterwards finds neither the rows nor the store write. When the guarded write comes first, the SQL writes after it still run inside the doomed transaction and roll back with it.

An operation that writes a `preview`-mode store and SQL rolls both back. The binding confirms the Preview only when every rollback and abort succeeded.

## Blocked-Preview response

A blocked Preview answers HTTP 409 with `Content-Type: application/problem+json` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)) and `Cache-Control: no-store`, and without `Preference-Applied`, so no client can mistake it for a confirmed rollback. The body follows [preview-unavailable.schema.json](preview-unavailable.schema.json):

```json
{
  "type": "about:blank",
  "title": "Preview unavailable",
  "status": 409,
  "code": "preview_unavailable",
  "detail": "Preview unavailable: this operation writes to Redis",
  "store": "redis",
  "operation": "INCR",
  "rolledBack": false
}
```

- `code` is always `preview_unavailable`. `detail` is the sentence the UI shows. For a write it reads `Preview unavailable: this operation writes to <Store>`, using the display names `MongoDB`, `Redis`, `DynamoDB`, `Cassandra`, `Elasticsearch`, `OpenSearch`, `Cosmos DB` and `Firestore`. For a command MongoDB can't run in a transaction it uses the reason from the table.
- `store` is the `system` value. `operation` is the refused command or action name, never its arguments: keys and filters can contain personal data.
- `rolledBack` is `false`: nothing was written, but nothing was previewed either.
- The response never carries the handler's status, body, headers, cookies, logs, changes or effects.

## Database command log entries

Preview envelopes and traces gain a log level `"Db"` for commands to non-SQL stores, beside the existing `"Sql"` level. Fields follow the [OpenTelemetry database semantic conventions](https://opentelemetry.io/docs/specs/semconv/database/database-spans/).

```json
{
  "level": "Db",
  "message": "update documents",
  "elapsedMs": 1.8,
  "db": {
    "system": "mongodb",
    "namespace": "catalog",
    "operation": "update",
    "target": "documents",
    "statement": "{\"update\":\"documents\",\"updates\":[{\"q\":{\"_id\":\"?\"},\"u\":{\"$set\":{\"name\":\"?\"}}}]}",
    "rowsAffected": 1
  }
}
```

| Field | Required | OpenTelemetry attribute | Meaning |
| --- | --- | --- | --- |
| `system` | yes | `db.system.name` | The store id, as in `dataStores`. OpenTelemetry names `dynamodb` `aws.dynamodb` and `cosmosdb` `azure.cosmosdb`; the other ids are the same in both |
| `operation` | yes | `db.operation.name` | Command or action name: `find`, `INCR`, `PutItem` |
| `target` | no | `db.collection.name` | Collection or table. For Redis, the first key argument |
| `namespace` | no | `db.namespace` | MongoDB database or Redis database number |
| `statement` | no | `db.query.text` | Sanitized command text: see below |
| `parameters` | no | `db.query.parameter.<key>` | `[{name, value}]` with string or null values, as for SQL |
| `rowsAffected` | no | `db.response.returned_rows` | Documents or items matched, modified or returned |
| `blocked` | no | | `true` on the entry for a command the guard refused |
| `error` | no | `error.type` | The store's error code name, such as `WriteConflict` |

`message` is the OpenTelemetry span name: `{operation} {target}`, or just `{operation}`.

### Redaction

The rules match SQL parameters. A value never appears in `statement`; it appears in `parameters` only under a name that is not secret, and a secret name's value is `"[REDACTED]"`. Concretely:

- **MongoDB:** `statement` is the command document as JSON with every literal value replaced by `"?"`, keeping field names and operators. Commands the [MongoDB command monitoring specification](https://github.com/mongodb/specifications/blob/master/source/command-logging-and-monitoring/command-logging-and-monitoring.md#security) marks security-sensitive (`authenticate`, `saslStart`, `saslContinue`, `getnonce`, `createUser`, `updateUser`, and `hello` with `speculativeAuthenticate`) are never logged.
- **Redis:** `statement` is the command name followed by its key arguments, with every other argument replaced by `?`, as in `SET session:42 ?`. Session commands, including `AUTH` and `HELLO … AUTH`, are never logged.
- **DynamoDB:** PartiQL `statement` is the statement text, which uses `?` placeholders. Other actions have no `statement`. Credentials, the `Authorization` header and signatures are never captured.
- **Cassandra:** `statement` is the CQL text with every quoted string, `$$` string and number replaced by `?`; bound values are never logged. A `BATCH` is logged as `BEGIN BATCH <statement>; …; APPLY BATCH`. `target` is the table and `namespace` the keyspace.
- **Elasticsearch and OpenSearch:** `statement` is the request body with every literal replaced by `"?"`, as for MongoDB, one line per NDJSON line for `_bulk` and `_msearch`. The path is not logged, because it can hold document ids. `target` is the index the path names.
- **Cosmos DB:** `statement` is the query text, whose values are `@` parameters, with any inline literals replaced by `?`; parameter values and documents are never logged. `target` is the container and `namespace` the database. The `authorization` header and account keys are never captured.
- **Firestore:** `statement` is the request message as JSON with every literal, including document paths, replaced by `"?"`. `target` is the collection. OAuth tokens and authorization metadata are never captured.
- Connection strings, host names, user names and passwords never appear in a capture, a trace or capabilities.

## Document and key changes

Change records gain optional fields so one list holds rows, documents, items and keys. Existing fields keep their meaning.

```json
{
  "operation": "update",
  "store": "mongodb",
  "namespace": "catalog",
  "table": "documents",
  "key": { "_id": "doc-1" },
  "before": { "_id": "doc-1", "name": "Old", "profile": { "city": "Leeds" }, "password_hash": "[REDACTED]" },
  "after": { "_id": "doc-1", "name": "New", "profile": { "city": "York" }, "password_hash": "[REDACTED]" }
}
```

- `store` is the `system` value. Absent means the binding's SQL database.
- `table` holds the collection name for MongoDB, the table name for DynamoDB, and the key's prefix up to the first `:` (or the whole key) for Redis. `namespace` is the database.
- `key` is `{ "_id": … }` for MongoDB, the item's primary key attributes for DynamoDB, and `{ "key": "…" }` for Redis.
- `operation` stays `insert`, `update` or `delete`. A MongoDB replacement is an `update`; an upsert that created a document is an `insert`.
- `via` is optional and says how the change was made when the operation alone hides it: `"upsert"` for a change made by an upsert (an `insert` when it created the document, an `update` when it matched one), and `"replace"` for a whole-document replacement. The UI labels these. Absent means an ordinary insert, update or delete.
- `before` and `after` are whole documents, nested as stored. BSON types without a JSON equivalent use [MongoDB Extended JSON v2 relaxed form](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/) (`{"$oid": …}`, `{"$date": …}`).

Only `preview`-mode stores produce change records in a Preview, because a blocked Preview returns no envelope. Observed Send may record changes for any store whose hook can see them.

### Secret fields

A field whose name is secret is `"[REDACTED]"` in `key`, `before` and `after`, **at any depth** of a document. The rule is the whole-word match the SQL rules use: split the name into lower-case words at punctuation, underscores and camel-case boundaries; the name is secret when a word is `password`, `passwd`, `pwd`, `secret`, `token`, `hash`, `salt`, `credential`, `credentials` or `apikey`, or when `key` follows `api`, `private`, `secret`, `access`, `signing`, `encryption` or `client`. So `password_hash`, `apiKey` and `refreshToken` are hidden while `idempotency_key` and `monkey` stay visible. A redacted value never appears anywhere else in the envelope or trace either.

## MongoDB in Preview

### Starting the transaction

At startup or first use, the binding sends `hello` and reads the topology. A response with `setName` (replica set) or `msg: "isdbgrid"` (mongos) and a non-null `logicalSessionTimeoutMinutes` supports transactions: MongoDB runs in `preview` mode. A standalone server, or any reply the binding doesn't recognise, runs in `guard` mode with the reason "Preview unavailable: this MongoDB server doesn't support transactions". When the `hello` can't be sent or answered at all, the binding also runs in `guard` mode, with the reason "Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, so this Preview runs in guard mode", and detects again later.

For each Preview the provider starts one client session and one transaction with read concern `snapshot` and write concern `majority`, records the transaction's start `operationTime`, and makes that session ambient for the request (see the per-language mechanism in the plan). Every command the handler sends through a hooked client carries the session's `lsid`, `txnNumber` and `autocommit: false`. After the handler, it captures changes, sends `abortTransaction` and ends the session.

Drivers ignore errors from `abortTransaction` by design, so the binding checks the server's own answer: the abort counts only when the server acknowledged it or answered that the transaction no longer exists. Otherwise, if any command was sent on the Preview session, the Preview answers 500 at once and the binding ends the session with `killSessions` in the background, retrying with backoff for about 10 s, then logs a warning with the session id. This releases the transaction's locks promptly instead of at the server's transaction lifetime limit. The session id is never reused meanwhile.

### Commands that escape the session

A command sent during a Preview without the Preview's `lsid` (for example through a call that passed an explicit other session, or none, where the driver has no ambient session) must be stopped before sending when the hook can see it. A wrapper that injects the session refuses an explicit foreign session. When the only hook is after-the-fact command monitoring and it sees a write without the Preview's `lsid`, the binding cannot undo it: it answers 500 without confirmation and logs the escape. That path exists to stop a false "rolled back" claim; the plan for each language says how to avoid reaching it.

The handler's own transaction calls join the Preview transaction: `startTransaction` and `withTransaction` run their body in it, and a handler's `commitTransaction` or `abortTransaction` for it never reaches the server. A handler commit is treated like a raw SQL `COMMIT`: 500 without confirmation, with nothing persisted.

### Capturing document changes

The binding computes changes after the handler, before `abortTransaction`:

1. Collect candidate `_id` values: the `documents` of each `insert`, the `upserted` ids of each reply, the returned document of each `findAndModify`, and for each `update` and `delete` the ids its filter matches both in the transaction and in the snapshot read at the transaction's start time (`readConcern: { level: "snapshot", atClusterTime: <start operationTime> }`).
2. For each candidate, read the document at the start time (`before`) and inside the transaction (`after`). A driver that doesn't expose the start time may read `before` from the committed view with read concern `majority`; nothing the Preview wrote is committed, so the only difference is a concurrent commit by another request.
3. Emit a change for each candidate whose two reads differ: `insert` when `before` is absent, `delete` when `after` is absent, `update` otherwise. Stop at the change cap and set `changesTruncated`.

### Limits

These were checked against the MongoDB 8.2 server in [compose.yml](../tests/conformance/compose.yml).

- **Lifetime:** the server aborts a transaction after `transactionLifetimeLimitSeconds`, 60 seconds by default. A Preview whose handler runs longer fails with 500 without confirmation, and nothing is written. Bindings set their own Preview timeout below this limit.
- **Lock wait:** a transaction waits only `maxTransactionLockRequestTimeoutMillis` (5 ms by default) for a lock. A Preview that writes a document another Preview or request is writing gets a `WriteConflict`. The Preview still rolls back; the inner response is whatever the handler made of the error. Unlike SQL Previews, concurrent MongoDB Previews of the same document do not queue.
- **Size:** one document is at most 16 MB, and a transaction's changes must fit in the server's cache. MongoDB recommends modifying no more than 1,000 documents per transaction.
- **Snapshot history:** before images read at the start time need `minSnapshotHistoryWindowInSeconds` (300 seconds by default) to exceed the Preview's run time, which the lifetime limit guarantees.
- **Refused operations:** the `notInTransaction` list in [mongodb.json](data-stores/mongodb.json). Creating a new collection by inserting into it is allowed and rolls back. An explicit `create` fails inside a transaction with read concern `snapshot`, so the binding blocks it before sending, like the other listed commands.

## Transaction-control statements from the handler

The shared [raw COMMIT rule](conformance/fixture.md#shared-security-rules) applies to every SQL provider, not only to data stores. During a Preview, the provider refuses, before it reaches the database, any statement that would end or escape the Preview transaction:

- `COMMIT`, `COMMIT WORK`, `END`, `ROLLBACK` without `TO`, `ABORT`, `BEGIN`, `START TRANSACTION`, and `COMMIT TRAN`/`ROLLBACK TRAN` on SQL Server.
- `SET autocommit = 1` and other session settings that end the transaction.
- On MySQL and MariaDB, statements that commit implicitly: `CREATE`, `ALTER`, `DROP`, `RENAME`, `TRUNCATE`, `LOCK TABLES`, `UNLOCK TABLES`, `GRANT`, `REVOKE` and the other statements MySQL lists under implicit commit.
- On MySQL and MariaDB, `CALL`, because a stored procedure can run `COMMIT` or an implicitly committing statement inside the Preview transaction. A host may declare procedures that never commit, by exact name only (the same rule as host-declared reads); a declared procedure is allowed. MySQL routine names are case-insensitive, so the match is too; backtick quoting is removed first, and a schema-qualified call (`db.proc`) matches only a declaration with that schema.
- On MySQL and MariaDB, `PREPARE` and `EXECUTE` (and `EXECUTE IMMEDIATE` on MariaDB), because a prepared statement built from a string can be any of the statements above.

The provider reads each statement as the server does, so comments (`--`, `#`, `/* */`, including MySQL's executable `/*! */` comments), quoted strings and identifiers, and multi-statement text can't hide a refused statement. When in doubt it refuses.

`SAVEPOINT`, `RELEASE SAVEPOINT` and `ROLLBACK TO SAVEPOINT` stay allowed, because ORMs use them for nested transactions. A refused statement fails the Preview with 500 without confirmation, and the SQL transaction rolls back.

As a backstop on MySQL and MariaDB, the provider proves the Preview transaction was never committed. Right after opening the Preview transaction it runs `SAVEPOINT sendproof_preview`; before rolling back it runs `RELEASE SAVEPOINT sendproof_preview` (or `ROLLBACK TO SAVEPOINT sendproof_preview`). Any commit, explicit or implicit, erases every savepoint, so error 1305 (`SAVEPOINT ... does not exist`) means something committed the Preview transaction, and the Preview answers 500 without confirmation, whatever the handler returned. Any other failure of the check also answers 500; the rollback still runs. During a Preview the provider refuses a handler's `SAVEPOINT`, `RELEASE SAVEPOINT` and `ROLLBACK TO SAVEPOINT` naming `sendproof_preview`.

Every other SQL provider runs the same backstop, so no Preview is ever confirmed after its transaction was committed by a path the provider couldn't see (for example raw SQL on the underlying driver connection):

- **PostgreSQL and SQLite:** `SAVEPOINT sendproof_preview` after opening, `ROLLBACK TO SAVEPOINT sendproof_preview` before rolling back. Both servers fail it once the transaction has ended. Use `ROLLBACK TO`, not `RELEASE`: on a PostgreSQL transaction aborted by an ordinary handler error (a unique violation, say), `RELEASE` fails and would answer 500 for a Preview that committed nothing, while `ROLLBACK TO` succeeds. Unwind any nested savepoints the handler left open first.
- **SQL Server:** `SAVE TRANSACTION sendproof_preview` after opening; before rolling back, `ROLLBACK TRANSACTION sendproof_preview`, which fails once the transaction has ended. Don't rely on `@@TRANCOUNT`: with `IMPLICIT_TRANSACTIONS ON` (mssql-jdbc with auto-commit off) the next statement after a commit opens a new transaction and the count reads 1 again. `SET IMPLICIT_TRANSACTIONS OFF` leaves the open transaction alone and stays allowed (EF Core starts its batches with it); `ON` is refused.

The savepoint must be set at the start. `SELECT @@in_transaction` exists only on MariaDB, and a savepoint set and released only at the end can't tell: with `autocommit=0` (JDBC, Hibernate, Python DB-API drivers) MySQL opens a new transaction implicitly after a commit, so a fresh savepoint succeeds after the Preview transaction is gone. The start savepoint works on MySQL and MariaDB in either autocommit mode.

A server can also end the Preview transaction itself: a deadlock (error 1213) rolls back the whole transaction, and so does a lock wait timeout (1205) when `innodb_rollback_on_timeout` is on. Nothing was committed, but every later statement on that connection runs outside the Preview transaction, and with `autocommit=1` an ORM's automatic retry would commit for real. So once the provider sees either error on the Preview connection, it refuses every further statement in that Preview before sending, and the Preview answers 500 without confirmation. The handler still receives the original error.

The same applies to SQL Server, where a deadlock victim (error 1205) or an error under `XACT_ABORT ON` rolls back the whole transaction and later statements autocommit. PostgreSQL is safe without this: after an error it keeps the transaction open but aborted, and refuses every later statement itself (`25P02`) until the rollback.

## Batch two stores

Each batch-two store runs in `guard` mode. Its classification table is under `spec/data-stores/` (see [Write classification](#write-classification)), and its plan entry names the hook in each language.

| Store | Could it Preview? | Guard classification unit | Proven by |
| --- | --- | --- | --- |
| Cassandra | No: Cassandra has no rollback; a logged batch only makes its statements all-or-nothing. Guard only. | CQL statement: `SELECT`, `USE`, `DESCRIBE` and `LIST` are reads; every `BATCH` is a write | Shared HTTP checks against the compose `cassandra` service |
| Elasticsearch and OpenSearch | No: there is no rollback. Guard only. | HTTP method and endpoint: `GET`/`HEAD`, `_search`, `_count`, `_msearch`, `_mget`, `_field_caps` are reads; `_update_by_query`, `_delete_by_query`, `_bulk`, `_reindex` and every `PUT` are writes | Shared HTTP checks against the compose `opensearch` service |
| Azure Cosmos DB | Only inside a single logical partition, through a transactional batch; not for arbitrary handlers. Guard only. | Operation type: `Read`, `ReadFeed`, `Query` are reads; stored procedures, triggers and batches are writes | Unit tests replaying [recorded requests](data-stores/recordings/README.md) |
| Google Cloud Firestore | Not for arbitrary handlers: a transaction can be rolled back, but it needs every read before the first write and its reads don't see its own buffered writes. Guard only. | RPC: `GetDocument`, `ListDocuments`, `RunQuery`, `RunAggregationQuery`, `BatchGetDocuments`, `Listen` are reads; `Commit` with writes, `BatchWrite`, `Write` are writes | Unit tests replaying [recorded requests](data-stores/recordings/README.md) |

A store can move to `preview` only with a mechanism that applies nothing until the binding says so and can discard everything on request, proven by an independent read in the conformance suite.

## Conformance

The shared HTTP checks live in [tests/conformance/data-stores.mjs](../tests/conformance/data-stores.mjs) and use the fixture routes in [the fixture contract](conformance/fixture.md#data-store-routes). A manifest entry opts in with `"stores": ["mongodb", "redis", "dynamodb"]`, adding `"cassandra"` and `"opensearch"` for batch two; entries without it report the checks as not implemented. Cassandra and OpenSearch come from the compose `heavy-stores` profile and run in a separate CI job; `BENCH_STORES` narrows a local run to the listed stores.

Cosmos DB and Firestore have no compose service. Each binding proves those hooks with unit tests that replay [the recorded requests](data-stores/recordings/README.md) over a fake transport.
