"""Conformance fixture: a disposable Flask + SQLAlchemy app for the shared protocol runner.

Environment variables (set by the runner): ``PORT``, ``BENCH_PATH_BASE`` (empty or ``/tenant``)
and ``BENCH_SCENARIO`` (``standard``, ``disabled``, ``no-provider`` or ``rollback-failure``).
``BENCH_DATABASE`` (``sqlite`` by default, ``postgresql`` or ``mysql``) and ``BENCH_DATABASE_URL``
choose the database, and ``BENCH_FLASK_ORM`` (``sqlalchemy`` or ``flask-sqlalchemy``) the persistence
layer; see ``fixture_database.py`` and ``fixture_flask_persistence.py``. Each process starts with an
empty ``items`` table, in a temporary SQLite file unless a disposable database URL is supplied.
"""

from __future__ import annotations

import logging
import os
import secrets
import shutil
import tempfile
from pathlib import Path
from time import sleep

from flask import Flask, Response, abort, jsonify, request
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from werkzeug.middleware.dispatcher import DispatcherMiddleware
from werkzeug.serving import make_server

from sendproof_core import PreviewRollbackError, PreviewSession, RequestScope, record_effect, record_email
from sendproof_flask import AuthProvider, Identity, Sendproof, preview
from sendproof_sqlalchemy import SQLAlchemyPreview

import fixture_database
import fixture_flask_persistence
from fixture_stores import REMEMBERABLE, SyncStores

PORT = int(os.environ.get("PORT", "8000"))
BASE = os.environ.get("BENCH_PATH_BASE", "").rstrip("/")
SCENARIO = os.environ.get("BENCH_SCENARIO", "standard")
TRACE_TTL_SECONDS = 5.0

log = logging.getLogger("fixture")
log.setLevel(logging.INFO)

_directory = Path(tempfile.mkdtemp(prefix="sendproof-fixture-"))
_url, _kind = fixture_database.resolve(_directory)
persistence = fixture_flask_persistence.create(_url)
Item = persistence.Item
Account = persistence.Account

USERS = {
    "admin@example.test": {"name": "Fixture Admin", "role": "admin", "password": "bench-fixture"},
    "viewer@example.test": {"name": "Fixture Viewer", "role": "viewer", "password": "bench-fixture"},
}
SESSIONS: dict[str, str] = {}
COOKIE = "fixture_session"
OUTBOX: list[dict] = []

app = Flask(__name__)
app.json.sort_keys = False
persistence.init_app(app)
engine = persistence.engine
db = persistence.session


def user_of(req) -> dict | None:
    email = SESSIONS.get(req.cookies.get(COOKIE, ""))
    return None if email is None else {"email": email, **USERS[email]}


def identity(req) -> Identity | None:
    user = user_of(req)
    return None if user is None else Identity(user["name"], user["role"], user["email"], "cookie")


def require_user() -> dict:
    user = user_of(request)
    if user is None:
        abort(401)
    return user


def require_admin() -> dict:
    user = require_user()
    if user["role"] != "admin":
        abort(403)
    return user


def start_session(email: str) -> Response:
    token = secrets.token_urlsafe(24)
    SESSIONS[token] = email
    response = jsonify(email=email, name=USERS[email]["name"], role=USERS[email]["role"])
    response.set_cookie(COOKIE, token, httponly=True, samesite="Lax", path="/")
    return response


def body_of(item: Item) -> dict:
    return {"id": item.id, "name": item.name}


def json_body(*fields: str) -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or any(not isinstance(data.get(f), str) or not data[f] for f in fields):
        abort(Response(jsonify(detail="Invalid request body.").get_data(), 422, mimetype="application/json"))
    return data


@app.get("/ready")
def ready():
    return jsonify(status="ready")


@app.post("/auth/sign-in")
def sign_in():
    data = request.get_json(silent=True) or {}
    user = USERS.get(str(data.get("email")))
    if user is None or not secrets.compare_digest(user["password"], str(data.get("password"))):
        abort(401)
    return start_session(data["email"])


