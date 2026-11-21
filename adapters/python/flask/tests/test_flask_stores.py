"""Data stores in the Flask adapter: the write guard, Preview without a SQL provider, ``preview: false``
and discovery, against the compose services (see ``core/tests/store_support.py``)."""

from __future__ import annotations

import json

import pytest
import redis
from flask import Flask, jsonify, request
from sqlalchemy import String, create_engine, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from sendproof_core.stores import PreviewWriteBlocked, dynamodb_store, mongo_store, redis_store
from sendproof_flask import Identity, Sendproof, preview
from sendproof_sqlalchemy import SQLAlchemyPreview
from store_support import DYNAMODB_URL, REDIS_URL, REGION, dynamo_client, dynamo_table, fresh, needs, new_mongo

ROLLBACK = {"Prefer": "tx=rollback"}


class Base(DeclarativeBase):
    pass


class Item(Base):
    __tablename__ = "items"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)


def build(tmp_path, *, stores=(), sql=True, setup=None):
    """A Flask app with the store routes ``setup(app)`` adds, and the given hooked stores."""
    app = Flask(__name__)
    engine = create_engine(f"sqlite:///{tmp_path / 'db.sqlite'}")
    Base.metadata.create_all(engine)
    app.config["engine"] = engine
    if setup:
        setup(app)
    Sendproof(app, provider=SQLAlchemyPreview(engine, database="db") if sql else None, data_stores=list(stores),
              environment="Development", identity=lambda req: Identity("Alex", "admin", "alex", "test"))
    return app, engine


def items(engine):
    with Session(engine) as session:
        return sorted(i.id for i in session.scalars(select(Item)))


@pytest.fixture
def cache():
    client = redis.Redis.from_url(REDIS_URL)
    prefix = fresh() + ":"
    yield client, prefix
    keys = client.keys(prefix + "*")
    if keys:
        client.delete(*keys)
    client.close()


def counter_routes(client, prefix, engine_holder=None):
    def setup(app):
        key = prefix + "counter"

        @app.get("/counters")
        @preview(methods=["GET"])
        def read():
            return jsonify(value=int(client.get(key) or 0))

        @app.post("/counters")
        @preview
        def bump():
            return jsonify(value=client.execute_command("INCR", key))

        @app.post("/counters/swallow")
        @preview
        def swallow():
            try:
                client.execute_command("INCR", key)
            except PreviewWriteBlocked:
                pass  # the handler hides the refusal
            return jsonify(ok=True)

        @app.post("/counters/raises")
        @preview
        def raises():
            client.execute_command("INCR", key)  # lets the refusal escape: Flask turns it into a 500
            return jsonify(ok=True)

        @app.delete("/counters")
        @preview(False, stores=["redis"])
        def clear():
            client.delete(key)
            return "", 204

        @app.delete("/counters/reason")
        @preview(False, reason="Clears the cache for everyone")
        def clear_with_reason():
            return "", 204

        @app.post("/mixed")
        @preview
        def mixed():
            with Session(app.config["engine"]) as session:
                session.add(Item(id="mixed", name="x"))
                session.commit()
            client.execute_command("INCR", key)
            return jsonify(ok=True), 201

        @app.post("/commit")
        @preview
        def commit():
            with Session(app.config["engine"]) as session:
                session.add(Item(id="commit", name="x"))
                session.flush()
                session.execute(text("COMMIT"))
            return jsonify(ok=True), 201

    return setup


pytestmark = needs("redis")


def test_a_pure_read_previews_and_logs_a_db_entry(tmp_path, cache):
    client, prefix = cache
    client.set(prefix + "counter", 5)
    app, _ = build(tmp_path, stores=[redis_store(client, name="cache")], setup=counter_routes(client, prefix))
    envelope = app.test_client().get("/sendproof/_preview/counters", headers=ROLLBACK).get_json()
    assert envelope["status"] == 200 and envelope["body"] == {"value": 5} and envelope["rolledBack"] is True
    (entry,) = [e["db"] for e in envelope["logs"] if e["level"] == "Db"]
    assert entry["operation"] == "GET" and entry["statement"] == f"GET {prefix}counter" and "blocked" not in entry


