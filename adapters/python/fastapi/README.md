# sendproof-fastapi

Serves the [Sendproof](../../spec/README.md) workbench from a FastAPI or Starlette application
and runs rollback **Preview** and **Observed Send** through the application's own routing,
dependencies and authorization.

```sh
pip install sendproof-fastapi sendproof-sqlalchemy
```

```python
from fastapi import Depends, FastAPI
from sendproof_core import Identity
from sendproof_fastapi import AuthProvider, Sendproof, preview
from sendproof_sqlalchemy import SQLAlchemyPreview

app = FastAPI(title="Inventory")

def identity(request) -> Identity | None:        # read what your authentication already set up
    user = request.session.get("user")
    return user and Identity(user["name"], user["role"], subject=user["id"], authentication_type="session")

Sendproof(
    app,
    provider=SQLAlchemyPreview(engine, database="inventory_dev"),
    identity=identity,
    environment="Development",                       # off in any environment not listed
    auth_providers=[AuthProvider("Password", "cookie", "/auth/sign-in")],
)

@app.post("/items", status_code=201)
@preview                                             # below the route decorator
def create_item(item: ItemIn, db: Session = Depends(get_db)):
    ...
```

Open `/sendproof/`. Create the `Sendproof` before the application starts serving requests.

## How it works

- **Opt in per operation.** `@preview` marks a path operation function (sync or `async`). Only
  marked operations are advertised in discovery and accepted by the preview route. The function
  keeps its signature, so dependency injection and OpenAPI are unchanged.
- **Preview.** A request to `/sendproof/_preview/<path>` with exactly `Prefer: tx=rollback` is routed
  with your application's router, authenticated and validated by your dependencies, and executed
  in-process. Nothing is proxied. The adapter buffers the response (1 MiB cap), rolls the data layer
  back, and only then returns HTTP 200 with the confirmed envelope. Denied, unknown, unmarked,
  oversized or unconfirmed requests never return an envelope. The inner status can be any
  application status, including 409 or a 422 validation failure.
- **Observed Send.** The same URL with `Prefer: trace` commits normally and, for a caller with a
  stable `Identity.subject`, adds `X-Sendproof-Trace`. Fetch it at `/sendproof/_api/traces/{id}`;
  only the owner can, for five minutes by default (`trace_ttl`, 8 per owner, 32 in total).
- **Middleware order.** `Sendproof` appends its middleware as the innermost user middleware, so
  your session and authentication middleware have already run when it asks for an identity.
- **Dispatch.** A preview is re-dispatched in-process through the whole application, so every
  middleware (including path-based policies) sees the target path, with its own copy of the
  session and state. Just before the router, Sendproof checks again that the request still
  routes to the marked operation it checked first; a middleware that changed the method or path
  gets a 409 and nothing runs.

## Options

| Option | Meaning |
| --- | --- |
| `provider` | Data layer such as `SQLAlchemyPreview`. Without one nothing is advertised and previews answer 503. |
| `identity` | `(request) -> Identity \| None`, sync or async. Drives capabilities and trace ownership. |
| `authorize` | `(request, identity) -> bool`. Optional policy for the workbench, previews and traces (401/403). |
| `environment`, `environments` | Where the workbench is on. Defaults to `$SENDPROOF_ENVIRONMENT`, else `Production`; `("Development",)`. |
| `auth_providers` | Sign-in integrations shown on the workbench sign-in page (`cookie` for a password JSON endpoint, `personas`, `oidc`...). |
| `api_name`, `openapi_url`, `documents` | Display name and OpenAPI documents (default: your app title and `openapi_url`). |
| `field_modules` | Same-origin ES modules that register custom field renderers. |
| `include_sql_parameter_values` | Show SQL parameter values. Development only by default. |
| `trace_ttl`, `clock` | Trace lifetime in seconds and an injectable monotonic clock. |

## Effects and logs

Record outgoing email, HTTP calls, jobs and messages with `sendproof_core.record_email` and
friends, and skip delivery when they return `True`. Standard `logging` records are captured when
their logger propagates to the root logger.

## Notes

- Mount under a prefix with Starlette `Mount` or `root_path`; discovery URLs include it.
- The adapter does not pass `/sendproof/_preview` through your middleware twice; your middleware sees
  the preview request once, with the preview URL, before dispatch to the real route.
- Streaming and file-path responses are buffered or rejected in a preview; websockets are not supported.
- See the [SQLAlchemy coverage notes](../sqlalchemy/README.md#coverage-notes) for what a preview
  can and cannot roll back.