@app.get("/auth/personas")
def personas():
    require_admin()
    return jsonify([{"email": e, "name": u["name"], "role": u["role"]} for e, u in USERS.items()])


@app.post("/auth/personas/<email>")
def switch_persona(email: str):
    require_admin()
    if email not in USERS:
        abort(404)
    return start_session(email)


@app.get("/items/<id>")
def read_item(id: str):
    require_user()
    if request.args.get("hold") == "true":
        sleep(1)
    item = db().get(Item, id)
    if item is None:
        abort(404)
    return jsonify(body_of(item))


@app.post("/items")
@preview
def create_item():
    require_admin()
    data = json_body("id", "name")
    session = db()
    entity = Item(id=data["id"], name=data["name"])
    session.add(entity)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        abort(409)
    session.refresh(entity)
    session.execute(text("SELECT :fixture_secret"), {"fixture_secret": "fixture-secret-value"})
    log.info("created:%s", data["id"])
    if not record_email("Created item", "noreply@example.test", ["ops@example.test"], [], "Item created", entity.name):
        OUTBOX.append({"subject": "Item created", "id": data["id"]})
    return jsonify(body_of(entity)), 201


@app.patch("/items/<id>")
@preview
def rename_item(id: str):
    require_admin()
    data = json_body("name")
    entity = db().get(Item, id)
    if entity is None:
        abort(404)
    entity.name = data["name"]
    db().commit()
    response = jsonify(body_of(entity))
    if (tag := request.args.get("tag")) is not None:
        response.headers["X-Fixture-Tag"] = tag
    return response


@app.delete("/items/<id>")
@preview
def delete_item(id: str):
    require_admin()
    entity = db().get(Item, id)
    if entity is None:
        abort(404)
    db().delete(entity)
    db().commit()
    return Response(status=204)


@app.post("/items/<id>/fail")
@preview
def fail_item(id: str):
    require_admin()
    db().add(Item(id=id, name="Failing"))
    db().flush()
    abort(409)


@app.post("/items/<id>/large")
@preview
def large_item(id: str):
    require_admin()
    db().add(Item(id=id, name="Large"))
    db().commit()
    return jsonify(id=id, padding="x" * (1024 * 1024 + 512))


@app.post("/items/<id>/redirect")
@preview
def redirect_item(id: str):
    require_admin()
    db().add(Item(id=id, name="Redirected"))
    db().commit()
    return Response(status=302, headers={"Location": f"{BASE}/items/{id}", "Set-Cookie": "inner=secret; Path=/"})


@app.post("/items/<id>/capture")
@preview
def capture_items(id: str):
    require_admin()
    db().add_all(Item(id=f"{id}-{n}", name=f"Captured {n}") for n in range(201))
    db().commit()
    for n in range(101):
        record_effect("message", f"Published {n}", {"topic": "items", "payload": {"n": n}})
    for n in range(501):
        log.info("capture:%s", n)
    return jsonify(created=201)


@app.post("/items/<id>/ordinary")
def ordinary_item(id: str):
    require_admin()
    db().add(Item(id=id, name="Ordinary"))
    db().commit()
    return jsonify(id=id, name="Ordinary"), 201


# ------------------------------------------------------------------ shared security rules
@app.post("/accounts")
@preview
def create_account():
    require_admin()
    data = json_body("id", "email", "password")
    db().add(Account(id=data["id"], email=data["email"], password_hash="hashed:" + data["password"]))
    db().commit()
    return jsonify(id=data["id"], email=data["email"]), 201


@app.get("/accounts/<id>")
def read_account(id: str):
    require_user()
    account = db().get(Account, id)
    if account is None:
        abort(404)
    return jsonify(id=account.id, email=account.email)


@app.post("/items/<id>/commit")
@preview
def commit_item(id: str):
    require_admin()
    data = json_body("name")
    db().add(Item(id=id, name=data["name"]))
    db().flush()
    db().execute(text("COMMIT"))  # a handler that ends the transaction itself: a Preview must refuse it
    return jsonify(id=id, name=data["name"]), 201


