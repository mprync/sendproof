# Data stores in the Python binding

Sendproof Preview promises that a confirmed Preview never leaves a write behind. For SQL, the rollback provider guarantees it. For MongoDB, Redis and DynamoDB, the Python binding hooks each store's client, following the rules in [spec/data-stores.md](../../spec/data-stores.md). The hooks live in `sendproof_core.stores`, so the same code serves FastAPI, Flask and Django.

| Store | Clients | Mode | What a Preview does |
| --- | --- | --- | --- |
| MongoDB replica set or sharded cluster | PyMongo, `AsyncMongoClient` | `preview` | Runs every command in one transaction, reports document changes, and aborts it. |
| MongoDB standalone server | PyMongo, `AsyncMongoClient` | `guard` | Runs reads. The first write stops the Preview. |
| Redis | redis-py and `redis.asyncio`, including Django's `RedisCache` | `guard` | Runs reads. The first write stops the Preview. |
| DynamoDB | boto3, aioboto3, botocore | `guard` | Runs reads. The first write stops the Preview. |

Send and observed Send are never blocked. Their writes commit as usual, and an observed Send traces every store command as a `Db` log entry.

Install the client libraries you use; the core imports each hook on first use and needs none of them: `pip install redis`, `pip install boto3` (or `aioboto3`), `pip install pymongo`. The `redis`, `dynamodb` and `mongodb` extras of `sendproof-core` pull them in.

Motor is not supported: `mongo_store` refuses a Motor client with a `TypeError`. Motor is deprecated in favour of PyMongo's own `AsyncMongoClient`, and it runs PyMongo in a thread pool that drops the Preview's context, so the binding could not attribute a stray write to a Preview. Move to `AsyncMongoClient`; its API is close to Motor's.

## Coverage: only hooked clients are covered

> [!WARNING]
> The binding covers a store only through the client you pass to `mongo_store`, `redis_store` or `dynamodb_store`. Other clients are not covered: their writes are neither blocked nor rolled back. That includes a client created inside a handler, a second client for the same store, a Redis Cluster or Sentinel client built without the guarded connection class, a DynamoDB client made from an unhooked session (including `boto3.client(...)`, which uses boto3's default session), and a raw socket. Hook every client your handlers use, at startup. MongoDB is the exception that proves the rule: its command monitor sees every PyMongo client, so a write through an unhooked one during a Preview fails that Preview with 500 instead of passing silently.

## Background work and writes outside any request

The adapters mark every request they handle. While a Preview is open, a write through a hooked client (or any PyMongo client) that no request accounts for fails **every** open Preview with 500. Such a write most likely comes from a thread a Preview handler started without its context (`threading.Thread`, `loop.run_in_executor`); it was neither blocked nor rolled back, so no Preview may claim a rollback. `asyncio.create_task`, `asyncio.to_thread`, FastAPI's `run_in_threadpool` and asgiref's `sync_to_async` copy the context, so work started through them stays attributed to its request.

Wrap genuine background work, such as a scheduler job or a worker thread started at startup, in `detached()` so it never fails a Preview:

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

Every store command in a Preview or observed-Send trace is a `Db` log entry with the store, operation, target, sanitized statement, rows and time. Statements never carry values: MongoDB statements keep field names and operators with every literal as `"?"`, Redis statements keep the command, a container command's subcommand and key names (`SET session:42 ?`), and DynamoDB statements are the PartiQL text with every inline string or number literal replaced by `?`. Redis entries carry the time to the reply and, for a refused command, the Redis error code only (`WRONGTYPE`, `ERR`), never the rest of the message; redis-py reads one reply per command it sends, so the hook pairs them on each connection. A connection in pub/sub or `MONITOR` mode receives messages nobody asked for, so its commands are logged untimed. Session commands such as `AUTH` and `hello` are never logged.

Change records for MongoDB carry `store`, `namespace`, the collection as `table`, `{"_id": …}` as `key`, and whole nested documents as `before` and `after`, with BSON types in MongoDB Extended JSON (`{"$oid": …}`, `{"$date": …}`). A field with a secret name, such as `password_hash` or `apiKey`, is `"[REDACTED]"` at any depth. `via` is `"upsert"` or `"replace"` when the change came from an upsert or a whole-document replacement.

## Run the tests

Start the services, then run the Python suite (the store tests skip, with the command in the reason, when a service does not answer a protocol request):

```sh
docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb
python3 adapters/python/scripts/prepare.py
adapters/python/.venv/bin/python -m pytest adapters/python -q
node tests/conformance/run.mjs python-fastapi        # python-django, python-flask, python-flask-sqlalchemy
```

`scripts/embed_store_tables.py` regenerates `core/src/sendproof_core/stores/tables.py` from `spec/data-stores/`; a unit test fails when the two differ.
