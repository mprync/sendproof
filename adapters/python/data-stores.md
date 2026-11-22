# Data stores in the Python binding

Sendproof Preview promises that a confirmed Preview never leaves a write behind. For SQL, the rollback provider guarantees it. For MongoDB, Redis, DynamoDB, Cassandra, Elasticsearch, OpenSearch, Cosmos DB and Firestore, the Python binding hooks each store's client, following the rules in [spec/data-stores.md](../../spec/data-stores.md). The hooks live in `sendproof_core.stores`, so the same code serves FastAPI, Flask and Django.

| Store | Clients | Mode | What a Preview does |
| --- | --- | --- | --- |
| MongoDB replica set or sharded cluster | PyMongo, `AsyncMongoClient` | `preview` | Runs every command in one transaction, reports document changes, and aborts it. |
| MongoDB standalone server | PyMongo, `AsyncMongoClient` | `guard` | Runs reads. The first write stops the Preview. |
| Redis | redis-py and `redis.asyncio`, including Django's `RedisCache` | `guard` | Runs reads. The first write stops the Preview. |
| DynamoDB | boto3, aioboto3, botocore | `guard` | Runs reads. The first write stops the Preview. |
| Cassandra | `cassandra-driver` 3.29 (DataStax; ScyllaDB's fork) | `guard` | Runs reads. The first write, and every `BATCH`, stops the Preview. |
| Elasticsearch | `elasticsearch` 8: `Elasticsearch`, `AsyncElasticsearch` | `guard` | Runs reads, including `POST` searches. The first write stops the Preview. |
| OpenSearch | `opensearch-py` 2: `OpenSearch`, `AsyncOpenSearch` | `guard` | Same as Elasticsearch, reported as `opensearch`. |
| Cosmos DB | `azure-cosmos` 4.17: `CosmosClient`, `azure.cosmos.aio.CosmosClient` | `guard` | Runs reads and queries. The first write, stored procedure, trigger or batch stops the Preview. |
| Firestore | `google-cloud-firestore` 2.34: `Client`, `AsyncClient` | `guard` | Runs reads, queries and listeners. The first write stops the Preview. |

None of the batch-two stores can run in `preview` mode (Cassandra, Elasticsearch and OpenSearch have no rollback; see [Batch two stores](../../spec/data-stores.md#batch-two-stores)), so a Preview of a handler that writes to one answers 409 and never confirms.

Send and observed Send are never blocked. Their writes commit as usual, and an observed Send traces every store command as a `Db` log entry.

Install the client libraries you use; the core imports each hook on first use and needs none of them: `pip install redis`, `pip install boto3` (or `aioboto3`), `pip install pymongo`, `pip install cassandra-driver`, `pip install "elasticsearch>=8,<9"`, `pip install "opensearch-py>=2,<3"`, `pip install "azure-cosmos>=4.17,<4.18"`, `pip install "google-cloud-firestore>=2.34,<2.35"`. The `redis`, `dynamodb`, `mongodb`, `cassandra`, `elasticsearch`, `opensearch`, `cosmosdb` and `firestore` extras of `sendproof-core` pull them in.

Motor is not supported: `mongo_store` refuses a Motor client with a `TypeError`. Motor is deprecated in favour of PyMongo's own `AsyncMongoClient`, and it runs PyMongo in a thread pool that drops the Preview's context, so the binding could not attribute a stray write to a Preview. Move to `AsyncMongoClient`; its API is close to Motor's.

## Coverage: only hooked clients are covered

> [!WARNING]
> The binding covers a store only through the client you pass to `mongo_store`, `redis_store`, `dynamodb_store`, `cassandra_store`, `elasticsearch_store`, `opensearch_store`, `cosmosdb_store` or `firestore_store`. Other clients are not covered: their writes are neither blocked nor rolled back. That includes a client created inside a handler, a second client for the same store, a Redis Cluster or Sentinel client built without the guarded connection class, a DynamoDB client made from an unhooked session (including `boto3.client(...)`, which uses boto3's default session), a second `Cluster`, `Elasticsearch`, `OpenSearch`, `CosmosClient` or Firestore `Client` you did not hook (and a `cqlengine` connection that builds its own cluster), and a raw socket. The batch-two hooks cover everything derived from the client you pass: every session of a hooked `Cluster`, made before or after, `client.options(...)` copies, the database and container proxies of a `CosmosClient`, and the collections, documents, batches, transactions and `bulk_writer` of a Firestore client. Hook every client your handlers use, at startup. MongoDB is the exception that proves the rule: its command monitor sees every PyMongo client, so a write through an unhooked one during a Preview fails that Preview with 500 instead of passing silently.

## Background work and writes outside any request

The adapters mark every request they handle. While a Preview is open, a write through a hooked client that no request accounts for is **refused before it is sent**: it raises `PreviewWriteBlocked` and **every** open Preview is blocked (409), or answers 500 when it holds a MongoDB transaction the write could never join. Such a write most likely comes from a thread a Preview handler started without its context (`threading.Thread`, `loop.run_in_executor`, a thread pool), or from a client's own background threads, and a guarded store can't roll it back. `asyncio.create_task`, `asyncio.to_thread`, FastAPI's `run_in_threadpool` and asgiref's `sync_to_async` copy the context, so work started through them stays attributed to its request. A write through a PyMongo client that was never hooked can't be refused; command monitoring sees it after it was sent and fails every open Preview with 500.

A thread or task that carries a Preview's context stays part of that Preview after it ends: a write it makes after the response went out is still refused, for as long as the process runs. A thread that dropped its context and writes after every Preview has ended can't be told from background work, so its write runs.

Wrap genuine background work, such as a scheduler job or a worker thread started at startup, in `detached()` so it is never refused:

```python
from sendproof_core import detached

def refresh_rates():
    with detached():
        cache.set("rates", fetch_rates())
```

Two gaps remain. The body of a Django `StreamingHttpResponse` runs after the middleware returns, so a store write made while streaming counts as unattributed; FastAPI streams inside the request, and Flask keeps the mark until the server closes the body. And for Redis and DynamoDB only hooked clients are seen.

## Register the stores

Hook each client at startup and pass the stores to your framework's `Sendproof` as `data_stores`. FastAPI and Flask take the argument directly; Django takes `DATA_STORES` in `settings.SENDPROOF`.

```python
import boto3
import redis
from pymongo import MongoClient

from sendproof_core.stores import dynamodb_store, mongo_store, redis_store
from sendproof_fastapi import Sendproof          # or sendproof_flask
from sendproof_sqlalchemy import SQLAlchemyPreview

catalog = mongo_store(MongoClient(mongo_url), name="catalog")     # handlers use catalog.client
cache = redis_store(redis.Redis.from_url(redis_url), name="cache")  # hooks the client in place
session = boto3.Session()
orders = dynamodb_store(session, name="orders")                    # hooks the session; make clients from it afterwards

Sendproof(app, provider=SQLAlchemyPreview(engine, database="inventory_dev"),
          data_stores=[catalog, cache, orders])
```

```python
# Django settings.py
SENDPROOF = {
    "ENVIRONMENT": "Development",
    "PROVIDER": "myapp.sendproof.provider",
    "DATA_STORES": ["myapp.sendproof.catalog", "myapp.sendproof.cache"],  # store objects, or dotted paths to them
}
```

`name` is the label the workbench shows. It must be a display name such as `catalog`, never a URL, host name or credentials; a value that looks like one is refused with a `ValueError`.

`provider` (the SQL rollback provider) is optional when you pass `data_stores`. An app whose only database is MongoDB, or that has only Redis or DynamoDB, can Preview without one: MongoDB rolls back its own transaction and the guarded stores block writes. A SQL database you give no provider for is then not covered, like any unhooked client.

```python
Sendproof(app, data_stores=[mongo_store(MongoClient(mongo_url), name="catalog")])
```

### Sync and async clients

Use the clients that match your handlers.

- **FastAPI** runs `async def` endpoints on the event loop and `def` endpoints in the thread pool. Both work, with either family of clients: the Preview's scope lives in a `ContextVar`, and `run_in_threadpool` and `asyncio.to_thread` copy it into the worker thread.
- **Django** runs the Preview in a synchronous middleware. An `async` view reaches a store through `sync_to_async`, which copies the scope too. Use the synchronous clients.
- **Flask** is synchronous. Use the synchronous clients.

An asynchronous MongoDB client (`AsyncMongoClient`) needs the ASGI adapter; under Flask and Django every Preview with it fails with 500.

Every cleanup step runs, whatever ends the handler: an exception, the MongoDB time limit, a client that disconnects, or task cancellation (`asyncio.CancelledError` is a `BaseException`). Each store is aborted, SQL is rolled back and the transaction released, even when one of those steps itself raises; the Preview then answers 500, or the interrupt propagates once cleanup is done.

### MongoDB

`mongo_store(client)` returns a store whose `client` is a guarded client with the driver's own API. Handlers must use it, not the original client:

```python
catalog = mongo_store(MongoClient(url), name="catalog")

@app.get("/documents/{id}")
def read(id: str):
    return catalog.client["shop"]["documents"].find_one({"_id": id})
```

- **Create the client after importing `sendproof_core.stores.mongo_hook`** (importing the hook registers a global command listener), or pass `event_listeners=[mongo_monitor]` to a client you build earlier. The store refuses a client built without the listener, and a Preview never begins (it answers 500) until the listener has seen the guarded client's own detection `hello`: that proves the tripwire below is installed on that client.
- During a Preview, every database and collection method adds the Preview session to its call. A call that passes its own session is refused, and the Preview answers 500. Handles derived from a guarded one (`with_options`, `get_database` and `get_collection` with options, `.database`, `.client`) are guarded too.
- `catalog.client.start_session()` hands out a view of the Preview's session. Its `start_transaction()` and `with_transaction()` run inside the Preview transaction; its `commit_transaction()` and `abort_transaction()` never reach the server and fail the Preview with 500, like a raw SQL `COMMIT`; `end_session()` leaves the session to the Preview. A raw `{"commitTransaction": 1}` or `{"abortTransaction": 1}` command through `db.command()` is refused the same way.
- The driver hands the Preview's own session back on cursors (`cursor.session`). That session is sealed for the Preview: its `commit_transaction()` and `abort_transaction()` are refused before anything is sent and fail the Preview with 500, and its `end_session()` does nothing. Only the binding ends the transaction.
- `db.command("aggregate", "documents", pipeline=[...])` is classified with its keyword fields, so an `$out` or `$merge` passed that way is blocked like any other.
- A method the binding does not know is refused during a Preview rather than let through, so a new driver method fails closed.
- A Preview may hold its transaction for `preview_timeout` seconds, 50 by default (below MongoDB's 60-second transaction lifetime): `mongo_store(client, preview_timeout=30)`. A handler still running at the limit loses the transaction: its later commands fail, nothing commits, and the Preview answers 500.
- Once a Preview has ended, for any reason, the guarded handles and the session view refuse every further call with `PreviewTransactionControl`, so a thread the handler left behind can't write on a session whose transaction is gone (where the driver would autocommit). A call already running when the Preview ends holds the abort until it returns, so it stays inside the transaction, and the Preview answers 500 because it can't list that write.
- The driver ignores a failed `abort_transaction()`, and the server would then keep the transaction and its locks until its 60-second lifetime limit. The store checks the server's own answer through the command listener: the abort counts only when the server acknowledged it or answered that the transaction no longer exists (`NoSuchTransaction`). When a command was sent on the Preview session and the abort got no such answer (the connection dropped), the Preview answers 500 at once, and in the background (a daemon thread for PyMongo, a task on the event loop for `AsyncMongoClient`) the store ends the transaction with `killSessions` on the Preview's session, retrying with backoff (0.1 s doubling to 2 s) for up to 10 s. If that fails too it logs a warning with the session id on the `sendproof` logger, and the server ends the transaction at its lifetime limit. The session is ended only after that, so the driver can't reuse its id meanwhile. A Preview whose abort was acknowledged sends no `killSessions`. Nothing is committed either way: no `commitTransaction` is ever sent for a Preview session.
- When the `hello` that detects the topology can't be sent or answered, `describe()` reports `guard` mode with `sendproof_core.stores.mongo_hook.UNREACHABLE_REASON`, "Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, so this Preview runs in guard mode", and the store detects again on the next Preview. Such a Preview runs in guard mode even though the listener hasn't yet seen the client's own `hello`, because the guarded handles refuse every write before it is sent. A server that answers as a standalone gets `STANDALONE_REASON`, "Preview unavailable: this MongoDB server doesn't support transactions".
- Objects the driver returns other than databases, collections and sessions are the driver's own. `cursor.collection` is a raw collection, and GridFS (`gridfs.GridFS`, `GridFSBucket`) accepts only a raw database. A write through either carries no Preview session: the tripwire fails the Preview with 500, but the write has already happened. Write through the guarded handles.

Command monitoring backs the guarded client up as a **tripwire**. A write sent during a Preview without the Preview's session and `autocommit: false` (through the raw client, or a call that passed another session) has already reached the server and cannot be undone, so the Preview fails with 500 and is never confirmed. The same goes for a `commitTransaction` that reaches the server, which may have committed the Preview's writes. The tripwire also covers any other client created after the hook was imported, which is why an unhooked PyMongo client that writes during a Preview fails the Preview instead of passing silently.

Beanie and MongoEngine are not covered: they build on their own client objects. Use the guarded client with PyMongo or `AsyncMongoClient` directly.

### Redis

`redis_store(client)` hooks a redis-py `Redis` (or `redis.asyncio.Redis`) or its connection pool in place, before or after it connects. The hook is a `Connection` subclass that classifies each command before any byte of it is written:

```python
cache = redis_store(redis.Redis.from_url(url), name="cache")
```

Pipelines and `MULTI` are classified as a whole before the first command is sent, so a refused write sends no command of the batch, not even `MULTI`. A write refused after a raw `execute_command("MULTI")` closes the connection, so the transaction is discarded and no `EXEC` can run it. Pub/sub commands are writes, because a delivered message cannot be recalled.

Hook a client you have not built yet, and any other library that builds redis-py pools, through the connection class:

```python
cache = redis_store(name="cache")
pool = redis.ConnectionPool.from_url(url, connection_class=cache.connection_class)  # async: cache.async_connection_class

# Django's built-in RedisCache
CACHES = {"default": {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": url,
                      "OPTIONS": {"connection_class": cache.connection_class}}}
# django-redis: OPTIONS -> CONNECTION_POOL_KWARGS -> {"connection_class": cache.connection_class}
```

`cache.guard_connection_class(redis.SSLConnection)` guards another connection class. Redis Cluster and Sentinel clients take the same `connection_class`; `redis_store(cluster_client)` is refused with a `TypeError`, because a cluster keeps a pool per node. A cluster pipeline sends each node's batch only after classifying it, so a refused write sends nothing and redis-py closes any connection left waiting for replies. Only the standalone client is tested here. Django's cache `set`, `add` and `delete` are writes, which the guard correctly blocks in a Preview; `get` is a read.

Session commands (`AUTH`, `HELLO`, `SELECT`, `CLIENT SETINFO`…) are never guarded or logged, so the password never reaches a capture.

### DynamoDB

`dynamodb_store(target)` registers botocore event handlers. The `before-parameter-build.dynamodb` handler classifies the operation before the request is built, signed or sent, so credentials and signatures never reach a capture. The `target` is a boto3 or aioboto3 session, a botocore session, a client, or a resource:

```python
session = boto3.Session()
orders = dynamodb_store(session, name="orders")
table = session.resource("dynamodb").Table("orders")       # made afterwards: covered
```

Registering on a **session** covers every client and resource made from it afterwards, including the ones aioboto3 makes. Registering on a **client** (or a resource, through its client) covers that client only. A client made before the session was hooked is not covered. Libraries that build their own botocore client, such as PynamoDB, are covered when you hook the botocore session they use; PynamoDB itself is not tested here.

### Cassandra

`cassandra_store(target)` takes a `cassandra-driver` `Cluster` or `Session` and guards it in place. The hook overrides `Session.execute_async`, which `execute`, `execute_concurrent` and the `cqlengine` object mapper all call, so it sees the statement before the driver builds a message and nothing is sent for a refused write.

```python
from cassandra.cluster import Cluster
from sendproof_core.stores import cassandra_store

cluster = Cluster(["10.0.0.5"])
tickets = cassandra_store(cluster, name="tickets")   # before or after cluster.connect(): both are covered
session = cluster.connect("support")
```

- A **cluster** covers its sessions: the ones that already exist and every session `connect()` makes afterwards (the hook wraps that cluster's public `connect`, so it relies on no private driver method). A **session** covers that session only. A session of another cluster is not covered; hook that cluster too. `cqlengine.connection.setup(...)` builds its own cluster, so build the cluster yourself, hook it and register its session with `connection.set_session(session)`.
- `SELECT`, `USE`, `DESCRIBE` and the `LIST` statements are reads. `INSERT`, `UPDATE`, `DELETE`, DDL, `GRANT` and `REVOKE` are writes, and so is a conditional statement (`IF NOT EXISTS`, `IF <condition>`) even when its condition fails.
- Every `BatchStatement` and `BEGIN BATCH` text is a write, an empty one included. `execute_graph_async` (DSE Graph) is a write: the guard can't read Gremlin.
- A `PreparedStatement` or `BoundStatement` is classified by `prepared_statement.query_string`, the text the driver prepared, so `session.prepare(...)` is allowed and its execution is classified like its text. A string with a second statement after a semicolon, or with an unterminated quote or comment, is a write.
- A `Db` entry names the statement (`INSERT`), the table and the keyspace, with every string, number, UUID and blob literal replaced by `?` and comments dropped. It is logged when the reply arrives, with the row count of the first page. A batch has no statement text.
- `cassandra-driver` has no `asyncio` API. From FastAPI call `await asyncio.to_thread(session.execute, ...)`, which keeps the Preview's context.

### Elasticsearch and OpenSearch

`elasticsearch_store(client)` hooks an `elasticsearch` 8 client and `opensearch_store(client)` an `opensearch-py` 2 client, each in place, synchronous or asynchronous. The hook is a `Transport` subclass whose `perform_request` classifies every request by method, path and, for the SQL endpoints, the body, below the typed API and above the HTTP node. Typed methods, `helpers.bulk`, `helpers.scan` and raw `client.perform_request` all pass through it.

```python
from elasticsearch import Elasticsearch
from opensearchpy import OpenSearch
from sendproof_core.stores import elasticsearch_store, opensearch_store

search = Elasticsearch(es_url)
elasticsearch_store(search, name="search")
logs = OpenSearch(os_url)
opensearch_store(logs, name="logs")                  # reported as opensearch
```

To build the client with the hook instead, create the store alone and pass its transport class: `Elasticsearch(url, transport_class=store.guard_transport_class(Transport))`.

- A `POST` is not a write by itself: `_search`, `_msearch`, `_count`, `_mget`, `_field_caps`, template searches and the other listed endpoints read through a `POST` body. `_bulk`, `_update_by_query`, `_delete_by_query` and `_reindex` always write, even when they match nothing, as do document `PUT`, `POST` and `DELETE`, stored scripts, and every index, alias, template and mapping change. A `GET` or `HEAD` to a path the table does not list reads; any other unlisted request writes.
- The SQL endpoints (`_sql`, `_plugins/_sql`, `_opendistro/_sql`) read only when the body's `query` is one `SELECT`, `SHOW` or `DESCRIBE`, or fetches the next page of a cursor. OpenSearch's legacy SQL engine can run `DELETE`.
- Point-in-time, scroll, async-search and SQL-cursor handles are allowed and not logged.
- `client.options(...)` copies share the hooked transport and stay guarded. A second client is not covered unless you hook it or build it with the guarded transport class.
- The refusal happens in `Transport.perform_request`, above node selection, retries and the node pool, so a refused write never marks a node dead, is never retried and never affects other traffic.
- The bulk helpers send from the caller: `helpers.bulk` and `helpers.streaming_bulk` (and the async helpers) are refused on the handler's thread when they send their first chunk, and their retries cover only answers a node sent (`429`), never a refusal. `helpers.parallel_bulk` sends from its own thread pool, which carries no request, so its first chunk is refused there as [unattributed](#background-work-and-writes-outside-any-request) and the error reaches the caller. Neither client has a bulk indexer that queues writes to send later.
- A `Db` entry carries the operation (`search`, `update`), the index and the request body with every value replaced by `?` (field names and operators stay), plus the number of hits or documents the reply reports.
- `treat_as_read` takes the table's endpoint name, or `METHOD /path` with `{}` for each index or id segment (`POST /{}/_refresh`) for an endpoint the table does not list.

### Cosmos DB

`cosmosdb_store(client)` hooks an `azure-cosmos` 4 `CosmosClient` or `azure.cosmos.aio.CosmosClient` in place, through its azure-core transport:

```python
from azure.cosmos import CosmosClient
from sendproof_core.stores import cosmosdb_store

client = CosmosClient(url, credential)
cosmosdb_store(client, name="orders")
```

- **Why the transport:** `CosmosClient` builds a fixed policy list, so azure-core's `per_call_policies=` is not honoured (it falls through to the HTTP session and fails). `transport=` is honoured, and every request the SDK sends passes through it after signing and before it is written. A client already built is hooked by swapping its transport's class; the pipeline's private layout (`client_connection.pipeline_client._pipeline._transport`, and that its last step sends through it) is checked at registration, and a client whose layout differs is refused with `TypeError` instead of left unguarded. `cosmosdb_store` supports `azure-cosmos>=4.17,<4.18`, the minor versions it was verified against (the `cosmosdb` extra pins the same range), and refuses any other version at registration.
- The refusal is an ordinary exception, not an azure-core error, so the SDK's retry policies, region failover and circuit breaker never see it and never retry it or mark an endpoint unavailable.
- With an availability strategy (cross-region hedging) the SDK sends from its own thread pool, which carries no request. Writes there are refused as [unattributed](#background-work-and-writes-outside-any-request); hedged reads run but are not logged.
- To build the client with the hook, create the store alone and pass `transport=store.guard_transport(RequestsTransport())`.
- Each request is classified by method, resource path and the `x-ms-documentdb-isquery`, `x-ms-cosmos-is-query-plan-request`, `x-ms-cosmos-is-batch-request` and `x-ms-documentdb-is-upsert` headers. Reads, queries, query plans and the change feed run. `create_item`, `upsert_item`, `replace_item`, `patch_item`, `delete_item`, transactional and bulk batches, stored-procedure execution (even one that only reads) and any request that names a pre-trigger or post-trigger are writes.
- Database and container proxies, and `container.scripts`, share the client's one pipeline, so they stay guarded.
- A `Db` entry names the operation, the container and the database, with the query text's literals replaced by `?` and parameter values never logged.
- Cosmos DB has no service in the test suite. The hook is proven by replaying the requests recorded in `spec/data-stores/recordings/cosmosdb.json` through it, and by driving the real client against a local HTTP server.

### Firestore

`firestore_store(client)` hooks a `google-cloud-firestore` 2 `Client` or `AsyncClient` in place with a gRPC channel interceptor:

```python
from google.cloud import firestore
from sendproof_core.stores import firestore_store

db = firestore.Client()
firestore_store(db, name="profiles")        # firebase_admin.firestore.client() returns the same Client
```

- The interceptor sees every call type: unary calls, server streams (`RunQuery`, `BatchGetDocuments`) and bidirectional streams. A `Write` stream is refused when it is opened, before its first message. The asynchronous client needs four interceptors (the `grpc.aio` channel registers an interceptor for one call shape only), and the binding passes all four.
- `GetDocument`, `ListDocuments`, `BatchGetDocuments`, `RunQuery`, `RunAggregationQuery`, `PartitionQuery`, `Listen` and `ListCollectionIds` are reads. `BeginTransaction` and `Rollback` are allowed. `Commit` is a write when its request carries a write; a `Commit` with none only ends a transaction that read and wrote nothing, so it is allowed. `BatchWrite`, `Write`, the document RPCs and any method the table does not list are writes.
- The Python client takes no transport, and the generated transport builds all its stubs from the channel it is given. The hook therefore swaps the client's class for a subclass that builds the transport over an intercepted channel, and clears a client that was already used so the next call rebuilds it guarded. It relies on private methods (`_firestore_api_helper` and, for `AsyncClient`, `_emulator_channel` and `_to_sync_copy`), checks them at registration, and supports `google-cloud-firestore>=2.34,<2.35`, the minor versions it was verified against (the `firestore` extra pins the same range); any other version or layout is refused with `TypeError`. An `AsyncClient`'s synchronous copy, which `bulk_writer` uses, is guarded too.
- `bulk_writer()` queues writes and sends `BatchWrite` later from its own threads, retrying failures. Its `create`, `set`, `update` and `delete` are refused in a Preview when the handler queues them, on the handler's thread, so nothing is queued or sent and `close()` never waits on a refused batch. Outside a Preview its batches run in the context of the code that flushed them, so observed Sends log them. A `BulkWriter` built directly (`BulkWriter(client=...)`) is not wrapped: its sends are refused on its own threads as [unattributed](#background-work-and-writes-outside-any-request), which a large enough Preview batch can stall, so use `client.bulk_writer()`.
- A `Db` entry names the RPC (`Commit`, `RunQuery`), the collection and the database id, never a value or a query. A gRPC stream is logged when it is opened, without timing.
- Firestore has no service in the test suite. The hook is proven by replaying `spec/data-stores/recordings/firestore.json` through it, and by driving real clients against a local gRPC server.

### Unsupported

- **Cassandra:** libraries other than `cassandra-driver`. The Cassandra Python driver has no async API; `acsylla` and `aiocassandra` are not hooked.
- **Elasticsearch and OpenSearch:** `elasticsearch` 7 and 9, `opensearch-py` 1 and 3, `elasticsearch-dsl` and `opensearch-dsl` over an unhooked client, and any other HTTP client, are not covered.
- **Cosmos DB:** `azure-cosmos` outside 4.17 (refused at registration until verified); the MongoDB, Cassandra, Gremlin and Table APIs of Cosmos DB, which use their own drivers.
- **Firestore:** Datastore mode and the REST transport; `google-cloud-firestore` outside 2.34 (refused at registration until verified).
- **MongoDB:** Motor (see above).

## Mark an operation `preview: false`

An operation you know writes to a guarded store, such as one that clears a Redis session, can be marked `preview: false`. The workbench then shows "Preview unavailable" with your reason before anyone tries, and a Preview of it is refused (409, never confirmed) without running the handler. Send still runs it. The binding never infers the mark; without it the operation is advertised and the guard decides at run time.

Give a `reason`, the `stores` it writes, or both. With only `stores`, the reason is "Preview unavailable: this operation writes to Redis" (for the first store).

```python
# FastAPI
@app.delete("/sessions/{id}")
@preview(False, reason="Clears the Redis session", stores=["redis"])
def delete_session(id: str): ...

# Flask
@app.delete("/sessions/<id>")
@preview(False, reason="Clears the Redis session")
def delete_session(id): ...

# Django, Django REST framework and Django Ninja
@preview(False, methods=["DELETE"], reason="Clears the Redis session")
def delete_session(request, id): ...
```

Previewable reads use `@preview` as before. Flask and Django function views are previewable for their write methods unless you pass `methods=["GET"]`.

## What a blocked Preview returns

When the guard refuses a write, the command never reaches the store and the handler gets a `PreviewWriteBlocked` (from `sendproof_core.stores`, with `store` and `operation`). The Preview then answers 409 with `application/problem+json`, whatever the handler made of the error:

```json
{ "type": "about:blank", "title": "Preview unavailable", "status": 409, "code": "preview_unavailable",
  "detail": "Preview unavailable: this operation writes to Redis", "store": "redis", "operation": "INCR", "rolledBack": false }
```

The SQL transaction rolls back as usual. A failed rollback or abort, a handler `COMMIT` or `commit_transaction`, or a write that escaped the MongoDB session answers 500 without confirmation instead. A handler that lets the error escape gets the same 409 as one that swallows it.

In `preview` mode MongoDB blocks only what a transaction cannot run, such as `$out`, `$merge`, `estimated_document_count`, `create_collection` or `list_collection_names`, with a reason like "Preview unavailable: MongoDB can't run $out inside a transaction". Creating an index is not on that list because MongoDB refuses it only for a collection that already exists; the server's refusal reaches the handler as an error, and nothing is applied.

## Host-declared reads

Each store takes `treat_as_read`, a list of exact command names the guard should let through, such as a custom Redis module read:

```python
redis_store(client, treat_as_read=["MYMODULE.GET"])
```

> [!WARNING]
> `treat_as_read` is your statement that the command never writes. The guard trusts it: a listed command that does write is not blocked, and its write happens during the Preview. Names match exactly, with no wildcards.

## MongoDB limits

These come from MongoDB's transaction limits; see [MongoDB in Preview](../../spec/data-stores.md#mongodb-in-preview).

- A Preview whose handler runs longer than `preview_timeout` (50 seconds by default) fails with 500, and nothing is written.
- Two Previews that write the same document do not queue: the second gets a `WriteConflict` (`OperationFailure`, code 112), and the handler decides what to answer. The Preview still rolls back.
- Keep a Preview under about 1,000 changed documents.
- Document `before` images are read at the Preview transaction's snapshot time, so a concurrent commit by another request never shows up as a change.
- `create_collection()` fails inside a Preview, because MongoDB refuses an explicit `create` in a transaction with snapshot read concern. Inserting into a new collection creates it and rolls back.

## Logs and redaction

Every store command in a Preview or observed-Send trace is a `Db` log entry with the store, operation, target, sanitized statement, rows and time. Statements never carry values: MongoDB statements keep field names and operators with every literal as `"?"`, Redis statements keep the command, a container command's subcommand and key names (`SET session:42 ?`), and DynamoDB statements are the PartiQL text with every inline string or number literal replaced by `?`. Cassandra statements are the CQL text, Elasticsearch and OpenSearch statements the request body, and Cosmos DB statements the query text, each with every literal replaced by `?`; Firestore statements are the request message as JSON with every literal, document paths included, as `"?"`. Redis entries carry the time to the reply and, for a refused command, the Redis error code only (`WRONGTYPE`, `ERR`), never the rest of the message; redis-py reads one reply per command it sends, so the hook pairs them on each connection. A connection in pub/sub or `MONITOR` mode receives messages nobody asked for, so its commands are logged untimed. Session commands such as `AUTH` and `hello` are never logged.

Change records for MongoDB carry `store`, `namespace`, the collection as `table`, `{"_id": …}` as `key`, and whole nested documents as `before` and `after`, with BSON types in MongoDB Extended JSON (`{"$oid": …}`, `{"$date": …}`). A field with a secret name, such as `password_hash` or `apiKey`, is `"[REDACTED]"` at any depth. `via` is `"upsert"` or `"replace"` when the change came from an upsert or a whole-document replacement.

## Run the tests

Start the services, then run the Python suite (the store tests skip, with the command in the reason, when a service does not answer a protocol request):

```sh
docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb
docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra opensearch   # about 3 GB
python3 adapters/python/scripts/prepare.py
adapters/python/.venv/bin/python -m pytest adapters/python -q
node tests/conformance/run.mjs python-fastapi        # python-django, python-flask, python-flask-sqlalchemy
BENCH_STORES=mongodb,redis,dynamodb node tests/conformance/run.mjs python-flask   # without the heavy stores
```

The Cassandra and OpenSearch tests skip, with the command in the reason, when their services are down. Cosmos DB and Firestore need no service, and the Elasticsearch tests run over a stand-in node.

`scripts/embed_store_tables.py` regenerates `core/src/sendproof_core/stores/tables.py` from `spec/data-stores/`; a unit test fails when the two differ.
