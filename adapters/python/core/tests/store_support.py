"""Helpers shared by the data-store tests of every Python package.

The store tests talk to the compose services of ``tests/conformance/compose.yml`` and are skipped,
with the command that starts them, when a service does not answer a *protocol request*: Docker
accepts and drops connections while a container starts, so an open port is not enough.

Each test gets its own MongoDB database, Redis key prefix and DynamoDB table, so tests never share
data and the services stay shared with the conformance runner.
"""

from __future__ import annotations

import functools
import os
import urllib.request
import uuid
from contextlib import contextmanager
from typing import Iterator

import pytest

from sendproof_core.capture import Capture
from sendproof_core.scope import RequestScope, activate, deactivate

REDIS_URL = os.environ.get("BENCH_REDIS_SERVER_URL", "redis://:bench_redis_local@127.0.0.1:56379")
MONGODB_URL = os.environ.get("BENCH_MONGODB_SERVER_URL", "mongodb://127.0.0.1:57017/?directConnection=true")
DYNAMODB_URL = os.environ.get("BENCH_DYNAMODB_SERVER_URL", "http://127.0.0.1:58000")
#: Batch two's heavy stores come from the compose ``heavy-stores`` profile.
CASSANDRA_SERVER = os.environ.get("BENCH_CASSANDRA_SERVER", "127.0.0.1:59042")
OPENSEARCH_URL = os.environ.get("BENCH_OPENSEARCH_SERVER_URL", "http://127.0.0.1:59200")

# DynamoDB Local accepts any well-formed credentials; the secret is a marker that must never reach a capture.
os.environ.setdefault("AWS_ACCESS_KEY_ID", "benchlocal")
os.environ["AWS_SECRET_ACCESS_KEY"] = os.environ.get("AWS_SECRET_ACCESS_KEY", "benchDynamoSecret" + uuid.uuid4().hex[:8])
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
REGION = os.environ["AWS_DEFAULT_REGION"]
START = "docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb"
START_HEAVY = "docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra opensearch"


@functools.lru_cache(maxsize=None)
def available(store: str) -> bool:
    """Whether the compose service answers a real request."""
    try:
        if store == "redis":
            import redis

            return bool(redis.Redis.from_url(REDIS_URL, socket_connect_timeout=1.5, socket_timeout=1.5).ping())
        if store == "mongodb":
            from pymongo import MongoClient

            MongoClient(MONGODB_URL, serverSelectionTimeoutMS=1500).admin.command("ping")
            return True
        if store == "dynamodb":
            try:
                urllib.request.urlopen(DYNAMODB_URL, timeout=1.5)
            except urllib.error.HTTPError:  # any HTTP answer means the service is up
                pass
            return True
        if store == "cassandra":
            from cassandra.cluster import Cluster

            host, _, port = CASSANDRA_SERVER.partition(":")
            cluster = Cluster([host], port=int(port or 9042), connect_timeout=3)
            try:
                cluster.connect().execute("SELECT release_version FROM system.local")
            finally:
                cluster.shutdown()
            return True
        if store == "opensearch":
            urllib.request.urlopen(OPENSEARCH_URL + "/_cluster/health?wait_for_status=yellow&timeout=2s", timeout=4)
            return True
    except Exception:
        return False
    raise ValueError(store)


def needs(store: str):
    """A pytest mark that skips a test when the compose service for ``store`` is down."""
    start = START_HEAVY if store in ("cassandra", "opensearch") else START
    return pytest.mark.skipif(not available(store), reason=f"{store} is not running: {start}")


def fresh() -> str:
    return "tb_" + uuid.uuid4().hex[:12]


def preview_scope() -> RequestScope:
    """A scope like the one a Preview activates for its handler."""
    return RequestScope(Capture(rollback=True), "Development", True)


def observed_scope() -> RequestScope:
    """A scope like the one an observed Send activates."""
    return RequestScope(Capture(rollback=False), "Development", True)


@contextmanager
def active(scope: RequestScope) -> Iterator[RequestScope]:
    """Make ``scope`` current for the ``with`` body."""
    token = activate(scope)
    try:
        yield scope
    finally:
        deactivate(token)


def db_entries(scope: RequestScope, system: str, operation: str | None = None) -> list[dict]:
    """The ``Db`` log entries a scope has recorded, without finishing its capture."""
    logs = list(scope.capture._logs)
    return [e for e in logs if e["level"] == "Db" and e["db"]["system"] == system
            and (operation is None or e["db"]["operation"].upper() == operation.upper())]


