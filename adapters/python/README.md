# Test Bench for Python

Python adapters for the [Test Bench protocol](../../spec/README.md). They serve the shared
workbench UI from your application and add two ways to exercise real endpoints:

- **Preview** runs the real operation, with its real authentication, validation and database
  writes, inside a transaction that is always rolled back, then reports the response, the row
  changes, the suppressed effects and the logs.
- **Observed Send** runs the operation normally (it commits) and records the same details in a
  short-lived trace owned by the signed-in caller.

| Distribution | Import | Purpose |
| --- | --- | --- |
| [`testbench-core`](core) | `testbench_core` | Protocol, capture, trace store, embedded UI. No framework or database dependency. |
| [`testbench-fastapi`](fastapi) | `testbench_fastapi` | FastAPI and Starlette adapter (pure ASGI). |
| [`testbench-sqlalchemy`](sqlalchemy) | `testbench_sqlalchemy` | SQLAlchemy 2.x rollback and change capture, sync and async engines. |
| [`testbench-flask`](flask) | `testbench_flask` | Flask adapter (WSGI). Pairs with `testbench-sqlalchemy`. |
| [`testbench-django`](django) | `testbench_django` | Django middleware for plain views, Django REST framework and Django Ninja, with Django ORM rollback and change capture. |

Python 3.10 or newer. The adapters make no network calls and add nothing to your application
unless you opt in.

## Opt in

```python
from fastapi import FastAPI
from testbench_fastapi import TestBench, preview
from testbench_sqlalchemy import SQLAlchemyPreview

app = FastAPI(title="Inventory")

TestBench(app, provider=SQLAlchemyPreview(engine, database="inventory_dev"),
          environment="Development", identity=identity_from_session)

@app.post("/items", status_code=201)
@preview                      # only marked operations are advertised and accepted
def create_item(item: ItemIn, db: Session = Depends(get_db)): ...
```

The workbench is mounted at `/bench/`. It is **off unless `environment` is listed in
`environments`** (default `("Development",)`); without an explicit environment the adapter reads
`TESTBENCH_ENVIRONMENT` and otherwise assumes `Production`, so a deployed application is not
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
`core/src/testbench_core/ui/`, which git ignores. The core serves only files listed in that
manifest and verifies each SHA-256 before use.
