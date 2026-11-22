"""The Elasticsearch and OpenSearch write guard.

* ``opensearch_store`` runs against the compose ``opensearch`` service
  (``docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait opensearch``),
  with an independent, unhooked client reading the index back, so a passing check proves the refused
  request never reached OpenSearch.
* ``elasticsearch_store`` has no compose service (batch two proves OpenSearch against a real server);
  the ``elasticsearch`` 8 client runs over a stand-in node that records what it is sent.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest

pytest.importorskip("opensearchpy")
pytest.importorskip("elasticsearch")
from elastic_transport import ApiResponseMeta, AsyncTransport, BaseAsyncNode, BaseNode, HttpHeaders, Transport  # noqa: E402
from elastic_transport._node._base import NodeApiResponse  # noqa: E402
from elasticsearch import AsyncElasticsearch, Elasticsearch  # noqa: E402
from opensearchpy import AsyncOpenSearch, OpenSearch  # noqa: E402
from opensearchpy import Transport as OpenSearchTransport  # noqa: E402

from sendproof_core import detached  # noqa: E402
from sendproof_core.stores import PreviewWriteBlocked, elasticsearch_store, opensearch_store  # noqa: E402
from store_support import OPENSEARCH_URL, active, db_entries, needs, observed_scope, opensearch_index, preview_scope  # noqa: E402


# ------------------------------------------------------------------ OpenSearch, against the service
@pytest.fixture
def articles():
    """``(plain client, index)``: the index holds the article ``seeded`` (title ``Seeded``, 3 views)."""
    with opensearch_index() as (client, index):
        client.index(index, {"title": "Seeded", "views": 3}, id="seeded", refresh=True)
        yield client, index


def stored(plain: OpenSearch, index: str, identifier: str) -> Any:
    reply = plain.get(index, identifier, ignore=404)
    return reply["_source"] if reply.get("found") else None


@needs("opensearch")
def test_reads_run_and_every_write_is_refused_before_it_is_sent(articles):
    plain, index = articles
    client = OpenSearch(OPENSEARCH_URL)
    store = opensearch_store(client, name="search")
    with active(preview_scope()) as scope:
        found = client.search(index=index, body={"query": {"ids": {"values": ["seeded"]}}, "size": 1})  # a read sent as POST
        assert found["hits"]["hits"][0]["_source"]["title"] == "Seeded"
        assert client.get(index, "seeded")["found"] and client.count(index=index)["count"] == 1
        assert client.mget(index=index, body={"ids": ["seeded"]})["docs"][0]["found"]
        assert client.msearch(body=[{"index": index}, {"query": {"match_all": {}}}])["responses"]
        for refuse, operation in (
            (lambda: client.update(index, "x", {"doc": {"title": "X"}, "doc_as_upsert": True}), "update"),
            (lambda: client.index(index, {"title": "N"}, id="n"), "index"),
            (lambda: client.create(index, "c", {"title": "C"}), "create"),
            (lambda: client.delete(index, "seeded"), "delete"),
            (lambda: client.bulk([{"index": {"_index": index, "_id": "b"}}, {"title": "B"}]), "bulk"),
            (lambda: client.update_by_query(index, body={"query": {"match_none": {}}}), "update_by_query"),
            (lambda: client.delete_by_query(index, body={"query": {"match_all": {}}}), "delete_by_query"),
            (lambda: client.reindex({"source": {"index": index}, "dest": {"index": index + "-copy"}}), "reindex"),
            (lambda: client.indices.put_mapping(index, {"properties": {"extra": {"type": "keyword"}}}), "indices.put_mapping"),
            (lambda: client.indices.put_alias(index, "alias-x"), "indices.put_alias"),
            (lambda: client.indices.delete(index), "indices.delete"),
            (lambda: client.indices.create(index + "-new"), "indices.create"),
            (lambda: client.transport.perform_request("POST", "/_plugins/_sql", body={"query": "DELETE FROM " + index}), "sql.query"),
        ):
            with pytest.raises(PreviewWriteBlocked) as blocked:
                refuse()
            assert (blocked.value.store, blocked.value.operation) == ("opensearch", operation)
        assert scope.capture.blocked["operation"] == "update"  # the first block wins
        assert db_entries(scope, "opensearch", "search")
    plain.indices.refresh(index)
    assert stored(plain, index, "seeded") == {"title": "Seeded", "views": 3}
    for missing in ("x", "n", "c", "b"):
        assert stored(plain, index, missing) is None
    assert not plain.indices.exists(index + "-new") and not plain.indices.exists_alias(name="alias-x")
    assert store.describe() == {"system": "opensearch", "name": "search", "mode": "guard"}
    client.close()


@needs("opensearch")
def test_reads_become_db_entries_without_values_and_session_handles_are_not_logged(articles):
    plain, index = articles
    client = OpenSearch(OPENSEARCH_URL)
    opensearch_store(client)
    scope = preview_scope()
    with active(scope):
        client.search(index=index, body={"query": {"ids": {"values": ["seeded"]}}, "size": 1})
        reply = client.search(index=index, params={"scroll": "1m"}, body={"query": {"match_all": {}}})
        client.scroll(body={"scroll_id": reply["_scroll_id"], "scroll": "1m"})
        client.clear_scroll(body={"scroll_id": reply["_scroll_id"]})
        client.transport.perform_request("POST", f"/{index}/_search/point_in_time", params={"keep_alive": "1m"})  # opens a PIT
    entries = db_entries(scope, "opensearch")
    first = entries[0]["db"]
    assert (first["operation"], first["target"], first["rowsAffected"]) == ("search", index, 1)
    assert "seeded" not in first["statement"] and "ids" in first["statement"]
    logged = [entry["db"]["operation"] for entry in entries]
    assert logged.count("scroll") == 1 and "clear_scroll" not in logged and "create_pit" not in logged
    client.close()


@needs("opensearch")
def test_outside_a_preview_writes_run_and_observed_sends_are_logged(articles):
    plain, index = articles
    client = OpenSearch(OPENSEARCH_URL)
    opensearch_store(client)
    client.index(index, {"title": "Plain", "views": 1}, id="plain", refresh=True)
    scope = observed_scope()
    with active(scope):
        client.update(index, "sent", {"script": {"source": "ctx._source.views += params.step", "params": {"step": 1}},
                                       "upsert": {"title": "Untitled", "views": 1}}, params={"refresh": "true"})
    assert stored(plain, index, "plain")["views"] == 1 and stored(plain, index, "sent")["title"] == "Untitled"
    entry = db_entries(scope, "opensearch", "update")[0]["db"]
    assert entry["target"] == index and "Untitled" not in entry["statement"] and "ctx" not in entry["statement"]
    client.close()


@needs("opensearch")
def test_a_derived_transport_and_a_second_hook_are_covered_or_refused(articles):
    plain, index = articles
    client = OpenSearch(OPENSEARCH_URL)
    opensearch_store(client)
    with pytest.raises(TypeError, match="already hooked"):
        opensearch_store(client)
    with pytest.raises(TypeError):
        elasticsearch_store(client)  # an opensearch-py client belongs to opensearch_store
    store = opensearch_store(name="search")  # a client built later, with the guarded transport class
    built_after = OpenSearch(OPENSEARCH_URL, transport_class=store.guard_transport_class(OpenSearchTransport))
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            built_after.delete(index, "seeded")
    assert stored(plain, index, "seeded") is not None
    client.close()
    built_after.close()


@needs("opensearch")
def test_the_async_client_is_guarded(articles):
    plain, index = articles

    async def run() -> None:
        client = AsyncOpenSearch(OPENSEARCH_URL)
        opensearch_store(client, name="search")
        with active(preview_scope()) as scope:
            assert (await client.get(index, "seeded"))["found"]
            assert (await client.search(index=index, body={"query": {"match_all": {}}}))["hits"]["hits"]
            for refuse in (lambda: client.delete(index, "seeded"), lambda: client.index(index, {"a": 1}, id="a"),
                           lambda: client.update_by_query(index, body={"query": {"match_all": {}}})):
                with pytest.raises(PreviewWriteBlocked):
                    await refuse()
            assert scope.capture.blocked["operation"] == "delete"
        await client.close()

    asyncio.run(run())
    assert stored(plain, index, "seeded") == {"title": "Seeded", "views": 3} and stored(plain, index, "a") is None


@needs("opensearch")
def test_a_write_no_request_accounts_for_is_refused_before_it_is_sent(articles):
    """A thread started without the request's context, or ``helpers.parallel_bulk``'s own thread pool,
    carries no request: while a Preview is open the write is refused before sending and every open
    Preview is blocked."""
    from opensearchpy import helpers

    plain, index = articles
    client = OpenSearch(OPENSEARCH_URL)
    opensearch_store(client)
    refused: list = []

    def in_thread(body):
        def run() -> None:
            try:
                body()
            except PreviewWriteBlocked as error:
                refused.append(error.operation)
        thread = threading.Thread(target=run)
        thread.start()
        thread.join()

    with active(preview_scope()) as scope, active(preview_scope()) as other:
        in_thread(lambda: client.index(index, {"title": "T"}, id="thread"))
        assert refused == ["index"]
        assert scope.capture.blocked["operation"] == other.capture.blocked["operation"] == "index"
    with active(preview_scope()) as scope:
        with pytest.raises(PreviewWriteBlocked):
            for _ in helpers.parallel_bulk(client, [{"_index": index, "_id": "pb", "title": "P"}], thread_count=2):
                pass
        assert scope.capture.blocked["operation"] == "bulk"
    plain.indices.refresh(index)
    assert stored(plain, index, "thread") is None and stored(plain, index, "pb") is None
    with active(preview_scope()) as scope:
        def marked() -> None:
            with detached():
                client.index(index, {"title": "T"}, id="thread2", params={"refresh": "true"})
        in_thread(marked)
        assert scope.capture.fault is None and scope.capture.blocked is None
    assert stored(plain, index, "thread2") is not None
    client.close()


@needs("opensearch")
def test_the_bulk_helpers_are_refused_before_anything_is_sent(articles):
    from opensearchpy import helpers

    plain, index = articles
    client = OpenSearch(OPENSEARCH_URL)
    opensearch_store(client)
    with active(preview_scope()):
        for refuse in (
            lambda: helpers.bulk(client, [{"_index": index, "_id": "hb", "title": "H"}]),
            lambda: list(helpers.streaming_bulk(client, [{"_index": index, "_id": "sb", "title": "S"}])),
            lambda: helpers.reindex(client, index, index + "-copy"),
        ):
            with pytest.raises(PreviewWriteBlocked):
                refuse()
        assert [hit["_id"] for hit in helpers.scan(client, index=index, query={"query": {"match_all": {}}})] == ["seeded"]
    plain.indices.refresh(index)
    assert stored(plain, index, "hb") is None and stored(plain, index, "sb") is None and not plain.indices.exists(index + "-copy")
    client.close()


@needs("opensearch")
def test_without_the_hook_the_same_write_lands(articles):
    """The control for the tests above: an unhooked client in a Preview scope writes for real."""
    plain, index = articles
    with active(preview_scope()):
        plain.delete(index, "seeded", params={"refresh": "true"})
    assert stored(plain, index, "seeded") is None


# ------------------------------------------------------------------ Elasticsearch, over a stand-in node
HEADERS = HttpHeaders({"content-type": "application/json", "x-elastic-product": "Elasticsearch"})
REPLY = b'{"hits": {"hits": [{"_id": "1"}, {"_id": "2"}]}, "updated": 2, "errors": false, "items": []}'


class FakeNode(BaseNode):
    """An ``elastic_transport`` node that answers every request like an Elasticsearch 8 node and remembers it.

    It sits below the client's whole request path: the typed API, the compatibility ``accept`` header
    and the product check on every reply (``x-elastic-product``), so a write that slips past the
    guard reaches ``seen`` exactly as it would reach a real node.
    """

    seen: list[tuple[str, str]] = []
    sent_headers: list[Any] = []

    def perform_request(self, method, target, body=None, headers=None, request_timeout=None):
        FakeNode.seen.append((method, target.split("?")[0]))
        FakeNode.sent_headers.append(headers)
        return NodeApiResponse(ApiResponseMeta(status=200, http_version="1.1", headers=HEADERS, duration=0.0, node=self.config), REPLY)

    def close(self) -> None:
        pass


class FakeAsyncNode(BaseAsyncNode):
    async def perform_request(self, method, target, body=None, headers=None, request_timeout=None):
        FakeNode.seen.append((method, target.split("?")[0]))
        return NodeApiResponse(ApiResponseMeta(status=200, http_version="1.1", headers=HEADERS, duration=0.0, node=self.config), REPLY)

    async def close(self) -> None:
        pass


@pytest.fixture
def node():
    FakeNode.seen = []
    FakeNode.sent_headers = []
    return FakeNode.seen


def test_the_stand_in_node_sees_the_real_clients_requests_and_an_unhooked_write_reaches_it(node):
    """The control for the stand-in node: without the hook the same typed writes arrive, sent the way
    the client sends them to a real node (compatibility headers on, product check passed)."""
    from elasticsearch import UnsupportedProductError, helpers

    client = Elasticsearch("http://es.invalid:9200", node_class=FakeNode)
    with active(preview_scope()):
        client.index(index="a", id="1", document={"t": 1})
        client.delete(index="a", id="1")
        helpers.bulk(client, [{"_index": "a", "_id": "b", "t": 1}])
    assert node == [("PUT", "/a/_doc/1"), ("DELETE", "/a/_doc/1"), ("PUT", "/_bulk")]
    assert all("compatible-with=8" in str(headers.get("accept")) for headers in FakeNode.sent_headers)
    # The client checks the product of every reply: a node that isn't Elasticsearch is refused, so the
    # stand-in's answers pass through the same check as a real node's.
    plain = HttpHeaders({"content-type": "application/json"})

    class NotElasticsearch(FakeNode):
        def perform_request(self, method, target, body=None, headers=None, request_timeout=None):
            return NodeApiResponse(ApiResponseMeta(status=200, http_version="1.1", headers=plain, duration=0.0, node=self.config), REPLY)

    with pytest.raises(UnsupportedProductError):
        Elasticsearch("http://es.invalid:9200", node_class=NotElasticsearch).search(index="a")


def test_the_elasticsearch_bulk_helpers_and_their_threads_are_refused_before_sending(node):
    from elasticsearch import helpers

    import time

    client = Elasticsearch("http://es.invalid:9200", node_class=FakeNode)
    elasticsearch_store(client)
    began = time.monotonic()
    with active(preview_scope()) as scope, active(preview_scope()) as other:
        for refuse in (
            lambda: helpers.bulk(client, [{"_index": "a", "_id": "b", "t": 1}]),
            lambda: list(helpers.streaming_bulk(client, [{"_index": "a", "_id": "s", "t": 1}])),
            lambda: list(helpers.parallel_bulk(client, [{"_index": "a", "_id": "p", "t": 1}], thread_count=2)),
            # The helpers retry only answers the node sent (429), never a refusal: a retried refusal
            # would wait out this backoff, and the timing check below would fail.
            lambda: list(helpers.streaming_bulk(client, [{"_index": "a", "_id": "r", "t": 1}], max_retries=5, initial_backoff=30)),
        ):
            with pytest.raises(PreviewWriteBlocked) as blocked:
                refuse()
            assert blocked.value.operation == "bulk"
        assert scope.capture.blocked["operation"] == "bulk"
        assert other.capture.blocked["operation"] == "bulk"  # parallel_bulk's pool threads carry no request
    assert [seen for seen in node if seen[0] != "GET"] == [] and time.monotonic() - began < 10


def test_elasticsearch_client_reads_run_and_writes_never_reach_the_node(node):
    client = Elasticsearch("http://es.invalid:9200", node_class=FakeNode)
    store = elasticsearch_store(client, name="search")
    with active(preview_scope()) as scope:
        assert len(client.search(index="a", query={"match_all": {}})["hits"]["hits"]) == 2
        client.count(index="a")
        assert node == [("POST", "/a/_search"), ("POST", "/a/_count")] or node == [("GET", "/a/_search"), ("POST", "/a/_count")] or len(node) == 2
        node.clear()
        for refuse, operation in (
            (lambda: client.index(index="a", id="1", document={"t": 1}), "index"),
            (lambda: client.delete(index="a", id="1"), "delete"),
            (lambda: client.bulk(operations=[{"index": {"_index": "a"}}, {"t": 1}]), "bulk"),
            (lambda: client.update_by_query(index="a", query={"match_none": {}}), "update_by_query"),
            (lambda: client.indices.create(index="b"), "indices.create"),
            (lambda: client.indices.put_settings(index="a", settings={"refresh_interval": "1s"}), "indices.put_settings"),
        ):
            with pytest.raises(PreviewWriteBlocked) as blocked:
                refuse()
            assert (blocked.value.store, blocked.value.operation) == ("elasticsearch", operation)
        assert node == [] and scope.capture.blocked["operation"] == "index"
        entry = db_entries(scope, "elasticsearch", "search")[0]["db"]
        assert (entry["target"], entry["rowsAffected"]) == ("a", 2)
        assert "match_all" in entry["statement"]
    assert store.describe() == {"system": "elasticsearch", "name": "search", "mode": "guard"}


def test_a_derived_elasticsearch_client_shares_the_guarded_transport(node):
    """``client.options(...)`` returns a new client over the same transport, so it stays guarded."""
    client = Elasticsearch("http://es.invalid:9200", node_class=FakeNode)
    elasticsearch_store(client)
    derived = client.options(request_timeout=3, headers={"x-opaque-id": "1"})
    assert derived is not client and derived.transport is client.transport
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            derived.index(index="a", document={"t": 1})
        assert derived.search(index="a")["hits"]
    assert node == [("POST", "/a/_search")] or len(node) == 1


def test_an_elasticsearch_client_built_with_the_guarded_transport_class_is_guarded_from_its_first_request(node):
    store = elasticsearch_store(name="search")
    client = Elasticsearch("http://es.invalid:9200", node_class=FakeNode, transport_class=store.guard_transport_class(Transport))
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            client.delete(index="a", id="1")
    assert node == []
    with pytest.raises(TypeError, match="already hooked"):
        elasticsearch_store(client)
    with pytest.raises(TypeError):
        opensearch_store(client)
    with pytest.raises(TypeError):
        elasticsearch_store(object())


def test_the_async_elasticsearch_client_is_guarded(node):
    async def run() -> None:
        client = AsyncElasticsearch("http://es.invalid:9200", node_class=FakeAsyncNode)
        elasticsearch_store(client)
        assert isinstance(client.transport, AsyncTransport)
        with active(preview_scope()) as scope:
            assert (await client.search(index="a"))["hits"]
            with pytest.raises(PreviewWriteBlocked):
                await client.index(index="a", document={"t": 1})
            with pytest.raises(PreviewWriteBlocked):
                await client.update_by_query(index="a")
            assert scope.capture.blocked["operation"] == "index"
        await client.close()

    asyncio.run(run())
    assert len(node) == 1


def test_a_write_carrying_an_ended_previews_context_is_still_refused(node):
    """A thread the handler started with its context, or an asyncio task it created, may write after the
    response went out. Its context stays marked as that Preview, so the write is still refused."""
    import contextvars

    from store_support import arun_preview, run_preview, sync_bench

    client = Elasticsearch("http://es.invalid:9200", node_class=FakeNode)
    store = elasticsearch_store(client)
    go, outcome, started = threading.Event(), [], []

    def write_later() -> None:
        go.wait(5)
        try:
            client.index(index="a", document={"t": 1})
            outcome.append("sent")
        except PreviewWriteBlocked:
            outcome.append("refused")

    def handler(scope):
        thread = threading.Thread(target=contextvars.copy_context().run, args=(write_later,))
        thread.start()
        started.append(thread)
        return 200, {}

    assert run_preview(sync_bench(store), handler).status == 200  # the Preview ended before the write
    go.set()
    started[0].join()
    assert outcome == ["refused"] and node == []

    async def run() -> None:
        tasks = []

        async def later() -> None:
            await asyncio.sleep(0.05)
            try:
                await aclient.index(index="a", document={"t": 1})
                outcome.append("sent")
            except PreviewWriteBlocked:
                outcome.append("refused")

        async def ahandler(scope) -> None:
            tasks.append(asyncio.ensure_future(later()))  # a task copies the Preview's context

        aclient = AsyncElasticsearch("http://es.invalid:9200", node_class=FakeAsyncNode)
        astore = elasticsearch_store(aclient)
        scope, error = await arun_preview([astore], ahandler)
        assert error is None and scope.capture.blocked is None
        await tasks[0]
        await aclient.close()

    asyncio.run(run())
    assert outcome == ["refused", "refused"] and node == []


def test_a_refused_write_never_marks_a_node_dead_or_retries_so_the_next_read_is_unaffected(node):
    """The guard refuses in ``Transport.perform_request``, above node selection, mark-dead and retries.
    A refusal at the node level would count as a failed node and take it out of rotation for everyone."""
    from elastic_transport import ConnectionError as NodeConnectionError

    nodes = ["http://es1.invalid:9200", "http://es2.invalid:9200"]
    client = Elasticsearch(nodes, node_class=FakeNode, max_retries=3)
    elasticsearch_store(client)
    pool = client.transport.node_pool
    with active(preview_scope()):
        for _ in range(4):
            with pytest.raises(PreviewWriteBlocked):
                client.index(index="a", document={"t": 1})
    assert node == [] and pool._dead_nodes.empty() and not pool._dead_consecutive_failures
    for _ in range(4):  # ordinary traffic afterwards, on both nodes
        assert client.search(index="a")["hits"]
    assert len(node) == 4 and len({id(n) for n in pool.all()}) == 2 and pool._dead_nodes.empty()

    class Failing(FakeNode):  # the control: a failure the pool does see marks the node dead
        def perform_request(self, *args, **kwargs):
            raise NodeConnectionError("refused at the node")

    failing = Elasticsearch(nodes, node_class=Failing, max_retries=0)
    with pytest.raises(NodeConnectionError):
        failing.search(index="a")
    assert not failing.transport.node_pool._dead_nodes.empty()


@needs("opensearch")
def test_a_refused_opensearch_write_never_marks_a_connection_dead(articles):
    plain, index = articles
    host = OPENSEARCH_URL.replace("127.0.0.1", "localhost")
    client = OpenSearch([OPENSEARCH_URL, host], max_retries=3)
    opensearch_store(client)
    pool = client.transport.connection_pool
    with active(preview_scope()):
        for _ in range(4):
            with pytest.raises(PreviewWriteBlocked):
                client.index(index, {"title": "N"}, id="n")
    assert pool.dead.empty() and pool.dead_count == {} and len(pool.connections) == 2
    for _ in range(4):
        assert client.get(index, "seeded")["found"]
    assert pool.dead.empty() and stored(plain, index, "n") is None
    client.close()


def test_host_declared_reads_let_an_unlisted_post_through(node):
    client = Elasticsearch("http://es.invalid:9200", node_class=FakeNode)
    elasticsearch_store(client, treat_as_read=["POST /{}/_refresh"])
    with active(preview_scope()):
        client.perform_request("POST", "/a/_refresh", headers={"accept": "application/json"})
        with pytest.raises(PreviewWriteBlocked):
            client.perform_request("POST", "/a/_forcemerge", headers={"accept": "application/json"})
    assert node == [("POST", "/a/_refresh")]
