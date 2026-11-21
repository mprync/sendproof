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

# DynamoDB Local accepts any well-formed credentials; the secret is a marker that must never reach a capture.
os.environ.setdefault("AWS_ACCESS_KEY_ID", "benchlocal")
os.environ["AWS_SECRET_ACCESS_KEY"] = os.environ.get("AWS_SECRET_ACCESS_KEY", "benchDynamoSecret" + uuid.uuid4().hex[:8])
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
REGION = os.environ["AWS_DEFAULT_REGION"]
START = "docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb"


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
    except Exception:
        return False
    raise ValueError(store)


def needs(store: str):
    """A pytest mark that skips a test when the compose service for ``store`` is down."""
    return pytest.mark.skipif(not available(store), reason=f"{store} is not running: {START}")


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