@pytest.mark.parametrize("path", ["/counters", "/counters/swallow", "/counters/raises"])
def test_a_blocked_preview_answers_409_whatever_the_handler_did(tmp_path, cache, path):
    client, prefix = cache
    app, _ = build(tmp_path, stores=[redis_store(client)], setup=counter_routes(client, prefix))
    response = app.test_client().post("/sendproof/_preview" + path, headers=ROLLBACK)
    assert response.status_code == 409 and response.headers["Content-Type"].startswith("application/problem+json")
    assert "Preference-Applied" not in response.headers and response.headers["Cache-Control"] == "no-store"
    assert response.get_json() == {"type": "about:blank", "title": "Preview unavailable", "status": 409, "code": "preview_unavailable",
                                   "detail": "Preview unavailable: this operation writes to Redis", "store": "redis", "operation": "INCR", "rolledBack": False}
    assert client.get(prefix + "counter") is None


def test_sql_and_a_guarded_write_roll_back_together(tmp_path, cache):
    client, prefix = cache
    app, engine = build(tmp_path, stores=[redis_store(client)], setup=counter_routes(client, prefix))
    assert app.test_client().post("/sendproof/_preview/mixed", headers=ROLLBACK).status_code == 409
    assert items(engine) == [] and client.get(prefix + "counter") is None


def test_a_handler_commit_fails_the_preview_with_500_and_nothing_persists(tmp_path, cache):
    client, prefix = cache
    app, engine = build(tmp_path, stores=[redis_store(client)], setup=counter_routes(client, prefix))
    response = app.test_client().post("/sendproof/_preview/commit", headers=ROLLBACK)
    assert response.status_code == 500 and "Preference-Applied" not in response.headers
    assert items(engine) == []


def test_preview_works_without_a_sql_provider_when_stores_are_registered(tmp_path, cache):
    client, prefix = cache
    app, _ = build(tmp_path, stores=[redis_store(client)], sql=False, setup=counter_routes(client, prefix))
    http = app.test_client()
    caps = http.get("/sendproof/_api/capabilities").get_json()
    assert {"method": "GET", "path": "/counters"} in caps["previewOperations"] and caps["database"] is None
    assert http.get("/sendproof/_preview/counters", headers=ROLLBACK).get_json()["status"] == 200
    assert http.post("/sendproof/_preview/counters", headers=ROLLBACK).status_code == 409


def test_without_stores_and_without_a_provider_previews_are_still_unavailable(tmp_path, cache):
    client, prefix = cache
    app, _ = build(tmp_path, stores=[], sql=False, setup=counter_routes(client, prefix))
    assert app.test_client().get("/sendproof/_preview/counters", headers=ROLLBACK).status_code == 503


def test_discovery_lists_stores_unavailable_operations_binding_and_database_system(tmp_path, cache):
    client, prefix = cache
    app, _ = build(tmp_path, stores=[redis_store(client, name="cache")], setup=counter_routes(client, prefix))
    caps = app.test_client().get("/sendproof/_api/capabilities").get_json()
    assert caps["dataStores"] == [{"system": "redis", "name": "cache", "mode": "guard"}]
    assert caps["binding"] == {"language": "python", "framework": "Flask"}
    assert caps["database"] == {"name": "db", "system": "sqlite"}
    assert {"method": "DELETE", "path": "/counters", "reason": "Preview unavailable: this operation writes to Redis", "stores": ["redis"]} in caps["previewUnavailable"]
    assert {"method": "DELETE", "path": "/counters/reason", "reason": "Cleared reason"} not in caps["previewUnavailable"]
    assert {"method": "DELETE", "path": "/counters/reason", "reason": "Clears the cache for everyone"} in caps["previewUnavailable"]
    assert not any(op["method"] == "DELETE" for op in caps["previewOperations"])  # not advertised as previewable