# ------------------------------------------------------------------------- mysql-escape
# spec/conformance/fixture.md, "MySQL and MariaDB: mysql-escape": statements that commit the Preview
# transaction without saying COMMIT. The fixture declares no procedure safe.
if _kind == "mysql":
    with engine.begin() as _connection:
        if not _connection.scalar(text(
                "SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = DATABASE() "
                "AND routine_name = 'sendproof_commit_probe'")):
            _connection.execute(text("CREATE PROCEDURE sendproof_commit_probe() BEGIN COMMIT; END"))

    @app.post("/items/<id>/escape")
    @preview
    def escape_item(id: str):
        require_admin()
        data = json_body("name", "via")
        via = data["via"]
        if via not in ("ddl", "call") or not id.replace("_", "").isalnum():
            abort(400)  # the id becomes part of a table name below
        db().add(Item(id=id, name=data["name"]))
        db().flush()
        if via == "ddl":
            db().execute(text(f"CREATE TABLE sendproof_escape_{id} (n INT)"))  # commits implicitly
        else:
            db().execute(text("CALL sendproof_commit_probe()"))  # the procedure runs COMMIT
        db().commit()
        return jsonify(id=id, name=data["name"]), 201


# ------------------------------------------------------------------------- data stores
# Present only when the runner passes a store's variables. Flask uses the synchronous clients
# (PyMongo, redis-py, boto3, cassandra-driver, opensearch-py); the FastAPI fixture uses the asynchronous ones.
stores = SyncStores()


def reply(result: tuple[int, object]):
    status, body = result
    return Response(status=status) if body is None else (jsonify(body), status)


if "mongodb" in stores.stores:
    @app.get("/documents/<id>")
    @preview(methods=["GET"])
    def read_document(id: str):
        require_user()
        return reply(stores.get_document(id))

    @app.post("/documents")
    @preview
    def create_document():
        require_admin()
        return reply(stores.create_document(json_body("id", "name", "city", "password")))

    @app.patch("/documents/<id>")
    @preview
    def patch_document(id: str):
        require_admin()
        return reply(stores.patch_document(id, request.get_json(silent=True) or {}))

    @app.post("/documents/archive")
    @preview
    def archive_documents():
        require_admin()
        return reply(stores.archive_documents())

    @app.delete("/documents/<id>")
    @preview(False, stores=["mongodb"])
    def delete_document(id: str):
        require_admin()
        return reply(stores.delete_document(id))

if "redis" in stores.stores:
    @app.get("/counters/<key>")
    @preview(methods=["GET"])
    def read_counter(key: str):
        require_user()
        return reply(stores.get_counter(key))

    @app.post("/counters/<key>")
    @preview
    def increment_counter(key: str):
        require_admin()
        return reply(stores.incr_counter(key))

    @app.post("/counters/<key>/take")
    @preview
    def take_counter(key: str):
        require_admin()
        return reply(stores.take_counter(key))

    @app.delete("/counters/<key>")
    @preview(False, stores=["redis"])
    def delete_counter(key: str):
        require_admin()
        return reply(stores.delete_counter(key))

if "dynamodb" in stores.stores:
    @app.get("/orders/<id>")
    @preview(methods=["GET"])
    def read_order(id: str):
        require_user()
        return reply(stores.get_order(id))

    @app.post("/orders/<id>/touch")
    @preview
    def touch_order(id: str):
        require_admin()
        return reply(stores.touch_order(id))

    @app.post("/orders/<id>/cancel")
    @preview
    def cancel_order(id: str):
        require_admin()
        return reply(stores.cancel_order(id))

    @app.delete("/orders/<id>")
    @preview(False, stores=["dynamodb"])
    def delete_order(id: str):
        require_admin()
        return reply(stores.delete_order(id))

if "cassandra" in stores.stores:
    @app.get("/tickets/<id>")
    @preview(methods=["GET"])
    def read_ticket(id: str):
        require_user()
        return reply(stores.get_ticket(id))

    @app.post("/tickets/<id>/touch")
    @preview
    def touch_ticket(id: str):
        require_admin()
        return reply(stores.touch_ticket(id))

    @app.post("/tickets/<id>/close")
    @preview
    def close_ticket(id: str):
        require_admin()
        return reply(stores.close_ticket(id))

    @app.delete("/tickets/<id>")
    @preview(False, stores=["cassandra"])
    def delete_ticket(id: str):
        require_admin()
        return reply(stores.delete_ticket(id))