def dynamo_client():
    """A plain boto3 DynamoDB client for the local service, with its own session (never hooked)."""
    import boto3

    return boto3.Session(region_name=REGION).client("dynamodb", endpoint_url=DYNAMODB_URL)


@contextmanager
def dynamo_table() -> Iterator[str]:
    """A fresh table with string partition key ``id``, deleted afterwards."""
    client = dynamo_client()
    table = fresh()
    client.create_table(
        TableName=table, BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
        KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
    )
    try:
        yield table
    finally:
        client.delete_table(TableName=table)


def new_mongo(**options):
    """A PyMongo client for the local replica set. Create it after importing the Mongo hook."""
    from pymongo import MongoClient

    return MongoClient(MONGODB_URL, serverSelectionTimeoutMS=3000, **options)


# ------------------------------------------------------------------ driving the Preview pipeline
def sync_bench(*stores):
    """The synchronous Preview engine (Flask and Django use it) over the given stores, with no SQL provider."""
    import json  # noqa: F401  (kept local: only these helpers need it)

    from sendproof_core import BenchOptions
    from sendproof_core.stores import StoresOnlyProvider
    from sendproof_core.sync_engine import SyncBench
    from sendproof_core.workbench import Workbench

    options = BenchOptions(environment="Development", framework="Test")
    provider = StoresOnlyProvider()
    return SyncBench(options, provider, Workbench(options, provider), None, stores)


def run_preview(engine, handler):
    """Run ``handler(scope) -> (status, body)`` as a Preview and return the pipeline's response."""
    import json

    from sendproof_core.sync_engine import Inner

    def dispatch(scope):
        scope.entered = True
        status, body = handler(scope)
        return Inner(status, [("content-type", "application/json")], json.dumps(body).encode())

    return engine.preview(dispatch=dispatch, started=0.0, method="POST", path="/sendproof/_preview/x")


async def arun_preview(stores, handler):
    """The asynchronous pipeline of the ASGI adapter, without HTTP: returns ``(scope, handler_error)``.

    Begin every store, run ``handler(scope)`` (a coroutine function), then finish every store in
    reverse, as ``SendproofMiddleware`` does. ``scope.capture.blocked`` and ``.fault`` hold the outcome.
    """
    scope = preview_scope()
    error = None
    with active(scope):
        begun = []
        try:
            for store in stores:
                begun.append(store)
                await store.abegin(scope)
            await handler(scope)
        except Exception as caught:  # noqa: BLE001 - the tests inspect it
            error = caught
        scope.capture.handler_finished()
        for store in reversed(begun):
            await store.afinish(scope)
    return scope, error


# ------------------------------------------------------------------ batch two: Cassandra and OpenSearch
@contextmanager
def cassandra_keyspace() -> Iterator[tuple]:
    """A fresh keyspace holding ``tickets (id text PRIMARY KEY, status text, hits int)``, dropped afterwards.

    Yields ``(session, keyspace)`` of a plain, never-hooked ``cassandra-driver`` session.
    """
    from cassandra.cluster import Cluster

    host, _, port = CASSANDRA_SERVER.partition(":")
    cluster = Cluster([host], port=int(port or 9042))
    session = cluster.connect()
    keyspace = fresh()
    session.execute(f"CREATE KEYSPACE {keyspace} WITH replication = {{'class': 'SimpleStrategy', 'replication_factor': 1}}")
    session.execute(f"CREATE TABLE {keyspace}.tickets (id text PRIMARY KEY, status text, hits int)")
    try:
        yield session, keyspace
    finally:
        try:
            session.execute(f"DROP KEYSPACE {keyspace}")
        finally:
            cluster.shutdown()


@contextmanager
def opensearch_index() -> Iterator[tuple]:
    """A fresh index with ``title``, ``views`` and ``hidden``, deleted afterwards. Yields ``(client, index)`` of a plain client."""
    from opensearchpy import OpenSearch

    client = OpenSearch(OPENSEARCH_URL)
    index = fresh().replace("_", "-")
    client.indices.create(index, body={"mappings": {"properties": {
        "title": {"type": "keyword"}, "views": {"type": "integer"}, "hidden": {"type": "boolean"}}}})
    try:
        yield client, index
    finally:
        client.indices.delete(index, ignore_unavailable=True)
        client.close()
