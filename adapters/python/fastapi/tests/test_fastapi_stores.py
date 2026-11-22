"""Data stores in the FastAPI adapter: asynchronous and synchronous clients, ``def`` endpoints that run in
the thread pool, Preview without a SQL provider, ``preview: false`` and discovery, against the compose
services (see ``core/tests/store_support.py``)."""

from __future__ import annotations

import json

import httpx
import pytest
import redis
import redis.asyncio as aredis
from fastapi import Depends, FastAPI, Request
from sqlalchemy import String, create_engine, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from sendproof_core import PreviewProvider, PreviewSession
from sendproof_core.stores import DataStore, PreviewWriteBlocked, mongo_store, redis_store
from sendproof_fastapi import Identity, Sendproof, preview
from sendproof_sqlalchemy import SQLAlchemyPreview
from store_support import REDIS_URL, available, fresh, needs, new_mongo

ROLLBACK = {"Prefer": "tx=rollback"}


class Base(DeclarativeBase):
    pass


class Item(Base):
    __tablename__ = "items"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)


def make(tmp_path, *, stores=(), sql=True, setup=None):
    app = FastAPI(title="Inventory")
    engine = create_engine(f"sqlite:///{tmp_path / 'db.sqlite'}")
    Base.metadata.create_all(engine)
    app.state.engine = engine
    if setup:
        setup(app)
    Sendproof(app, provider=SQLAlchemyPreview(engine, database="db") if sql else None, data_stores=list(stores),
              environment="Development", identity=lambda request: Identity("Alex", "admin", "alex", "test"), trace_ttl=5)
    return app, engine


def client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def items(engine):
    with Session(engine) as session:
        return sorted(i.id for i in session.scalars(select(Item)))


@pytest.fixture
def prefix():
    prefix = fresh() + ":"
    yield prefix
    reader = redis.Redis.from_url(REDIS_URL)
    keys = reader.keys(prefix + "*")
    if keys:
        reader.delete(*keys)
    reader.close()


def routes(sync_client, async_client, prefix):
    key = prefix + "counter"

    def setup(app):
        @app.get("/counters")
        @preview
        async def read():
            return {"value": int(await async_client.get(key) or 0)}

        @app.post("/counters")
        @preview
        async def bump():
            return {"value": await async_client.execute_command("INCR", key)}

        @app.post("/threadpool")
        @preview
        def bump_in_a_thread():  # a plain ``def`` endpoint runs through run_in_threadpool
            return {"value": sync_client.execute_command("INCR", key)}

        @app.post("/swallow")
        @preview
        async def swallow():
            try:
                await async_client.execute_command("INCR", key)
            except PreviewWriteBlocked:
                pass
            return {"ok": True}

        @app.delete("/counters")
        @preview(False, stores=["redis"])
        async def clear():
            await async_client.delete(key)

        @app.post("/mixed", status_code=201)
        @preview
        async def mixed():
            with Session(app.state.engine) as session:
                session.add(Item(id="mixed", name="x"))
                session.commit()
            await async_client.execute_command("INCR", key)

        @app.post("/commit", status_code=201)
        @preview
        def commit():
            with Session(app.state.engine) as session:
                session.add(Item(id="commit", name="x"))
                session.flush()
                session.execute(text("COMMIT"))

    return setup


@pytest.fixture
def cache(prefix):
    sync_client = redis.Redis.from_url(REDIS_URL)
    async_client = aredis.Redis.from_url(REDIS_URL)
    stores = [redis_store(sync_client, name="cache"), redis_store(async_client)]
    yield sync_client, async_client, stores, prefix
    sync_client.close()


redis_only = needs("redis")


