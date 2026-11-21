"""Conformance fixture: a disposable Django + Django Ninja app for the shared protocol runner.

Environment variables (set by the runner): ``PORT``, ``BENCH_PATH_BASE`` (empty or ``/tenant``)
and ``BENCH_SCENARIO`` (``standard``, ``disabled``, ``no-provider`` or ``rollback-failure``).
Each process starts with an empty ``items`` table in a temporary SQLite file. Django Ninja
supplies the OpenAPI document; the data layer is the Django ORM.
"""

from __future__ import annotations

import logging
import os
import secrets
import shutil
import sys
import tempfile
from pathlib import Path

import django
from django.conf import settings

PORT = int(os.environ.get("PORT", "8000"))
BASE = os.environ.get("BENCH_PATH_BASE", "").rstrip("/")
SCENARIO = os.environ.get("BENCH_SCENARIO", "standard")
TRACE_TTL_SECONDS = 5.0
_directory = Path(tempfile.mkdtemp(prefix="sendproof-fixture-"))

log = logging.getLogger("fixture")
log.setLevel(logging.INFO)


def _fail_rollback_provider():
    from sendproof_django import DjangoOrmPreview

    class RollbackFailing(DjangoOrmPreview):
        """Rolls back for real, then reports an injected failure so the transport withholds confirmation."""

        def begin(self, scope):
            from sendproof_core import PreviewRollbackError

            inner = super().begin(scope)

            class Failing(type(inner)):
                def rollback(self):
                    super().rollback()
                    raise PreviewRollbackError("Injected rollback failure.")

            inner.__class__ = Failing
            return inner

    return RollbackFailing(database="fixture")


def configure() -> None:
    from sendproof_django import DjangoOrmPreview

    provider = None
    if SCENARIO == "rollback-failure":
        provider = _fail_rollback_provider()
    elif SCENARIO != "no-provider":
        provider = DjangoOrmPreview(database="fixture")
    settings.configure(
        DEBUG=False,
        SECRET_KEY="fixture",
        ALLOWED_HOSTS=["*"],
        ROOT_URLCONF=__name__,
        INSTALLED_APPS=["django.contrib.contenttypes"],
        MIDDLEWARE=["sendproof_django.middleware.SendproofMiddleware"],
        DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": str(_directory / "items.db")}},
        DEFAULT_AUTO_FIELD="django.db.models.BigAutoField",
        USE_TZ=True,
        LOGGING_CONFIG=None,
        SENDPROOF={
            "ENVIRONMENT": "Production" if SCENARIO == "disabled" else "Development",
            "PROVIDER": provider,
            "IDENTITY": f"{__name__}.identity",
            "AUTH_PROVIDERS": [
                {"label": "Fixture password", "kind": "cookie", "url": "/auth/sign-in"},
                {"label": "Fixture personas", "kind": "personas", "url": "/auth/personas"},
            ],
            "OPENAPI_URL": "/openapi.json",
            "TRACE_TTL": TRACE_TTL_SECONDS,
        },
    )
    django.setup()


# This script is its own URLconf (ROOT_URLCONF is its module name), so configure first.
configure()

import json  # noqa: E402

from django.db import connection, models, transaction  # noqa: E402
from django.http import HttpResponse, JsonResponse  # noqa: E402
from django.urls import path  # noqa: E402
from ninja import NinjaAPI, Schema  # noqa: E402
from ninja.errors import HttpError  # noqa: E402
from pydantic import Field  # noqa: E402

from sendproof_core import Identity, record_effect, record_email  # noqa: E402
from sendproof_django import preview  # noqa: E402


class Item(models.Model):
    id = models.CharField(primary_key=True, max_length=200)
    name = models.CharField(max_length=200)

    class Meta:
        app_label = "fixture"
        db_table = "items"


with connection.schema_editor() as editor:
    editor.create_model(Item)

USERS = {
    "admin@example.test": {"name": "Fixture Admin", "role": "admin", "password": "bench-fixture"},
    "viewer@example.test": {"name": "Fixture Viewer", "role": "viewer", "password": "bench-fixture"},
}
SESSIONS: dict[str, str] = {}
COOKIE = "fixture_session"
OUTBOX: list[dict] = []


def user_of(request) -> dict | None:
    email = SESSIONS.get(request.COOKIES.get(COOKIE, ""))
    return None if email is None else {"email": email, **USERS[email]}


def identity(request) -> Identity | None:
    user = user_of(request)
    return None if user is None else Identity(user["name"], user["role"], user["email"], "cookie")


def require_user(request) -> dict:
    user = user_of(request)
    if user is None:
        raise HttpError(401, "Sign in first.")
    return user


def require_admin(request) -> dict:
    user = require_user(request)
    if user["role"] != "admin":
        raise HttpError(403, "Only admins can write.")
    return user


def start_session(email: str) -> HttpResponse:
    token = secrets.token_urlsafe(24)
    SESSIONS[token] = email
    response = JsonResponse({"email": email, "name": USERS[email]["name"], "role": USERS[email]["role"]})
    response.set_cookie(COOKIE, token, httponly=True, samesite="Lax", path="/")
    return response


def sign_in(request):
    data = json.loads(request.body or b"{}")
    user = USERS.get(str(data.get("email")))
    if user is None or not secrets.compare_digest(user["password"], str(data.get("password"))):
        return JsonResponse({"detail": "Incorrect email or password."}, status=401)
    return start_session(data["email"])


