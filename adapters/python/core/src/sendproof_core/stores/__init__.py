"""Data-store support: the write guard and the Redis, DynamoDB, MongoDB, Cassandra, Elasticsearch,
OpenSearch, Cosmos DB and Firestore hooks (``spec/data-stores.md``).

Each hook is imported on first use, so installing the core never requires a store client library::

    from sendproof_core.stores import dynamodb_store, mongo_store, redis_store

    bench = Sendproof(
        app,
        provider=SQLAlchemyPreview(engine),
        data_stores=[
            mongo_store(mongo_client, name="catalog"),   # handlers use the returned store's .client
            redis_store(redis_client, name="cache"),     # hooks the client in place
            dynamodb_store(boto3_session, name="orders"),
            # Batch two, guard-only: each hooks its client in place.
            cassandra_store(cluster, name="tickets"),
            elasticsearch_store(es_client, name="search"),   # opensearch_store(...) for opensearch-py
            cosmosdb_store(cosmos_client, name="orders"),
            firestore_store(firestore_client, name="profiles"),
        ],
    )

Only hooked clients are covered. A client created inside a handler, a second client for the same
store, or a raw socket is not: its writes are neither blocked nor rolled back.
"""

from __future__ import annotations

from typing import Any

from .base import DataStore, StoresOnlyProvider
from .classify import classify_dynamo, classify_mongo, classify_redis, partiql_verb
from .classify_batch_two import (
    Verdict,
    classify_cassandra,
    classify_cassandra_message,
    classify_cosmos,
    classify_elasticsearch,
    classify_firestore,
    cosmos_operation,
    firestore_rpc,
)
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
    "cassandra_store": "cassandra_hook",
    "CassandraStore": "cassandra_hook",
    "elasticsearch_store": "elasticsearch_hook",
    "opensearch_store": "elasticsearch_hook",
    "ElasticsearchStore": "elasticsearch_hook",
    "cosmosdb_store": "cosmos_hook",
    "CosmosDBStore": "cosmos_hook",
    "firestore_store": "firestore_hook",
    "FirestoreStore": "firestore_hook",
}


def __getattr__(name: str) -> Any:
    module = _LAZY.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module

    return getattr(import_module(f".{module}", __name__), name)


__all__ = [
    "CassandraStore",
    "CosmosDBStore",
    "DataStore",
    "DynamoDBStore",
    "ElasticsearchStore",
    "FirestoreStore",
    "MongoStore",
    "PreviewTransactionControl",
    "PreviewWriteBlocked",
    "RedisStore",
    "StoresOnlyProvider",
    "Verdict",
    "cassandra_store",
    "classify_cassandra",
    "classify_cassandra_message",
    "classify_cosmos",
    "classify_dynamo",
    "classify_elasticsearch",
    "classify_firestore",
    "classify_mongo",
    "classify_redis",
    "cosmos_operation",
    "cosmosdb_store",
    "dynamodb_store",
    "elasticsearch_store",
    "firestore_rpc",
    "firestore_store",
    "guard",
    "mongo_monitor",
    "mongo_store",
    "opensearch_store",
    "partiql_verb",
    "redis_store",
    "refuse_in_preview",
    "sanitize_document",
    "write_reason",
]