if "opensearch" in stores.stores:
    @app.get("/articles/<id>")
    @preview(methods=["GET"])
    def read_article(id: str):
        require_user()
        return reply(stores.get_article(id))

    @app.post("/articles/<id>/touch")
    @preview
    def touch_article(id: str):
        require_admin()
        return reply(stores.touch_article(id))

    @app.post("/articles/<id>/hide")
    @preview
    def hide_article(id: str):
        require_admin()
        return reply(stores.hide_article(id))

    @app.delete("/articles/<id>")
    @preview(False, stores=["opensearch"])
    def delete_article(id: str):
        require_admin()
        return reply(stores.delete_article(id))

if set(REMEMBERABLE) & set(stores.stores):
    @app.post("/items/<id>/remember")
    @preview
    def remember_item(id: str):
        require_admin()
        data = json_body("name")
        store = request.args.get("store", "")
        if store not in REMEMBERABLE or store not in stores.stores:
            abort(400)
        db().add(Item(id=id, name=data["name"]))
        db().commit()
        stores.remember(store, id)
        return jsonify(id=id, name=data["name"]), 201


_ITEM = {"type": "object", "required": ["id", "name"], "properties": {"id": {"type": "string"}, "name": {"type": "string"}}}
_ID = [{"name": "id", "in": "path", "required": True, "schema": {"type": "string"}}]


