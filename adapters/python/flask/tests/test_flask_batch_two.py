"""Batch-two data stores in the Flask adapter, with no service: a guard-only Elasticsearch store over a stand-in
node, in the Preview pipeline without a SQL provider (the hooks are covered in ``core/tests``)."""

from __future__ import annotations

import pytest
from flask import Flask, jsonify

pytest.importorskip("elasticsearch")
from elastic_transport import ApiResponseMeta, BaseNode, HttpHeaders  # noqa: E402
from elastic_transport._node._base import NodeApiResponse  # noqa: E402
from elasticsearch import Elasticsearch  # noqa: E402

from sendproof_core.stores import PreviewWriteBlocked, elasticsearch_store  # noqa: E402
from sendproof_flask import Identity, Sendproof, preview  # noqa: E402

ROLLBACK = {"Prefer": "tx=rollback"}


class Node(BaseNode):
    """Answers every request like Elasticsearch and remembers it."""

    seen: list[tuple[str, str]] = []

    def perform_request(self, method, target, body=None, headers=None, request_timeout=None):
        Node.seen.append((method, target.split("?")[0]))
        headers = HttpHeaders({"content-type": "application/json", "x-elastic-product": "Elasticsearch"})
        return NodeApiResponse(ApiResponseMeta(status=200, http_version="1.1", headers=headers, duration=0.0, node=self.config),
                               b'{"hits": {"hits": [{"_id": "1", "_source": {"title": "t"}}]}}')

    def close(self) -> None:
        pass


@pytest.fixture
def app():
    Node.seen = []
    client = Elasticsearch("http://es.invalid:9200", node_class=Node)
    store = elasticsearch_store(client, name="search")
    app = Flask(__name__)

    @app.get("/articles")
    @preview(methods=["GET"])
    def read():
        return jsonify(hits=len(client.search(index="articles")["hits"]["hits"]))

    @app.post("/articles/<id>")
    @preview
    def write(id: str):
        client.index(index="articles", id=id, document={"title": "x"})
        return jsonify(id=id), 201

    @app.post("/swallow")
    @preview
    def swallow():
        try:
            client.indices.delete(index="articles")
        except PreviewWriteBlocked:
            pass
        return jsonify(ok=True)

    @app.delete("/articles")
    @preview(False, stores=["elasticsearch"])
    def delete():
        client.indices.delete(index="articles")
        return "", 204

    Sendproof(app, data_stores=[store], environment="Development", identity=lambda req: Identity("Alex", "admin", "alex", "test"))
    return app


def test_discovery_and_a_read_in_a_preview(app):
    http = app.test_client()
    caps = http.get("/sendproof/_api/capabilities").get_json()
    assert caps["dataStores"] == [{"system": "elasticsearch", "name": "search", "mode": "guard"}]
    assert caps["previewUnavailable"][0]["reason"] == "Preview unavailable: this operation writes to Elasticsearch"
    read = http.get("/sendproof/_preview/articles", headers=ROLLBACK)
    assert read.status_code == 200, read.get_data(as_text=True)
    assert [log["db"]["operation"] for log in read.get_json()["logs"] if log["level"] == "Db"] == ["search"]
    assert Node.seen == [("POST", "/articles/_search")] or len(Node.seen) == 1


def test_a_write_answers_409_before_it_is_sent_even_when_the_handler_swallows_the_error(app):
    http = app.test_client()
    for path, operation in (("/sendproof/_preview/articles/a1", "index"), ("/sendproof/_preview/swallow", "indices.delete")):
        refused = http.post(path, headers=ROLLBACK)
        body = refused.get_json()
        assert refused.status_code == 409 and "Preference-Applied" not in refused.headers
        assert (body["store"], body["operation"], body["code"]) == ("elasticsearch", operation, "preview_unavailable")
    assert Node.seen == []