def test_a_preview_of_a_preview_false_operation_is_refused_without_running_it(tmp_path, cache):
    client, prefix = cache
    client.set(prefix + "counter", 1)
    app, _ = build(tmp_path, stores=[redis_store(client)], setup=counter_routes(client, prefix))
    response = app.test_client().delete("/sendproof/_preview/counters", headers=ROLLBACK)
    assert response.status_code == 409 and "Preference-Applied" not in response.headers
    assert client.get(prefix + "counter") == b"1"  # the handler did not run
    assert app.test_client().delete("/counters").status_code == 204  # Send still runs it
    assert client.get(prefix + "counter") is None


def test_observed_send_commits_once_and_the_trace_lists_db_entries(tmp_path, cache):
    client, prefix = cache
    app, _ = build(tmp_path, stores=[redis_store(client)], setup=counter_routes(client, prefix))
    http = app.test_client()
    response = http.post("/counters", headers={"Prefer": "trace"}, buffered=True)
    assert response.status_code == 200 and client.get(prefix + "counter") == b"1"  # committed exactly once, never blocked
    trace = http.get("/sendproof/_api/traces/" + response.headers["X-Sendproof-Trace"]).get_json()
    entries = [e["db"] for e in trace["logs"] if e["level"] == "Db"]
    assert [(e["system"], e["operation"], e["statement"]) for e in entries] == [("redis", "INCR", f"INCR {prefix}counter")]


def test_mongo_previews_roll_back_in_a_sync_flask_app(tmp_path):
    from store_support import available

    if not available("mongodb"):
        pytest.skip("mongodb is not running")
    client = new_mongo()
    name = fresh()
    store = mongo_store(client, name="catalog")
    documents = store.client[name]["documents"]

    def setup(app):
        @app.post("/documents")
        @preview
        def create():
            data = request.get_json()
            documents.insert_one({"_id": data["id"], "profile": {"city": data["city"]}, "password_hash": "hashed:" + data["password"]})
            return jsonify(id=data["id"]), 201

        @app.get("/documents/<id>")
        @preview(methods=["GET"])
        def read(id):
            found = documents.find_one({"_id": id})
            return jsonify(found) if found else ("", 404)

    app, _ = build(tmp_path, stores=[store], sql=False, setup=setup)
    http = app.test_client()
    body = {"id": "d1", "city": "York", "password": "s3cret-pw"}
    envelope = http.post("/sendproof/_preview/documents", json=body, headers=ROLLBACK).get_json()
    (change,) = envelope["changes"]
    assert (change["store"], change["operation"], change["table"], change["key"]) == ("mongodb", "insert", "documents", {"_id": "d1"})
    assert change["after"]["profile"] == {"city": "York"} and change["after"]["password_hash"] == "[REDACTED]"
    assert "s3cret-pw" not in json.dumps(envelope)
    assert http.get("/documents/d1").status_code == 404  # an ordinary read finds nothing
    assert http.get("/sendproof/_api/capabilities").get_json()["dataStores"] == [{"system": "mongodb", "name": "catalog", "mode": "preview"}]
    client.drop_database(name)
    client.close()


def test_dynamodb_writes_are_blocked_in_a_sync_flask_app(tmp_path):
    import boto3

    from store_support import available

    if not available("dynamodb"):
        pytest.skip("dynamodb is not running")
    with dynamo_table() as table:
        session = boto3.Session(region_name=REGION)
        store = dynamodb_store(session, name="orders")
        orders = session.client("dynamodb", endpoint_url=DYNAMODB_URL)

        def setup(app):
            @app.post("/orders/<id>")
            @preview
            def touch(id):
                orders.put_item(TableName=table, Item={"id": {"S": id}})
                return jsonify(id=id), 201

        app, _ = build(tmp_path, stores=[store], sql=False, setup=setup)
        response = app.test_client().post("/sendproof/_preview/orders/o1", headers=ROLLBACK)
        assert response.status_code == 409 and response.get_json()["operation"] == "PutItem"
        assert dynamo_client().get_item(TableName=table, Key={"id": {"S": "o1"}}, ConsistentRead=True).get("Item") is None