@redis_only
async def test_async_endpoints_and_thread_pool_endpoints_are_both_guarded(tmp_path, cache):
    sync_client, async_client, stores, prefix = cache
    app, _ = make(tmp_path, stores=stores, setup=routes(sync_client, async_client, prefix))
    async with client(app) as http:
        for path in ("/counters", "/threadpool", "/swallow"):
            response = await http.post("/sendproof/_preview" + path, headers=ROLLBACK)
            assert response.status_code == 409, path
            assert response.headers["content-type"].startswith("application/problem+json") and "preference-applied" not in response.headers
            body = response.json()
            assert (body["code"], body["store"], body["operation"], body["rolledBack"]) == ("preview_unavailable", "redis", "INCR", False)
        read = (await http.get("/sendproof/_preview/counters", headers=ROLLBACK)).json()
        assert read["status"] == 200 and read["body"] == {"value": 0} and read["rolledBack"] is True
        assert [e["db"]["operation"] for e in read["logs"] if e["level"] == "Db"] == ["GET"]
    assert sync_client.get(prefix + "counter") is None
    await async_client.aclose()


@redis_only
async def test_sql_and_a_guarded_write_roll_back_together_and_a_handler_commit_is_a_500(tmp_path, cache):
    sync_client, async_client, stores, prefix = cache
    app, engine = make(tmp_path, stores=stores, setup=routes(sync_client, async_client, prefix))
    async with client(app) as http:
        assert (await http.post("/sendproof/_preview/mixed", headers=ROLLBACK)).status_code == 409
        committed = await http.post("/sendproof/_preview/commit", headers=ROLLBACK)
        assert committed.status_code == 500 and "preference-applied" not in committed.headers
    assert items(engine) == [] and sync_client.get(prefix + "counter") is None
    await async_client.aclose()


@redis_only
async def test_preview_works_without_a_sql_provider_when_stores_are_registered(tmp_path, cache):
    sync_client, async_client, stores, prefix = cache
    app, _ = make(tmp_path, stores=stores, sql=False, setup=routes(sync_client, async_client, prefix))
    async with client(app) as http:
        caps = (await http.get("/sendproof/_api/capabilities")).json()
        assert {"method": "GET", "path": "/counters"} in caps["previewOperations"] and caps["database"] is None
        assert (await http.get("/sendproof/_preview/counters", headers=ROLLBACK)).json()["status"] == 200
        assert (await http.post("/sendproof/_preview/counters", headers=ROLLBACK)).status_code == 409
    await async_client.aclose()


@redis_only
async def test_discovery_and_preview_false(tmp_path, cache):
    sync_client, async_client, stores, prefix = cache
    sync_client.set(prefix + "counter", 3)
    app, _ = make(tmp_path, stores=stores, setup=routes(sync_client, async_client, prefix))
    async with client(app) as http:
        caps = (await http.get("/sendproof/_api/capabilities")).json()
        assert caps["dataStores"][0] == {"system": "redis", "name": "cache", "mode": "guard"}
        assert caps["binding"] == {"language": "python", "framework": "FastAPI"} and caps["database"] == {"name": "db", "system": "sqlite"}
        assert caps["previewUnavailable"] == [{"method": "DELETE", "path": "/counters", "reason": "Preview unavailable: this operation writes to Redis", "stores": ["redis"]}]
        assert not any(op["method"] == "DELETE" for op in caps["previewOperations"])
        refused = await http.delete("/sendproof/_preview/counters", headers=ROLLBACK)
        assert refused.status_code == 409 and "preference-applied" not in refused.headers
        assert sync_client.get(prefix + "counter") == b"3"  # the handler did not run
        assert (await http.delete("/counters")).status_code == 200  # Send still runs it
    assert sync_client.get(prefix + "counter") is None
    await async_client.aclose()


