"""Data-store support: the write guard, Redis, DynamoDB and MongoDB hooks (``spec/data-stores.md``).

Each hook is imported on first use, so installing the core never requires a store client library::

    from sendproof_core.stores import dynamodb_store, mongo_store, redis_store

    bench = Sendproof(
        app,
        provider=SQLAlchemyPreview(engine),
        data_stores=[
            mongo_store(mongo_client, name="catalog"),   # handlers use the returned store's .client
            redis_store(redis_client, name="cache"),     # hooks the client in place
            dynamodb_store(boto3_session, name="orders"),
        ],
    )

Only hooked clients are covered. A client created inside a handler, a second client for the same
store, or a raw socket is not: its writes are neither blocked nor rolled back.
"""

from __future__ import annotations

from typing import Any

from .base import DataStore, StoresOnlyProvider
from .classify import classify_dynamo, classify_mongo, classify_redis, partiql_verb
from .guard import (
    PreviewTransactionControl,
    PreviewWriteBlocked,
    guard,
    refuse_in_preview,
    sanitize_document,
    write_reason,
)

# Each hook lives in a module named ``*_hook`` so that its factory function can carry the public name.
_LAZY = {
    "redis_store": "redis_hook",
    "RedisStore": "redis_hook",
    "dynamodb_store": "dynamodb_hook",
    "DynamoDBStore": "dynamodb_hook",
    "mongo_store": "mongo_hook",
    "MongoStore": "mongo_hook",
    "mongo_monitor": "mongo_hook",
}


def __getattr__(name: str) -> Any:
    module = _LAZY.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module

    return getattr(import_module(f".{module}", __name__), name)


__all__ = [
    "DataStore",
    "DynamoDBStore",
    "MongoStore",
    "PreviewTransactionControl",
    "PreviewWriteBlocked",
    "RedisStore",
    "StoresOnlyProvider",
    "classify_dynamo",
    "classify_mongo",
    "classify_redis",
    "dynamodb_store",
    "guard",
    "mongo_monitor",
    "mongo_store",
    "partiql_verb",
    "redis_store",
    "refuse_in_preview",
    "sanitize_document",
    "write_reason",
]
