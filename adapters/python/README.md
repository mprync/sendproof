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

## Preview sessions and journey files

An enabled workbench advertises Preview sessions automatically when all its rollback providers
can hold a transaction. The session keeps earlier steps' changes visible to later steps, including
GET requests, and rolls everything back when ended. A worker allows four sessions per owner and
sixteen in total. The defaults are five minutes idle and thirty minutes total. Set
`session_idle_timeout` and `session_max_lifetime` in seconds to override them.

Pass local Arazzo files to FastAPI or Flask as `journey_files=["journeys/store.arazzo.json"]`. In
Django, set `SENDPROOF["JOURNEY_FILES"]` to the same list and configure timeouts with
`SESSION_IDLE_TIMEOUT` and `SESSION_MAX_LIFETIME`. Keep `store.expect.json` next to the Arazzo file.
Use application-relative source URLs such as `/openapi.json`. Sendproof adds the application's path
base to local source URLs and publishes both files in workbench discovery.

Keep workbench traffic on the same worker for the life of a session. FastAPI closes sessions on
ASGI shutdown. If the workbench is mounted on a sub-application, await its `Sendproof.aclose()` from
the parent lifespan. Flask and Django roll back sessions at process exit. You can call
`Sendproof.close()` or `sendproof_django.close_sessions()` in a WSGI server's worker shutdown hook
to release connections before other resources are torn down. See [store limits](data-stores.md#held-preview-sessions).

## Code journeys

Give your Preview-enabled `POST /items` route an OpenAPI operation ID of `createItem`. After declaring
the routes, define the journey and register it in your `Sendproof` setup.

```python
from pydantic import BaseModel
from sendproof_core.journey_builder import JourneyBuilder

class CreateInputs(BaseModel):
    item_id: str
    name: str = "Sample item"

journey = JourneyBuilder("createItem", name="Create an item", group="Inventory", inputs=CreateInputs)
create = journey.step("create", "createItem")
create.request_body({"id": journey.input("item_id"), "name": journey.input("name")})
create.succeeds_with(201)
create.expect_writes().sql("items", "insert", key={"id": journey.input("item_id")},
                           values={"name": journey.input("name")})

Sendproof(app, provider=provider, environment="Development", journeys=[journey])
```

`inputs` accepts a Pydantic v2 model or a JSON Schema object. Use `step.set()` for parameters
and `step.output()` for values needed later. `expect_writes()` supports SQL, MongoDB, Redis,
other hooked stores and effects. Mark a journey that requires a real Send with `journey.send_only(reason)`.
An `ApprovedDifference` names its target with `table` for SQL, `collection` for MongoDB, or `key` for Redis.

FastAPI uses its built-in OpenAPI schema by default. For Flask or a custom OpenAPI route, pass
`journey_openapi` the same schema factory that the route uses. In Django, set `SENDPROOF["JOURNEYS"]`
and `SENDPROOF["JOURNEY_OPENAPI"]` to the journey list and schema factory (or its dotted import path).
File and code journeys can be registered together. Invalid code journeys stop startup in Development.
In other enabled environments, the adapter logs and skips them.

In CI, start the API with Sendproof enabled and run its published journey with the Sendproof CLI.
With Preview sessions enabled, this command rolls back the run and writes a JUnit report.

```sh
sendproof journeys run createItem --api http://127.0.0.1:8000 --inputs inputs.json --junit journeys.xml
```

Put `{"item_id":"ci-item"}` in `inputs.json` and supply the CLI's authentication options if the API
requires sign-in. For Send-only runs against a disposable development API, add
`--mode send --yes --allow-send`. The CLI's exit status determines the CI result.

## Develop in this repository

```sh
python3 adapters/python/scripts/prepare.py     # venv, editable installs, embeds the UI bundle (needs network)
adapters/python/.venv/bin/python -m pytest adapters/python -q
node tests/conformance/run.mjs python-fastapi             # any Python binding in tests/conformance/bindings.json
python3 adapters/python/scripts/build.py       # wheels and sdists in adapters/python/dist
```

The UI is never copied into this tree. `scripts/embed_ui.py` runs the shared packer
(`node tools/pack-ui.mjs`) and writes its output, `manifest.json` included, into
`core/src/sendproof_core/ui/`, which git ignores. The core serves only files listed in that
manifest and verifies each SHA-256 before use.
