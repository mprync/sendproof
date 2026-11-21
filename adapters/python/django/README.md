# sendproof-django

Serves the [Sendproof](../../spec/README.md) workbench from a Django project and runs rollback
**Preview** and **Observed Send** through Django's URL resolver, middleware and views. Works with
plain views, Django REST framework and Django Ninja, and captures changes through the Django ORM.

```sh
pip install sendproof-django
```

```python
# settings.py
MIDDLEWARE = [
    # ... sessions, authentication, your own middleware ...
    "sendproof_django.middleware.SendproofMiddleware",   # last
]

SENDPROOF = {
    "ENVIRONMENT": "Development",                    # off in any environment not listed
    "PROVIDER": "sendproof_django.DjangoOrmPreview",  # opt in to rollback previews
    "OPENAPI_URL": "/api/openapi.json",
    "AUTH_PROVIDERS": [{"label": "Password", "kind": "cookie", "url": "/auth/sign-in"}],
}
```

The workbench is at `/sendproof/`. It is **off** unless `ENVIRONMENT` (default `$SENDPROOF_ENVIRONMENT`,
else `Production`) is in `ENVIRONMENTS` (default `["Development"]`).

## Marking operations

```python
from sendproof_django import preview

@preview(methods=["POST"])                  # function view: methods accepted for previews
def create_item(request): ...

class Things(APIView):                      # Django REST framework (or any class-based view)
    @preview                                # decorate the handler method
    def post(self, request): ...

@api.post("/items")                         # Django Ninja: below the route decorator
@preview
def create_item(request, payload: ItemIn): ...
```

Only marked operations are advertised and accepted. Without `methods`, a function view accepts
`POST`, `PUT`, `PATCH` and `DELETE`. Class-based handlers and Ninja operations use their own HTTP
methods. Routes written with `re_path` have no portable OpenAPI template and are not advertised.

## Settings

| Key | Meaning |
| --- | --- |
| `PROVIDER` | `DjangoOrmPreview(using=("default",), database="label")`, an instance or dotted path. Without one, nothing is advertised and previews answer 503. |
| `IDENTITY` | `(request) -> Identity \| None` (callable or dotted path). Defaults to `request.user` when authenticated (subject = primary key). |
| `AUTHORIZE` | `(request, identity) -> bool`. Optional workbench policy (401/403). |
| `ENVIRONMENT`, `ENVIRONMENTS` | Where the workbench is on. |
| `API_NAME`, `OPENAPI_URL`, `DOCUMENTS`, `AUTH_PROVIDERS`, `FIELD_MODULES` | Discovery. `OPENAPI_URL` defaults to `/openapi.json`. |
| `INCLUDE_SQL_PARAMETER_VALUES` | Show SQL values (Development only by default). |
| `TRACE_TTL` | Seconds a trace is kept (default 300). |

Unknown keys raise `ValueError` so typos are not silently ignored.

## How it works

A request to `/sendproof/_preview/<path>` with exactly `Prefer: tx=rollback` is resolved with your
URLconf, then a copy of the request is sent through the complete `MIDDLEWARE` chain and the real
view, in-process, with `transaction.atomic()` open on every enrolled database. Every middleware,
including path-based ones, sees the target path, and session changes stay on the copy, so they are
neither saved by the outer `SessionMiddleware` nor sent as a cookie. Sendproof checks again, last
in the chain, that the request still resolves to the marked view and method. The response is buffered (1 MiB cap),
the atomic blocks are rolled back and confirmed, and only then does the middleware answer with the
envelope. `Prefer: trace` on the original URL commits normally and adds `X-Sendproof-Trace`; the
same caller can fetch it from `/sendproof/_api/traces/{id}` until it expires.

- Commit semantics follow Django: a nested `atomic()` releases a savepoint, `transaction.on_commit`
  callbacks are discarded with the rollback, and a handler that handles an `IntegrityError`
  behaves as usual.
- A 401 or 403 is always a denial and never an envelope. Other statuses, including 409 and the
  400 or 422 your framework returns for invalid input, are the application's answer. An unhandled
  exception becomes an unconfirmed 500.
- CSRF protection runs against the target view exactly as for a normal request. Sendproof
  sends no CSRF token, so previews of views protected by it are rejected unless the view is
  exempt or authenticates another way, as API views usually do.
- Mounted under a prefix (`SCRIPT_NAME`/`FORCE_SCRIPT_NAME`), discovery URLs include it. Django
  Ninja prefixes OpenAPI paths with the script prefix; serve its schema with
  `api.get_openapi_schema(path_prefix="/")` so the paths match the operations the workbench lists.

## Change capture and coverage

Changes come from `pre_save`/`post_save`/`pre_delete`/`post_delete`: inserts, updates and deletes made
with `Model.save()`, `Model.objects.create()` and `Model.delete()`, including cascades the ORM
performs. The row before an update or delete is read from the database; that read is not logged.

- **Not captured (but rolled back):** `QuerySet.update()`, `bulk_create()`, `bulk_update()`, raw SQL,
  triggers and cascades done by the database. Their SQL appears in the logs. Rows are never
  synthesized.
- **Transaction-control SQL is refused before it is sent** and the Preview answers 500: `COMMIT`,
  `ROLLBACK` (not `ROLLBACK TO SAVEPOINT`), `BEGIN`, `SET autocommit`, the internal
  `sendproof_preview` savepoint, and on MySQL, MariaDB and Oracle the statements those databases
  commit implicitly (DDL other than `TEMPORARY` tables, `LOCK TABLES`, `GRANT` and the rest of
  MySQL's list). On MySQL and MariaDB `CALL` is refused too, because a procedure can commit,
  unless you declare it safe by exact name (case-insensitive, no wildcards; the binding trusts the
  declaration):

  ```python
  SENDPROOF = {"PROVIDER": lambda: DjangoOrmPreview(safe_procedures=["refresh_totals"]), ...}
  ```

- **Backstop on MySQL and MariaDB:** the Preview opens its transaction with
  `SAVEPOINT sendproof_preview` and checks, before rolling back, that it still exists. Any commit
  erases it, so a Preview whose transaction was committed anyway answers 500 without
  confirmation (the writes before that commit stay).
- Enrolled aliases share the request thread's connection. Work in other threads, other databases
  you did not list, caches, files and other services are not rolled back.
- Synchronous views only. Async views and ASGI deployments are not tested.
- The inner response object is not closed during a preview, so Django's `request_finished`
  connection cleanup cannot end the transaction early.
