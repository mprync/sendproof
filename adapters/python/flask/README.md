# sendproof-flask

Serves the [Sendproof](../../spec/README.md) workbench from a Flask application and runs
rollback **Preview** and **Observed Send** through Flask's own routing and your view code.

```sh
pip install sendproof-flask sendproof-sqlalchemy
```

```python
from flask import Flask, session
from sendproof_flask import AuthProvider, Identity, Sendproof, preview
from sendproof_sqlalchemy import SQLAlchemyPreview

app = Flask(__name__)

def identity(request) -> Identity | None:     # runs in a request context: flask.session works
    user = session.get("user")
    return user and Identity(user["name"], user["role"], subject=user["id"], authentication_type="session")

Sendproof(
    app,
    provider=SQLAlchemyPreview(engine, database="inventory_dev"),
    identity=identity,
    environment="Development",                 # off in any environment not listed
    openapi_url="/openapi.json",               # wherever you serve your OpenAPI document
    auth_providers=[AuthProvider("Password", "cookie", "/auth/sign-in")],
)

@app.post("/items")
@preview                                       # below the route decorator
def create_item(): ...
```

Open `/sendproof/`. The workbench needs an OpenAPI document; Flask has none built in, so serve one
(for example with `apispec` or `flask-smorest`) and set `openapi_url`.

## How it works

`Sendproof` wraps `app.wsgi_app`. A request to `/sendproof/_preview/<path>` with exactly
`Prefer: tx=rollback` is matched against the app's own URL map, executed in-process through the
current `app.wsgi_app` chain (so WSGI middleware wrapped around Sendproof later also sees the
target path), buffered (1 MiB cap), rolled back, and only then answered with the confirmed envelope.
A `before_request` hook that runs first checks again that the request still reaches the marked view
and method; a middleware that changed either gets a 409 and no view runs.
`Prefer: trace` on the original URL commits normally and adds `X-Sendproof-Trace` for a caller with
a stable `Identity.subject`; fetch it from `/sendproof/_api/traces/{id}` as the same caller within
`trace_ttl` seconds.

- Only `@preview` views are advertised and accepted, and only for their write methods
  (`POST`, `PUT`, `PATCH`, `DELETE`) or the methods you pass with `@preview` on a view registered
  for them.
- **Denials.** Flask has no dependency layer, so authentication usually happens inside the view.
  A 401 or 403 response is therefore always treated as a denial and never returned as an
  envelope. Any other status the view returns, including 409, is the application's answer and
  appears inside the envelope. An unhandled exception becomes an unconfirmed 500.
- A `Request` is available to `identity` and `authorize` hooks; do not read the request body in
  them.
- Record outgoing email and similar effects with `sendproof_core.record_email`, and skip delivery
  when it returns `True`.

Options match [`sendproof-fastapi`](../fastapi/README.md#options).

## Data layer

`sendproof-sqlalchemy` (sync engines). The provider enrolls the engine, so plain SQLAlchemy
sessions, `scoped_session`, Flask-SQLAlchemy's `db.session` and raw `engine.begin()` connections all
share the preview connection. See the [coverage notes](../sqlalchemy/README.md#coverage-notes). A
Flask development server runs requests on threads: with SQLite, previews at the same time block
each other.

### Flask-SQLAlchemy

Pass the extension's engine to the provider. `db.engine` needs an application context, so read it
inside one:

```python
from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from sendproof_flask import Sendproof, preview
from sendproof_sqlalchemy import SQLAlchemyPreview

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = "postgresql+psycopg://app:secret@localhost/inventory_dev"
db = SQLAlchemy(app)

with app.app_context():
    engines = list(db.engines.values())      # the default engine plus every SQLALCHEMY_BINDS entry

Sendproof(app, provider=SQLAlchemyPreview(*engines, database="inventory_dev"),
          identity=identity, environment="Development", openapi_url="/openapi.json")

@app.post("/items")
@preview
def create_item():
    db.session.add(Item(**request.get_json()))
    db.session.commit()                      # a real commit in normal use, a rolled-back one in Preview
    return jsonify(id=...), 201
```

Handlers need no changes. In a preview `db.session.commit()` ends the emulated transaction,
`db.session.rollback()` undoes only the work since the last commit, `begin_nested()` is a real
`SAVEPOINT`, and `after_commit` listeners still run. Record emails and other deliveries with
`record_email` and friends, which return `True` during a preview, so a listener that sends them is
suppressed. Flask-SQLAlchemy removes the scoped session when each request's application context ends,
which also happens for the in-process request a preview runs.

### Verified and limits

Verified with Flask 3.1.3, Flask-SQLAlchemy 3.1.1 and SQLAlchemy 2.1.9, on SQLite, PostgreSQL 17
(psycopg 3.3.9) and MySQL 8.4 (PyMySQL 1.2.4). `adapters/python/conformance/fixture_flask_sqlalchemy.py`
passed all 11 shared HTTP checks on each, as did the plain-SQLAlchemy `fixture_flask.py`. The package
tests (`flask/tests`, 20 tests) cover the same lifecycle, transaction, commit-hook and authorization
cases on SQLite by default. To run them on another database, export `BENCH_DATABASE=postgresql` or
`mysql` and `BENCH_DATABASE_URL=<disposable database>`; the tests drop and recreate their `items` and
`audit` tables.

- **Enroll every engine.** A `SQLALCHEMY_BINDS` engine that is not passed to `SQLAlchemyPreview` is
  not rolled back and its rows are not captured; its writes persist even in a preview. Pass
  `db.engines.values()`.
- **Dialects.** Verified on SQLite, PostgreSQL and MySQL. The provider uses `SAVEPOINT`. MariaDB
  and Oracle remain unverified. The provider reports SQL Server previews as unavailable.
  An `AUTOCOMMIT` engine cannot be rolled back and previews are refused.
- **Not tested.** Flask-Login, Flask async views, Flask-Migrate and `AsyncEngine` under Flask.
- **Commit hooks run during a preview.** Code in `after_commit` that has side effects outside the
  database must go through `record_*`, or it will deliver for real.