@redis_only
async def test_observed_send_commits_once_and_the_trace_lists_db_entries(tmp_path, cache):
    sync_client, async_client, stores, prefix = cache
    app, _ = make(tmp_path, stores=stores, setup=routes(sync_client, async_client, prefix))
    async with client(app) as http:
        sent = await http.post("/counters", headers={"Prefer": "trace"})
        assert sent.status_code == 200 and sent.json() == {"value": 1}
        trace = (await http.get("/sendproof/_api/traces/" + sent.headers["x-sendproof-trace"])).json()
    assert [(e["db"]["operation"], e["db"]["statement"]) for e in trace["logs"] if e["level"] == "Db"] == [("INCR", f"INCR {prefix}counter")]
    assert sync_client.get(prefix + "counter") == b"1"
    await async_client.aclose()


@needs("mongodb")
async def test_async_mongo_previews_roll_back_in_an_async_endpoint(tmp_path):
    from pymongo import AsyncMongoClient

    from store_support import MONGODB_URL

    name = fresh()
    mongo = AsyncMongoClient(MONGODB_URL)
    store = mongo_store(mongo, name="catalog")
    documents = store.client[name]["documents"]

    def setup(app):
        @app.post("/documents", status_code=201)
        @preview
        async def create(body: dict):
            await documents.insert_one({"_id": body["id"], "profile": {"city": body["city"]}, "password_hash": "hashed:pw"})
            return {"id": body["id"]}

        @app.get("/documents/{id}")
        @preview
        async def read(id: str):
            return (await documents.find_one({"_id": id})) or {}

    app, _ = make(tmp_path, stores=[store], sql=False, setup=setup)
    async with client(app) as http:
        caps = (await http.get("/sendproof/_api/capabilities")).json()
        assert caps["dataStores"] == [{"system": "mongodb", "name": "catalog", "mode": "preview"}]
        envelope = (await http.post("/sendproof/_preview/documents", json={"id": "d1", "city": "York"}, headers=ROLLBACK)).json()
        (change,) = envelope["changes"]
        assert (change["store"], change["operation"], change["key"]) == ("mongodb", "insert", {"_id": "d1"})
        assert change["after"]["password_hash"] == "[REDACTED]" and change["after"]["profile"] == {"city": "York"}
        assert (await http.get("/documents/d1")).json() == {}  # nothing persisted
    reader = new_mongo()
    reader.drop_database(name)
    reader.close()
    await mongo.close()


class _Recording(DataStore):
    """A store that records its abort; ``interrupt`` makes the abort raise a ``BaseException``."""

    system = "redis"

    def __init__(self, interrupt: BaseException | None = None) -> None:
        self.finished, self.interrupt = 0, interrupt

    def describe(self):
        return {"system": "redis", "mode": "guard"}

    async def abegin(self, scope):
        pass

    async def afinish(self, scope):
        self.finished += 1
        if self.interrupt is not None:
            raise self.interrupt


class _SpySession(PreviewSession):
    def __init__(self) -> None:
        self.rolled_back = self.closed = False

    @property
    def changes(self):
        return []

    def rollback(self):
        self.rolled_back = True

    def close(self):
        self.closed = True


class _SpyProvider(PreviewProvider):
    database = "db"

    def __init__(self) -> None:
        self.sessions: list[_SpySession] = []

    def begin(self, scope):
        self.sessions.append(_SpySession())
        return self.sessions[-1]


def _bare_app(provider, stores, setup):
    app = FastAPI()
    setup(app)
    Sendproof(app, provider=provider, data_stores=stores, environment="Development",
              identity=lambda request: Identity("Alex", "admin", "alex", "test"))
    return app


