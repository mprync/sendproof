"""Batch-two data stores in the FastAPI adapter, with no service: a guard-only Cosmos DB store over a stand-in
asynchronous azure-core transport, in the Preview pipeline without a SQL provider (see ``core/tests/test_batch_two.py``
for classification and ``test_cosmos_store.py`` for the hook)."""

from __future__ import annotations

import threading

import httpx
import pytest
from fastapi import FastAPI

pytest.importorskip("azure.core")
from azure.core.pipeline.transport import HttpRequest  # noqa: E402

from sendproof_core.stores import PreviewWriteBlocked, cosmosdb_store  # noqa: E402
from sendproof_fastapi import Identity, Sendproof, preview  # noqa: E402

ROLLBACK = {"Prefer": "tx=rollback"}
URL = "https://acct.documents.azure.com:443/dbs/shop/colls/orders/docs"


class Reply:
    status_code = 200
    headers = {"x-ms-item-count": "1"}


class Account:
    """A stand-in for the asynchronous transport of a ``CosmosClient``: remembers what reaches it."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    async def send(self, request, **kwargs):
        self.sent.append((request.method, request.url))
        return Reply()


def build(store, transport, *, extra=None):
    app = FastAPI(title="Orders")

    @app.get("/orders/{id}")
    @preview
    async def read(id: str):
        await transport.send(HttpRequest("GET", f"{URL}/{id}"))
        return {"id": id}

    @app.post("/orders/{id}")
    @preview
    async def upsert(id: str):
        await transport.send(HttpRequest("POST", URL, headers={"x-ms-documentdb-is-upsert": "True"}))
        return {"id": id}

    @app.post("/swallow")
    @preview
    async def swallow():
        try:
            await transport.send(HttpRequest("POST", URL, headers={"x-ms-documentdb-is-upsert": "True"}))
        except PreviewWriteBlocked:
            pass
        return {"ok": True}

    @app.post("/stray")
    @preview
    async def stray():
        thread = threading.Thread(target=lambda: __import__("asyncio").run(transport.send(HttpRequest("POST", URL))))
        thread.start()
        thread.join()
        return {"ok": True}

    @app.delete("/orders/{id}")
    @preview(False, stores=["cosmosdb"])
    async def delete(id: str):
        await transport.send(HttpRequest("DELETE", f"{URL}/{id}"))

    Sendproof(app, provider=None, data_stores=[store], environment="Development",
              identity=lambda request: Identity("Alex", "admin", "alex", "test"))
    return app


@pytest.fixture
def setup():
    transport = Account()
    store = cosmosdb_store(name="orders")
    store.guard_transport(transport)
    app = build(store, transport)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test"), transport


async def test_discovery_lists_the_store_and_marks_the_unavailable_operation(setup):
    http, _ = setup
    async with http:
        caps = (await http.get("/sendproof/_api/capabilities")).json()
        assert caps["dataStores"] == [{"system": "cosmosdb", "name": "orders", "mode": "guard"}]
        assert caps["previewUnavailable"] == [{"method": "DELETE", "path": "/orders/{id}", "stores": ["cosmosdb"],
                                               "reason": "Preview unavailable: this operation writes to Cosmos DB"}]


async def test_a_read_runs_and_a_write_answers_409_before_it_is_sent(setup):
    http, account = setup
    async with http:
        read = await http.get("/sendproof/_preview/orders/o1", headers=ROLLBACK)
        assert read.status_code == 200 and account.sent == [("GET", f"{URL}/o1")]
        assert [log["db"]["operation"] for log in read.json()["logs"] if log["level"] == "Db"] == ["Read"]
        account.sent.clear()
        for path in ("/sendproof/_preview/orders/o1", "/sendproof/_preview/swallow"):  # the second handler catches the error
            refused = await http.post(path, headers=ROLLBACK)
            assert refused.status_code == 409 and "preference-applied" not in refused.headers
            body = refused.json()
            assert (body["code"], body["store"], body["operation"], body["rolledBack"]) == ("preview_unavailable", "cosmosdb", "Upsert", False)
            assert body["detail"] == "Preview unavailable: this operation writes to Cosmos DB"
        assert account.sent == []


async def test_a_write_from_a_thread_with_no_request_fails_the_preview(setup):
    http, account = setup
    async with http:
        failed = await http.post("/sendproof/_preview/stray", headers=ROLLBACK)
        assert failed.status_code == 500 and "preference-applied" not in failed.headers