def personas(request):
    user = user_of(request)
    if user is None:
        return JsonResponse({"detail": "Sign in first."}, status=401)
    if user["role"] != "admin":
        return JsonResponse({"detail": "Forbidden."}, status=403)
    return JsonResponse([{"email": e, "name": u["name"], "role": u["role"]} for e, u in USERS.items()], safe=False)


def switch_persona(request, email: str):
    user = user_of(request)
    if user is None:
        return JsonResponse({"detail": "Sign in first."}, status=401)
    if user["role"] != "admin":
        return JsonResponse({"detail": "Forbidden."}, status=403)
    if email not in USERS:
        return JsonResponse({"detail": "Unknown persona."}, status=404)
    return start_session(email)


api = NinjaAPI(title="Sendproof Conformance", openapi_url=None, docs_url=None)


class ItemIn(Schema):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)


class ItemPatch(Schema):
    name: str = Field(min_length=1)


class ItemOut(Schema):
    id: str
    name: str


@api.get("/items/{id}", response=ItemOut)
def read_item(request, id: str):
    require_user(request)
    item = Item.objects.filter(pk=id).first()
    if item is None:
        raise HttpError(404, "Item not found.")
    return item


@api.post("/items", response={201: ItemOut})
@preview
def create_item(request, payload: ItemIn):
    require_admin(request)
    if Item.objects.filter(pk=payload.id).exists():
        raise HttpError(409, "Item already exists.")
    item = Item.objects.create(id=payload.id, name=payload.name)
    item.refresh_from_db()
    with connection.cursor() as cursor:
        cursor.execute("SELECT %(fixture_secret)s", {"fixture_secret": "fixture-secret-value"})
    log.info("created:%s", payload.id)
    if not record_email("Created item", "noreply@example.test", ["ops@example.test"], [], "Item created", item.name):
        OUTBOX.append({"subject": "Item created", "id": payload.id})
    return 201, item


@api.patch("/items/{id}", response=ItemOut)
@preview
def rename_item(request, id: str, payload: ItemPatch, tag: str | None = None):
    require_admin(request)
    item = Item.objects.filter(pk=id).first()
    if item is None:
        raise HttpError(404, "Item not found.")
    item.name = payload.name
    item.save()
    response = HttpResponse(json.dumps({"id": item.id, "name": item.name}), content_type="application/json")
    if tag is not None:
        response["X-Fixture-Tag"] = tag
    return response


@api.delete("/items/{id}", response={204: None})
@preview
def delete_item(request, id: str):
    require_admin(request)
    item = Item.objects.filter(pk=id).first()
    if item is None:
        raise HttpError(404, "Item not found.")
    item.delete()
    return 204, None


@api.post("/items/{id}/fail")
@preview
def fail_item(request, id: str):
    require_admin(request)
    Item.objects.create(id=id, name="Failing")
    raise HttpError(409, "The operation failed after writing.")


@api.post("/items/{id}/large")
@preview
def large_item(request, id: str):
    require_admin(request)
    Item.objects.create(id=id, name="Large")
    return {"id": id, "padding": "x" * (1024 * 1024 + 512)}


@api.post("/items/{id}/redirect")
@preview
def redirect_item(request, id: str):
    require_admin(request)
    Item.objects.create(id=id, name="Redirected")
    response = HttpResponse(status=302)
    response["Location"] = f"{BASE}/items/{id}"
    response.set_cookie("inner", "secret")
    return response


@api.post("/items/{id}/capture")
@preview
def capture_items(request, id: str):
    require_admin(request)
    for n in range(201):
        Item.objects.create(id=f"{id}-{n}", name=f"Captured {n}")
    for n in range(101):
        record_effect("message", f"Published {n}", {"topic": "items", "payload": {"n": n}})
    for n in range(501):
        log.info("capture:%s", n)
    return {"created": 201}


@api.post("/items/{id}/ordinary", response={201: ItemOut})
def ordinary_item(request, id: str):
    require_admin(request)
    return 201, Item.objects.create(id=id, name="Ordinary")


def openapi(request):
    # Paths are relative to the mount: the workbench adds the path base itself.
    return JsonResponse(api.get_openapi_schema(path_prefix="/"))


def ready(request):
    return JsonResponse({"status": "ready"})


urlpatterns = [
    path("ready", ready),
    path("openapi.json", openapi),
    path("auth/sign-in", sign_in),
    path("auth/personas", personas),
    path("auth/personas/<str:email>", switch_persona),
    path("", api.urls),
]

if __name__ == "__main__":
    from django.core.servers.basehttp import run
    from django.core.wsgi import get_wsgi_application
    from werkzeug.middleware.dispatcher import DispatcherMiddleware

    handler = get_wsgi_application()
    if BASE:
        def not_found(environ, start_response):
            if environ["PATH_INFO"] == "/ready":
                start_response("200 OK", [("Content-Type", "application/json")])
                return [b'{"status":"ready"}']
            start_response("404 Not Found", [("Content-Type", "text/plain")])
            return [b"Not found"]

        handler = DispatcherMiddleware(not_found, {BASE: handler})
    try:
        run("127.0.0.1", PORT, handler, threading=True)
    finally:
        shutil.rmtree(_directory, ignore_errors=True)
