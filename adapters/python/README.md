# Sendproof for Python

Python adapters for the [Sendproof protocol](../../spec/README.md). They serve the shared
workbench UI from your application and add two ways to exercise real endpoints:

- **Preview** runs the real operation, with its real authentication, validation and database
  writes, inside a transaction that is always rolled back, then reports the response, the row
  changes, the suppressed effects and the logs.
- **Observed Send** runs the operation normally (it commits) and records the same details in a
  short-lived trace owned by the signed-in caller.

| Distribution | Import | Purpose |
| --- | --- | --- |
| [`sendproof-core`](core) | `sendproof_core` | Protocol, capture, trace store, embedded UI. No framework or database dependency. |
| [`sendproof-fastapi`](fastapi) | `sendproof_fastapi` | FastAPI and Starlette adapter (pure ASGI). |
| [`sendproof-sqlalchemy`](sqlalchemy) | `sendproof_sqlalchemy` | SQLAlchemy 2.x rollback and change capture, sync and async engines. |
| [`sendproof-flask`](flask) | `sendproof_flask` | Flask adapter (WSGI). Pairs with `sendproof-sqlalchemy`. |
| [`sendproof-django`](django) | `sendproof_django` | Django middleware for plain views, Django REST framework and Django Ninja, with Django ORM rollback and change capture. |

Python 3.10 or newer. The adapters make no network calls and add nothing to your application
unless you opt in.

## Data stores

Preview also covers MongoDB (rolled back in its own transaction), Redis, DynamoDB, Cassandra, Elasticsearch,
OpenSearch, Cosmos DB and Firestore (writes are blocked), for PyMongo, `AsyncMongoClient`, redis-py,
`redis.asyncio`, boto3, aioboto3, `cassandra-driver`, `elasticsearch` 8, `opensearch-py` 2, `azure-cosmos` 4.17 and
`google-cloud-firestore` 2.34 (Motor is refused). See
[Data stores in the Python binding](data-stores.md) for setup, `@preview(False, reason=...)` and the
coverage warning: only hooked clients are covered.

```python
from sendproof_core.stores import mongo_store, redis_store

Sendproof(app, provider=SQLAlchemyPreview(engine), data_stores=[
    mongo_store(mongo_client, name="catalog"), redis_store(redis_client, name="cache")])
```

## Opt in

```python
from fastapi import FastAPI
from sendproof_fastapi import Sendproof, preview
from sendproof_sqlalchemy import SQLAlchemyPreview

app = FastAPI(title="Inventory")

Sendproof(app, provider=SQLAlchemyPreview(engine, database="inventory_dev"),
          environment="Development", identity=identity_from_session)

@app.post("/items", status_code=201)
@preview                      # only marked operations are advertised and accepted
def create_item(item: ItemIn, db: Session = Depends(get_db)): ...
```

The workbench is mounted at `/sendproof/`. It is **off unless `environment` is listed in
`environments`** (default `("Development",)`); without an explicit environment the adapter reads
`SENDPROOF_ENVIRONMENT` and otherwise assumes `Production`, so a deployed application is not
exposed by installing the packages.

## Develop in this repository

```sh
python3 adapters/python/scripts/prepare.py     # venv, editable installs, embeds the UI bundle (needs network)
adapters/python/.venv/bin/python -m pytest adapters/python -q
node tests/conformance/run.mjs python-fastapi             # shared protocol runner: python-fastapi | python-flask | python-django
python3 adapters/python/scripts/build.py       # wheels and sdists in adapters/python/dist
```

The UI is never copied into this tree. `scripts/embed_ui.py` runs the shared packer
(`node tools/pack-ui.mjs`) and writes its output, `manifest.json` included, into
`core/src/sendproof_core/ui/`, which git ignores. The core serves only files listed in that
manifest and verifies each SHA-256 before use.