def _operation(summary: str, status: str, body: bool = False, schema: dict | None = None) -> dict:
    operation: dict = {"summary": summary, "parameters": _ID, "responses": {status: {"description": summary}}}
    if schema:
        operation["responses"][status]["content"] = {"application/json": {"schema": schema}}
    if body:
        operation["requestBody"] = {"required": True, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Item"}}}}
    return operation


def _store_paths() -> dict:
    """OpenAPI paths of the data-store routes the runner enabled."""
    paths: dict = {}
    if "mongodb" in stores.stores:
        paths.update({
            "/documents": {"post": {"summary": "Create document", "responses": {"201": {"description": "Created"}}}},
            "/documents/archive": {"post": {"summary": "Archive documents", "responses": {"204": {"description": "Archived"}}}},
            "/documents/{id}": {"get": _operation("Read document", "200"), "patch": _operation("Update document", "200"),
                                "delete": _operation("Delete document", "204")},
        })
    if "redis" in stores.stores:
        key = [{"name": "key", "in": "path", "required": True, "schema": {"type": "string"}}]
        paths.update({
            "/counters/{key}": {"get": {"summary": "Read counter", "parameters": key, "responses": {"200": {"description": "Counter"}}},
                                "post": {"summary": "Increment counter", "parameters": key, "responses": {"200": {"description": "Counter"}}},
                                "delete": {"summary": "Delete counter", "parameters": key, "responses": {"204": {"description": "Deleted"}}}},
            "/counters/{key}/take": {"post": {"summary": "Take counter", "parameters": key, "responses": {"200": {"description": "Counter"}}}},
        })
    if "dynamodb" in stores.stores:
        paths.update({
            "/orders/{id}": {"get": _operation("Read order", "200"), "delete": _operation("Delete order", "204")},
            "/orders/{id}/touch": {"post": _operation("Touch order", "200")},
            "/orders/{id}/cancel": {"post": _operation("Cancel order", "200")},
        })
    if "cassandra" in stores.stores:
        paths.update({
            "/tickets/{id}": {"get": _operation("Read ticket", "200"), "delete": _operation("Delete ticket", "204")},
            "/tickets/{id}/touch": {"post": _operation("Touch ticket", "200")},
            "/tickets/{id}/close": {"post": _operation("Close ticket", "200")},
        })
    if "opensearch" in stores.stores:
        paths.update({
            "/articles/{id}": {"get": _operation("Read article", "200"), "delete": _operation("Delete article", "204")},
            "/articles/{id}/touch": {"post": _operation("Touch article", "200")},
            "/articles/{id}/hide": {"post": _operation("Hide article", "200")},
        })
    if set(REMEMBERABLE) & set(stores.stores):
        paths["/items/{id}/remember"] = {"post": _operation("Write the item, then a store", "201", True)}
    if _kind == "mysql":
        paths["/items/{id}/escape"] = {"post": _operation("Commit implicitly inside the handler", "201", True)}
    return paths


@app.get("/openapi.json")
def openapi():
    item = {"$ref": "#/components/schemas/Item"}
    action = lambda name: _operation(name, "200")  # noqa: E731
    return jsonify({
        "openapi": "3.0.3",
        "info": {"title": "Sendproof Conformance", "version": "1.0"},
        "paths": {
            "/items": {"post": {**_operation("Create item", "201", True, item), "parameters": []}},
            "/items/{id}": {
                "get": _operation("Read item", "200", schema=item),
                "patch": {**_operation("Rename item", "200", schema=item), "requestBody": {"required": True, "content": {
                    "application/json": {"schema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}}}}}}},
                "delete": _operation("Delete item", "204"),
            },
            "/items/{id}/fail": {"post": action("Fail after writing")},
            "/items/{id}/large": {"post": action("Return a large body")},
            "/items/{id}/redirect": {"post": action("Redirect")},
            "/items/{id}/capture": {"post": action("Exceed capture limits")},
            "/items/{id}/ordinary": {"post": action("Insert without Preview")},
            "/items/{id}/commit": {"post": _operation("Commit inside the handler", "201", True, item)},
            "/accounts": {"post": {"summary": "Create account", "responses": {"201": {"description": "Created"}}, "requestBody": {
                "required": True, "content": {"application/json": {"schema": {"type": "object", "properties": {
                    "id": {"type": "string"}, "email": {"type": "string"}, "password": {"type": "string"}}}}}}}},
            "/accounts/{id}": {"get": action("Read account")},
            **_store_paths(),
        },
        "components": {"schemas": {"Item": _ITEM}},
    })


class RollbackFailingProvider(SQLAlchemyPreview):
    """Rolls back for real, then reports an injected failure so the transport withholds confirmation."""

    def begin(self, scope: RequestScope) -> PreviewSession:
        inner = super().begin(scope)

        class Failing(type(inner)):  # type: ignore[misc]
            def rollback(self) -> None:
                super().rollback()
                raise PreviewRollbackError("Injected rollback failure.")

        inner.__class__ = Failing
        return inner


provider = None
if SCENARIO == "rollback-failure":
    provider = RollbackFailingProvider(engine, database=f"fixture-{_kind}")
elif SCENARIO != "no-provider":
    provider = SQLAlchemyPreview(engine, database=f"fixture-{_kind}")

Sendproof(
    app,
    provider=provider,
    data_stores=stores.data_stores,
    identity=identity,
    environment="Production" if SCENARIO == "disabled" else "Development",
    auth_providers=[
        AuthProvider("Fixture password", "cookie", "/auth/sign-in"),
        AuthProvider("Fixture personas", "personas", "/auth/personas"),
    ],
    trace_ttl=TRACE_TTL_SECONDS,
    journey_files=[fixture_database.JOURNEY_FILE],
)

# Mount under the path base (WSGI SCRIPT_NAME) so that the workbench is absent without the prefix.
root = app.wsgi_app
if BASE:
    def not_found(environ, start_response):
        if environ["PATH_INFO"] == "/ready":
            start_response("200 OK", [("Content-Type", "application/json")])
            return [b'{"status":"ready"}']
        start_response("404 Not Found", [("Content-Type", "text/plain")])
        return [b"Not found"]

    root = DispatcherMiddleware(not_found, {BASE: app.wsgi_app})
else:
    root = app.wsgi_app

if __name__ == "__main__":
    server = make_server("127.0.0.1", PORT, root, threaded=True)
    try:
        server.serve_forever()
    finally:
        shutil.rmtree(_directory, ignore_errors=True)
