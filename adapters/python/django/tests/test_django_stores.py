"""Data stores in the Django adapter: the write guard, Preview without a SQL provider, ``preview: false``,
``sync_to_async`` context crossing and discovery, against the compose services."""

from __future__ import annotations

import json

import pytest
import redis
from django.db import connection
from django.test import AsyncClient, Client, override_settings

from sendproof_core.stores import mongo_store, redis_store
from sendproof_django import DjangoOrmPreview, conf
from store_support import REDIS_URL, available, fresh, needs, new_mongo
import urls_stores

ROLLBACK = {"HTTP_PREFER": "tx=rollback"}


def settings_for(stores, *, sql=True):
    return override_settings(ROOT_URLCONF="urls_stores", SENDPROOF={
        "ENVIRONMENT": "Development", "PROVIDER": DjangoOrmPreview(database="tests") if sql else None,
        "DATA_STORES": list(stores), "IDENTITY": "urls_under_test.identity", "TRACE_TTL": 5,
    })


@pytest.fixture
def cache():
    client = redis.Redis.from_url(REDIS_URL)
    prefix = fresh() + ":"
    urls_stores.HOLD.update(redis=client, prefix=prefix)
    yield client, prefix
    keys = client.keys(prefix + "*")
    if keys:
        client.delete(*keys)
    client.close()
    urls_stores.HOLD.clear()


@pytest.fixture(autouse=True)
def fresh_engine():
    conf.reset()
    yield
    conf.reset()


def rows():
    with connection.cursor() as cursor:
        cursor.execute("SELECT id FROM items ORDER BY id")
        return [row[0] for row in cursor.fetchall()]


redis_only = needs("redis")


@redis_only
@pytest.mark.parametrize("path", ["bump", "swallow"])
def test_a_blocked_preview_answers_409_whatever_the_handler_did(cache, path):
    client, prefix = cache
    with settings_for([redis_store(client, name="cache")]):
        response = Client(raise_request_exception=False).post(f"/sendproof/_preview/counters/{path}", **ROLLBACK)
    assert response.status_code == 409 and response["Content-Type"].startswith("application/problem+json")
    assert "Preference-Applied" not in response and response["Cache-Control"] == "no-store"
    body = response.json()
    assert (body["code"], body["store"], body["operation"], body["rolledBack"]) == ("preview_unavailable", "redis", "INCR", False)
    assert client.get(prefix + "counter") is None


@redis_only
def test_a_read_previews_with_a_db_entry_and_sql_and_a_guarded_write_roll_back_together(cache):
    client, prefix = cache
    client.set(prefix + "counter", 4)
    with settings_for([redis_store(client)]):
        http = Client(raise_request_exception=False)
        read = http.get("/sendproof/_preview/counters", **ROLLBACK).json()
        assert read["body"] == {"value": 4} and [e["db"]["operation"] for e in read["logs"] if e["level"] == "Db"] == ["GET"]
        assert http.post("/sendproof/_preview/counters/mixed", **ROLLBACK).status_code == 409
        committed = http.post("/sendproof/_preview/counters/commit", **ROLLBACK)
        assert committed.status_code == 500 and "Preference-Applied" not in committed
    assert rows() == [] and client.get(prefix + "counter") == b"4"


@redis_only
def test_preview_works_without_a_sql_provider_when_stores_are_registered(cache):
    client, prefix = cache
    with settings_for([redis_store(client)], sql=False):
        http = Client(raise_request_exception=False)
        caps = http.get("/sendproof/_api/capabilities").json()
        assert caps["database"] is None and {"method": "GET", "path": "/counters"} in caps["previewOperations"]
        assert http.get("/sendproof/_preview/counters", **ROLLBACK).json()["status"] == 200
        assert http.post("/sendproof/_preview/counters/bump", **ROLLBACK).status_code == 409


@redis_only
def test_discovery_and_preview_false(cache):
    client, prefix = cache
    client.set(prefix + "counter", 2)
    with settings_for([redis_store(client, name="cache")]):
        http = Client(raise_request_exception=False)
        caps = http.get("/sendproof/_api/capabilities").json()
        assert caps["dataStores"] == [{"system": "redis", "name": "cache", "mode": "guard"}]
        assert caps["binding"] == {"language": "python", "framework": "Django"}
        assert caps["database"] == {"name": "tests", "system": "sqlite"}
        assert caps["previewUnavailable"] == [{"method": "DELETE", "path": "/counters/clear", "reason": "Preview unavailable: this operation writes to Redis", "stores": ["redis"]}]
        assert not any(op["method"] == "DELETE" for op in caps["previewOperations"])
        refused = http.delete("/sendproof/_preview/counters/clear", **ROLLBACK)
        assert refused.status_code == 409 and "Preference-Applied" not in refused
        assert client.get(prefix + "counter") == b"2"  # the handler did not run
        assert http.delete("/counters/clear").status_code == 200  # Send still runs it
    assert client.get(prefix + "counter") is None


@redis_only
async def test_sync_to_async_carries_the_preview_context_into_a_thread(cache):
    client, prefix = cache
    with settings_for([redis_store(client)]):
        response = await AsyncClient(raise_request_exception=False).post("/sendproof/_preview/counters/async", headers={"Prefer": "tx=rollback"})
    assert response.status_code == 409 and response.json()["operation"] == "INCR"
    assert client.get(prefix + "counter") is None


@needs("mongodb")
def test_mongo_previews_roll_back_in_a_django_view():
    name = fresh()
    mongo = new_mongo()
    store = mongo_store(mongo, name="catalog")
    urls_stores.HOLD.update(documents=store.client[name]["documents"])
    try:
        with settings_for([store], sql=False):
            http = Client(raise_request_exception=False)
            envelope = http.post("/sendproof/_preview/documents", json.dumps({"id": "d1", "city": "York"}),
                                 content_type="application/json", **ROLLBACK).json()
            (change,) = envelope["changes"]
            assert (change["store"], change["operation"], change["key"]) == ("mongodb", "insert", {"_id": "d1"})
            assert change["after"]["password_hash"] == "[REDACTED]" and change["after"]["profile"] == {"city": "York"}
            assert http.get("/sendproof/_api/capabilities").json()["dataStores"] == [{"system": "mongodb", "name": "catalog", "mode": "preview"}]
        assert mongo[name]["documents"].find_one({"_id": "d1"}) is None
    finally:
        mongo.drop_database(name)
        mongo.close()
        urls_stores.HOLD.clear()