async def test_cancellation_and_an_interrupted_abort_still_run_every_cleanup_step():
    """``CancelledError`` is a ``BaseException``: a cancelled handler, or a store whose abort is interrupted,
    must still abort every store, roll back SQL and release the transaction (a MySQL Preview's turn)."""
    import asyncio

    def setup(app):
        @app.post("/cancelled")
        @preview
        async def cancelled():
            raise asyncio.CancelledError()  # the task was cancelled mid-handler (a client disconnect)

        @app.post("/ok")
        @preview
        async def ok():
            return {}

    provider, first, last = _SpyProvider(), _Recording(), _Recording()
    app = _bare_app(provider, [first, last], setup)
    with pytest.raises(asyncio.CancelledError):
        await app({"type": "http", "method": "POST", "path": "/sendproof/_preview/cancelled", "raw_path": b"/sendproof/_preview/cancelled",
                   "root_path": "", "scheme": "http", "query_string": b"", "server": ("test", 80), "client": ("127.0.0.1", 1),
                   "headers": [(b"host", b"test"), (b"prefer", b"tx=rollback")], "http_version": "1.1", "asgi": {"version": "3.0"}},
                  _receive, _discard)
    assert (first.finished, last.finished) == (1, 1)
    assert provider.sessions[-1].rolled_back and provider.sessions[-1].closed

    class Interrupt(BaseException):
        pass

    provider, first, interrupting = _SpyProvider(), _Recording(), _Recording(Interrupt())
    app = _bare_app(provider, [first, interrupting], setup)
    with pytest.raises(Interrupt):
        async with client(app) as http:
            await http.post("/sendproof/_preview/ok", headers=ROLLBACK)
    assert (first.finished, interrupting.finished) == (1, 1)  # reversed order: the interrupted one ran first
    assert provider.sessions[-1].rolled_back and provider.sessions[-1].closed


async def _receive():
    return {"type": "http.request", "body": b"", "more_body": False}


async def _discard(message):
    pass


@redis_only
async def test_a_concurrent_ordinary_request_is_attributed_but_a_stray_threads_write_is_refused(tmp_path, cache):
    """The adapter marks every request, so only a write nothing accounts for is refused and blocks the open Previews."""
    import asyncio
    import threading

    sync_client, async_client, stores, prefix = cache
    entered, release = asyncio.Event(), asyncio.Event()

    def setup(app):
        @app.get("/slow")
        @preview
        async def slow():
            entered.set()
            await release.wait()
            return {}

        @app.post("/plain")
        async def plain():
            await async_client.set(prefix + "plain", 1)  # an ordinary Send, while the Preview is open
            return {}

        @app.get("/stray")
        @preview
        async def stray():
            thread = threading.Thread(target=lambda: sync_client.set(prefix + "stray", 1))  # no context copied
            thread.start()
            thread.join()
            return {}

    app, _ = make(tmp_path, stores=stores, setup=setup)
    async with client(app) as http:
        pending = asyncio.ensure_future(http.get("/sendproof/_preview/slow", headers=ROLLBACK))
        await entered.wait()
        assert (await http.post("/plain")).status_code == 200
        release.set()
        assert (await pending).json()["rolledBack"] is True
        stray = await http.get("/sendproof/_preview/stray", headers=ROLLBACK)
        assert stray.status_code == 409 and "preference-applied" not in stray.headers
        assert stray.json()["store"] == "redis"
    assert await async_client.get(prefix + "stray") is None and await async_client.get(prefix + "plain") is not None
    await async_client.aclose()


@needs("mongodb")
async def test_sync_mongo_in_a_thread_pool_endpoint_rolls_back(tmp_path):
    name = fresh()
    mongo = new_mongo()
    store = mongo_store(mongo)
    documents = store.client[name]["documents"]

    def setup(app):
        @app.post("/documents", status_code=201)
        @preview
        def create(body: dict):  # ``def``: run_in_threadpool must carry the Preview's context
            documents.insert_one({"_id": body["id"]})
            return {"id": body["id"]}

    app, _ = make(tmp_path, stores=[store], sql=False, setup=setup)
    async with client(app) as http:
        envelope = (await http.post("/sendproof/_preview/documents", json={"id": "t1"}, headers=ROLLBACK)).json()
        assert [c["key"] for c in envelope["changes"]] == [{"_id": "t1"}]
    assert documents.find_one({"_id": "t1"}) is None
    mongo.drop_database(name)
    mongo.close()
