"""Data-store routes of the Python conformance fixtures (spec/conformance/fixture.md "Data store routes").

The fixtures share these helpers, so every framework serves the same MongoDB, Redis, DynamoDB,
Cassandra and OpenSearch behavior. ``SyncStores`` uses PyMongo, redis-py, boto3, cassandra-driver and
opensearch-py (Flask and Django); ``AsyncStores`` uses ``AsyncMongoClient``, ``redis.asyncio``,
aioboto3 and ``AsyncOpenSearch`` (FastAPI), so the conformance run covers both families of clients.
cassandra-driver has no ``async`` API, so FastAPI runs its calls in a worker thread
(``asyncio.to_thread``, which keeps the request's context). Each helper returns ``(status, body)``;
the framework wraps it in a response.

A store is configured only when the runner passes its variables (``BENCH_MONGODB_URL``,
``BENCH_REDIS_URL`` and ``BENCH_REDIS_PREFIX``, ``BENCH_DYNAMODB_URL`` and ``BENCH_DYNAMODB_TABLE``,
``BENCH_CASSANDRA_CONTACT_POINT`` and ``BENCH_CASSANDRA_KEYSPACE``, ``BENCH_OPENSEARCH_URL`` and
``BENCH_OPENSEARCH_INDEX``), and its client is hooked as the binding documents:
``mongo_store(client).client`` for MongoDB, the client itself for Redis, the boto3 session for
DynamoDB, the cluster for Cassandra and the client for OpenSearch.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Mapping

log = logging.getLogger("fixture")

#: What the runner passes for each store; also the keys of ``previewUnavailable``.
PROBLEM = (404, None)

#: The routes marked ``preview: false``, with the store each writes to.
UNAVAILABLE = {"mongodb": "Clears a MongoDB document", "redis": "Clears a Redis counter", "dynamodb": "Deletes a DynamoDB order",
               "cassandra": "Deletes a Cassandra ticket", "opensearch": "Deletes an OpenSearch article"}

#: Every store the fixtures can serve; the ones a ``remember`` request may name.
STORE_IDS = ("mongodb", "redis", "dynamodb", "cassandra", "opensearch")
REMEMBERABLE = ("redis", "dynamodb", "cassandra", "opensearch")


def document_body(document: Mapping[str, Any]) -> dict:
    return {"id": document["_id"], "name": document.get("name"), "city": (document.get("profile") or {}).get("city")}


def order_body(item: Mapping[str, Any]) -> dict:
    return {"id": item["id"]["S"], "status": item.get("status", {}).get("S"), "hits": int(item.get("hits", {}).get("N", 0))}


def new_document(body: Mapping[str, Any]) -> dict:
    return {"_id": body["id"], "name": body["name"], "profile": {"city": body["city"]},
            "password_hash": "hashed:" + body["password"]}


def ticket_body(row: Any) -> dict:
    return {"id": row.id, "status": row.status, "hits": row.hits}


def article_body(identifier: str, source: Mapping[str, Any]) -> dict:
    return {"id": identifier, "title": source.get("title"), "views": source.get("views")}


#: The CQL of the Cassandra routes. The read is prepared once and executed, so the hook must
#: classify the execution by the text it saw prepared; the insert carries literals the Db entry hides.
SELECT_TICKET = "SELECT id, status, hits FROM tickets WHERE id = ?"
INSERT_TICKET = "INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)"
CLOSE_TICKET = "UPDATE tickets SET status = 'closed' WHERE id = ? IF EXISTS"
DELETE_TICKET = "DELETE FROM tickets WHERE id = ?"


def touch_article_request(identifier: str) -> dict:
    """``POST /<index>/_update/<id>?refresh=true``: bump ``views`` through a script, upserting a new article."""
    return {"id": identifier, "params": {"refresh": "true"}, "body": {
        "script": {"source": "ctx._source.views += params.step", "params": {"step": 1}},
        "upsert": {"title": "Untitled", "views": 1}, "_source": True}}


def ids_query(identifier: str) -> dict:
    return {"query": {"ids": {"values": [identifier]}}}


def touch_request(table: str, identifier: str) -> dict:
    return {
        "TableName": table, "Key": {"id": {"S": identifier}},
        "UpdateExpression": "ADD hits :one SET #s = if_not_exists(#s, :new)",
        "ExpressionAttributeNames": {"#s": "status"},
        "ExpressionAttributeValues": {":one": {"N": "1"}, ":new": {"S": "new"}},
        "ReturnValues": "ALL_NEW",
    }


def cancel_request(table: str, identifier: str) -> dict:
    return {"Statement": f"UPDATE \"{table}\" SET status = 'cancelled' WHERE id = ?", "Parameters": [{"S": identifier}]}


def patch_fields(body: Mapping[str, Any]) -> dict:
    fields = {}
    if isinstance(body.get("name"), str):
        fields["name"] = body["name"]
    if isinstance(body.get("city"), str):
        fields["profile.city"] = body["city"]
    return fields


class SyncStores:
    """The store routes over synchronous clients."""

    def __init__(self, env: Mapping[str, str] = os.environ) -> None:
        from sendproof_core.stores import dynamodb_store, mongo_store, redis_store

        self.data_stores: list = []
        self.documents = self.redis = self.dynamo = self.cassandra = self.search = None
        self.prefix = env.get("BENCH_REDIS_PREFIX", "")
        self.table = env.get("BENCH_DYNAMODB_TABLE", "")
        self.index = env.get("BENCH_OPENSEARCH_INDEX", "")
        if env.get("BENCH_MONGODB_URL"):
            from pymongo import MongoClient

            store = mongo_store(MongoClient(env["BENCH_MONGODB_URL"]), name="catalog")
            self.data_stores.append(store)
            self.documents = store.client.get_default_database()["documents"]
        if env.get("BENCH_REDIS_URL"):
            import redis

            self.redis = redis.Redis.from_url(env["BENCH_REDIS_URL"])
            self.data_stores.append(redis_store(self.redis, name="cache"))
        if env.get("BENCH_DYNAMODB_URL"):
            import boto3

            session = boto3.Session(region_name=env.get("AWS_REGION", "us-east-1"))
            self.data_stores.append(dynamodb_store(session, name="orders"))
            self.dynamo = session.client("dynamodb", endpoint_url=env["BENCH_DYNAMODB_URL"])
        if env.get("BENCH_CASSANDRA_CONTACT_POINT"):
            from cassandra.cluster import Cluster
            from sendproof_core.stores import cassandra_store

            host, _, port = env["BENCH_CASSANDRA_CONTACT_POINT"].partition(":")
            cluster = Cluster([host], port=int(port or 9042))
            self.data_stores.append(cassandra_store(cluster, name="tickets"))  # covers every session the cluster makes
            self.cassandra = cluster.connect(env["BENCH_CASSANDRA_KEYSPACE"])
            self.select, self.insert = self.cassandra.prepare(SELECT_TICKET), self.cassandra.prepare(INSERT_TICKET)
        if env.get("BENCH_OPENSEARCH_URL"):
            from opensearchpy import OpenSearch
            from sendproof_core.stores import opensearch_store

            self.search = OpenSearch(env["BENCH_OPENSEARCH_URL"])
            self.data_stores.append(opensearch_store(self.search, name="search"))

    @property
    def stores(self) -> list[str]:
        clients = (("mongodb", self.documents), ("redis", self.redis), ("dynamodb", self.dynamo),
                   ("cassandra", self.cassandra), ("opensearch", self.search))
        return [name for name, client in clients if client is not None]

    def key(self, name: str) -> str:
        return f"{self.prefix}counter:{name}"

    # ---- MongoDB
    def get_document(self, identifier: str) -> tuple[int, Any]:
        document = self.documents.find_one({"_id": identifier})
        return (200, document_body(document)) if document else PROBLEM

    def create_document(self, body: Mapping[str, Any]) -> tuple[int, Any]:
        self.documents.insert_one(new_document(body))
        log.info("created-document:%s", body["id"])
        return 201, {"id": body["id"], "name": body["name"], "city": body["city"]}

    def patch_document(self, identifier: str, body: Mapping[str, Any]) -> tuple[int, Any]:
        fields = patch_fields(body)
        if not fields or self.documents.update_one({"_id": identifier}, {"$set": fields}).matched_count == 0:
            return PROBLEM
        return self.get_document(identifier)

    def archive_documents(self) -> tuple[int, Any]:
        list(self.documents.aggregate([{"$match": {}}, {"$out": "documents_archive"}]))
        return 204, None

    def delete_document(self, identifier: str) -> tuple[int, Any]:
        self.documents.delete_one({"_id": identifier})
        return 204, None

    # ---- Redis
    def get_counter(self, name: str) -> tuple[int, Any]:
        value = self.redis.get(self.key(name))
        return (200, {"key": name, "value": int(value)}) if value is not None else PROBLEM

    def incr_counter(self, name: str) -> tuple[int, Any]:
        return 200, {"key": name, "value": int(self.redis.execute_command("INCR", self.key(name)))}

    def take_counter(self, name: str) -> tuple[int, Any]:
        value = None
        try:
            value = self.redis.getdel(self.key(name))
        except Exception:  # swallowed on purpose: the blocked mark, not the response, decides a Preview
            pass
        return (200, {"key": name, "value": int(value)}) if value is not None else PROBLEM

    def delete_counter(self, name: str) -> tuple[int, Any]:
        self.redis.delete(self.key(name))
        return 204, None

    # ---- DynamoDB
    def get_order(self, identifier: str) -> tuple[int, Any]:
        item = self.dynamo.get_item(TableName=self.table, Key={"id": {"S": identifier}}, ConsistentRead=True).get("Item")
        return (200, order_body(item)) if item else PROBLEM

    def touch_order(self, identifier: str) -> tuple[int, Any]:
        return 200, order_body(self.dynamo.update_item(**touch_request(self.table, identifier))["Attributes"])

    def cancel_order(self, identifier: str) -> tuple[int, Any]:
        self.dynamo.execute_statement(**cancel_request(self.table, identifier))
        return 200, {"id": identifier, "status": "cancelled"}

    def delete_order(self, identifier: str) -> tuple[int, Any]:
        self.dynamo.delete_item(TableName=self.table, Key={"id": {"S": identifier}})
        return 204, None

    # ---- Cassandra
    def get_ticket(self, identifier: str) -> tuple[int, Any]:
        row = self.cassandra.execute(self.select, (identifier,)).one()
        return (200, ticket_body(row)) if row else PROBLEM

    def touch_ticket(self, identifier: str) -> tuple[int, Any]:
        self.cassandra.execute(self.insert, (identifier,))
        return 200, {"id": identifier, "status": "new", "hits": 1}

    def close_ticket(self, identifier: str) -> tuple[int, Any]:
        from cassandra.query import BatchStatement, BatchType

        batch = BatchStatement(batch_type=BatchType.LOGGED)  # a logged batch holding a lightweight transaction
        batch.add(CLOSE_TICKET.replace("?", "%s"), (identifier,))
        self.cassandra.execute(batch)
        return 200, {"id": identifier, "status": "closed"}

    def delete_ticket(self, identifier: str) -> tuple[int, Any]:
        self.cassandra.execute(DELETE_TICKET.replace("?", "%s"), (identifier,))
        return 204, None

    # ---- OpenSearch
    def get_article(self, identifier: str) -> tuple[int, Any]:
        hits = self.search.search(index=self.index, body={**ids_query(identifier), "size": 1})["hits"]["hits"]  # a read sent as a POST
        return (200, article_body(identifier, hits[0]["_source"])) if hits else PROBLEM

    def touch_article(self, identifier: str) -> tuple[int, Any]:
        request = touch_article_request(identifier)
        reply = self.search.update(self.index, identifier, request["body"], params=request["params"])
        return 200, article_body(identifier, reply["get"]["_source"])

    def hide_article(self, identifier: str) -> tuple[int, Any]:
        try:
            reply = self.search.update_by_query(self.index, body={**ids_query(identifier), "script": {"source": "ctx._source.hidden = true"}},
                                                params={"refresh": "true"})
        except Exception:  # swallowed on purpose: the blocked mark, not the response, decides a Preview
            return PROBLEM
        return (200, {"id": identifier, "hidden": True}) if reply.get("updated") else PROBLEM

    def delete_article(self, identifier: str) -> tuple[int, Any]:
        self.search.delete(self.index, identifier, params={"refresh": "true"})
        return 204, None

    # ---- Mixed SQL and store
    def remember(self, store: str, identifier: str) -> None:
        """The guarded write of ``POST /items/{id}/remember``, after the SQL insert."""
        if store == "redis":
            self.redis.execute_command("INCR", self.key("item-" + identifier))
        elif store == "cassandra":
            self.touch_ticket("item-" + identifier)
        elif store == "opensearch":
            self.touch_article("item-" + identifier)
        else:
            self.dynamo.update_item(**touch_request(self.table, "item-" + identifier))


class AsyncStores:
    """The store routes over asynchronous clients: ``AsyncMongoClient``, ``redis.asyncio`` and aioboto3."""

    def __init__(self, env: Mapping[str, str] = os.environ) -> None:
        from sendproof_core.stores import dynamodb_store, mongo_store, redis_store

        self.data_stores: list = []
        self.documents = self.redis = self.dynamo = self._dynamo_context = self.cassandra = self.search = None
        self._session = None
        self._env = env
        self.prefix = env.get("BENCH_REDIS_PREFIX", "")
        self.table = env.get("BENCH_DYNAMODB_TABLE", "")
        self.index = env.get("BENCH_OPENSEARCH_INDEX", "")
        if env.get("BENCH_MONGODB_URL"):
            from pymongo import AsyncMongoClient

            store = mongo_store(AsyncMongoClient(env["BENCH_MONGODB_URL"]), name="catalog")
            self.data_stores.append(store)
            self.documents = store.client.get_default_database()["documents"]
        if env.get("BENCH_REDIS_URL"):
            import redis.asyncio as aioredis

            self.redis = aioredis.Redis.from_url(env["BENCH_REDIS_URL"])
            self.data_stores.append(redis_store(self.redis, name="cache"))
        if env.get("BENCH_DYNAMODB_URL"):
            import aioboto3

            self._session = aioboto3.Session(region_name=env.get("AWS_REGION", "us-east-1"))
            self.data_stores.append(dynamodb_store(self._session, name="orders"))
        if env.get("BENCH_CASSANDRA_CONTACT_POINT"):
            from cassandra.cluster import Cluster
            from sendproof_core.stores import cassandra_store

            host, _, port = env["BENCH_CASSANDRA_CONTACT_POINT"].partition(":")
            cluster = Cluster([host], port=int(port or 9042))
            self.data_stores.append(cassandra_store(cluster, name="tickets"))
            self.cassandra = cluster.connect(env["BENCH_CASSANDRA_KEYSPACE"])  # blocking, at startup
            self.select, self.insert = self.cassandra.prepare(SELECT_TICKET), self.cassandra.prepare(INSERT_TICKET)
        if env.get("BENCH_OPENSEARCH_URL"):
            from opensearchpy import AsyncOpenSearch
            from sendproof_core.stores import opensearch_store

            self.search = AsyncOpenSearch(env["BENCH_OPENSEARCH_URL"])
            self.data_stores.append(opensearch_store(self.search, name="search"))

    @property
    def stores(self) -> list[str]:
        clients = (("mongodb", self.documents), ("redis", self.redis), ("dynamodb", self._session),
                   ("cassandra", self.cassandra), ("opensearch", self.search))
        return [name for name, client in clients if client is not None]

    def key(self, name: str) -> str:
        return f"{self.prefix}counter:{name}"

    async def client(self) -> Any:
        """The aioboto3 client, opened on first use inside the server's event loop."""
        if self.dynamo is None:
            self._dynamo_context = self._session.client("dynamodb", endpoint_url=self._env["BENCH_DYNAMODB_URL"])
            self.dynamo = await self._dynamo_context.__aenter__()
        return self.dynamo

    # ---- MongoDB
    async def get_document(self, identifier: str) -> tuple[int, Any]:
        document = await self.documents.find_one({"_id": identifier})
        return (200, document_body(document)) if document else PROBLEM

    async def create_document(self, body: Mapping[str, Any]) -> tuple[int, Any]:
        await self.documents.insert_one(new_document(body))
        log.info("created-document:%s", body["id"])
        return 201, {"id": body["id"], "name": body["name"], "city": body["city"]}

    async def patch_document(self, identifier: str, body: Mapping[str, Any]) -> tuple[int, Any]:
        fields = patch_fields(body)
        if not fields or (await self.documents.update_one({"_id": identifier}, {"$set": fields})).matched_count == 0:
            return PROBLEM
        return await self.get_document(identifier)

    async def archive_documents(self) -> tuple[int, Any]:
        cursor = await self.documents.aggregate([{"$match": {}}, {"$out": "documents_archive"}])
        await cursor.to_list(None)
        return 204, None

    async def delete_document(self, identifier: str) -> tuple[int, Any]:
        await self.documents.delete_one({"_id": identifier})
        return 204, None

    # ---- Redis
    async def get_counter(self, name: str) -> tuple[int, Any]:
        value = await self.redis.get(self.key(name))
        return (200, {"key": name, "value": int(value)}) if value is not None else PROBLEM

    async def incr_counter(self, name: str) -> tuple[int, Any]:
        return 200, {"key": name, "value": int(await self.redis.execute_command("INCR", self.key(name)))}

    async def take_counter(self, name: str) -> tuple[int, Any]:
        value = None
        try:
            value = await self.redis.getdel(self.key(name))
        except Exception:  # swallowed on purpose: the blocked mark, not the response, decides a Preview
            pass
        return (200, {"key": name, "value": int(value)}) if value is not None else PROBLEM

    async def delete_counter(self, name: str) -> tuple[int, Any]:
        await self.redis.delete(self.key(name))
        return 204, None

    # ---- DynamoDB
    async def get_order(self, identifier: str) -> tuple[int, Any]:
        client = await self.client()
        item = (await client.get_item(TableName=self.table, Key={"id": {"S": identifier}}, ConsistentRead=True)).get("Item")
        return (200, order_body(item)) if item else PROBLEM

    async def touch_order(self, identifier: str) -> tuple[int, Any]:
        client = await self.client()
        return 200, order_body((await client.update_item(**touch_request(self.table, identifier)))["Attributes"])

    async def cancel_order(self, identifier: str) -> tuple[int, Any]:
        client = await self.client()
        await client.execute_statement(**cancel_request(self.table, identifier))
        return 200, {"id": identifier, "status": "cancelled"}

    async def delete_order(self, identifier: str) -> tuple[int, Any]:
        client = await self.client()
        await client.delete_item(TableName=self.table, Key={"id": {"S": identifier}})
        return 204, None

    # ---- Cassandra: the driver is synchronous, so each call runs in a worker thread that keeps the request's context
    async def get_ticket(self, identifier: str) -> tuple[int, Any]:
        row = (await asyncio.to_thread(self.cassandra.execute, self.select, (identifier,))).one()
        return (200, ticket_body(row)) if row else PROBLEM

    async def touch_ticket(self, identifier: str) -> tuple[int, Any]:
        await asyncio.to_thread(self.cassandra.execute, self.insert, (identifier,))
        return 200, {"id": identifier, "status": "new", "hits": 1}

    async def close_ticket(self, identifier: str) -> tuple[int, Any]:
        from cassandra.query import BatchStatement, BatchType

        batch = BatchStatement(batch_type=BatchType.LOGGED)
        batch.add(CLOSE_TICKET.replace("?", "%s"), (identifier,))
        await asyncio.to_thread(self.cassandra.execute, batch)
        return 200, {"id": identifier, "status": "closed"}

    async def delete_ticket(self, identifier: str) -> tuple[int, Any]:
        await asyncio.to_thread(self.cassandra.execute, DELETE_TICKET.replace("?", "%s"), (identifier,))
        return 204, None

    # ---- OpenSearch
    async def get_article(self, identifier: str) -> tuple[int, Any]:
        hits = (await self.search.search(index=self.index, body={**ids_query(identifier), "size": 1}))["hits"]["hits"]
        return (200, article_body(identifier, hits[0]["_source"])) if hits else PROBLEM

    async def touch_article(self, identifier: str) -> tuple[int, Any]:
        request = touch_article_request(identifier)
        reply = await self.search.update(self.index, identifier, request["body"], params=request["params"])
        return 200, article_body(identifier, reply["get"]["_source"])

    async def hide_article(self, identifier: str) -> tuple[int, Any]:
        try:
            reply = await self.search.update_by_query(
                self.index, body={**ids_query(identifier), "script": {"source": "ctx._source.hidden = true"}}, params={"refresh": "true"})
        except Exception:  # swallowed on purpose: the blocked mark, not the response, decides a Preview
            return PROBLEM
        return (200, {"id": identifier, "hidden": True}) if reply.get("updated") else PROBLEM

    async def delete_article(self, identifier: str) -> tuple[int, Any]:
        await self.search.delete(self.index, identifier, params={"refresh": "true"})
        return 204, None

    # ---- Mixed SQL and store
    async def remember(self, store: str, identifier: str) -> None:
        """The guarded write of ``POST /items/{id}/remember``, after the SQL insert."""
        if store == "redis":
            await self.redis.execute_command("INCR", self.key("item-" + identifier))
        elif store == "cassandra":
            await self.touch_ticket("item-" + identifier)
        elif store == "opensearch":
            await self.touch_article("item-" + identifier)
        else:
            await self.touch_order("item-" + identifier)
