"""Batch-two classification: the embedded tables and every shared vector for Cassandra, Elasticsearch
and OpenSearch, Cosmos DB and Firestore (``spec/data-stores/``). These tests need no service."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sendproof_core.stores import (
    classify_cassandra,
    classify_cassandra_message,
    classify_cosmos,
    classify_elasticsearch,
    classify_firestore,
    firestore_rpc,
    write_reason,
)
from sendproof_core.stores import tables
from sendproof_core.stores.classify_batch_two import cosmos_operation, statement_shape
from sendproof_core.stores.cassandra_hook import cql_target, sanitize_cql
from sendproof_core.stores.cosmos_hook import sanitize_cosmos_sql
from sendproof_core.stores.elasticsearch_hook import sanitize_body

SPEC = Path(__file__).resolve().parents[4] / "spec" / "data-stores"
CASES = json.loads((SPEC / "classification-cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("store", ["cassandra", "elasticsearch", "cosmosdb", "firestore"])
def test_embedded_batch_two_tables_match_spec(store):
    """Fails when ``stores/tables.py`` differs from spec/data-stores/: run scripts/embed_store_tables.py."""
    spec = json.loads((SPEC / f"{store}.json").read_text(encoding="utf-8"))
    assert getattr(tables, f"{store.upper()}_TABLE") == spec


def label(case: dict) -> str:
    return json.dumps({key: value for key, value in case.items() if key not in ("expect", "operation")})[:70]


@pytest.mark.parametrize("case", CASES["cassandra"], ids=label)
def test_cassandra_classifier_passes_every_shared_vector(case):
    if "message" in case:
        verdict = classify_cassandra_message(case["message"], case.get("statement"), case.get("prepared"))
    else:
        verdict = classify_cassandra(case["statement"])
    assert (verdict.kind, verdict.operation) == (case["expect"], case["operation"])


@pytest.mark.parametrize("case", CASES["elasticsearch"], ids=label)
def test_elasticsearch_classifier_passes_every_shared_vector(case):
    verdict = classify_elasticsearch(case["method"], case["path"], case.get("body"))
    assert (verdict.kind, verdict.operation) == (case["expect"], case["operation"])


@pytest.mark.parametrize("case", CASES["cosmosdb"], ids=label)
def test_cosmosdb_classifier_passes_every_shared_vector(case):
    if "request" in case:
        verdict = classify_cosmos(request=case["request"])
    else:
        verdict = classify_cosmos(case["operationType"], triggers=case.get("triggers", False))
    assert (verdict.kind, verdict.operation) == (case["expect"], case["operation"])


@pytest.mark.parametrize("case", CASES["firestore"], ids=label)
def test_firestore_classifier_passes_every_shared_vector(case):
    if "rest" in case:
        verdict = classify_firestore(firestore_rpc(case["rest"]["method"], case["rest"]["path"]), case["rest"].get("body"))
    else:
        verdict = classify_firestore(case["rpc"], case.get("message"))
    assert (verdict.kind, verdict.operation) == (case["expect"], case["operation"])


def test_the_shared_cases_cover_reads_writes_and_session_calls_of_every_store():
    for store in ("cassandra", "elasticsearch", "cosmosdb", "firestore"):
        kinds = {case["expect"] for case in CASES[store]}
        assert {"read", "write"} <= kinds, store
    assert "session" in {case["expect"] for case in CASES["firestore"]}


def test_reasons_use_each_stores_display_name():
    assert write_reason("cassandra") == "Preview unavailable: this operation writes to Cassandra"
    assert write_reason("cosmosdb").endswith("Cosmos DB")
    assert write_reason("opensearch").endswith("OpenSearch") and write_reason("elasticsearch").endswith("Elasticsearch")
    assert write_reason("firestore").endswith("Firestore")


# ------------------------------------------------------------------ Cassandra
def test_cassandra_text_the_hook_cannot_read_is_a_write():
    for text in (None, "", "   ", "-- only a comment", "SELECT 'open", "SELECT $$open", "/* open", "SELECT 1; SELECT 2", "\x00"):
        assert classify_cassandra(text).kind == "write", text
    assert classify_cassandra("SELECT 1;  -- done\n").kind == "read"
    assert classify_cassandra("select * from t;;").kind == "write"  # the empty second statement is still text after a semicolon


def test_cassandra_host_declared_reads_match_exact_keys_only_and_still_need_one_statement():
    reads = frozenset({"LIST ROLES", "MYSTMT"})
    assert classify_cassandra("LIST ROLES", treat_as_read=reads).kind == "read"
    assert classify_cassandra("mystmt x", treat_as_read=reads).kind == "read"
    assert classify_cassandra("mystmt x; DELETE FROM t", treat_as_read=reads).kind == "write"
    assert classify_cassandra("MYSTMTX x", treat_as_read=reads).kind == "write"


def test_cassandra_statements_lose_their_literals_and_comments():
    cql = "INSERT INTO ks.tickets (id, \"Status\", hits) VALUES ('a;b', $$c$$, -4.5e3) -- secret\nIF NOT EXISTS"
    clean = sanitize_cql(cql)
    for literal in ("a;b", "$$", "4.5", "secret"):
        assert literal not in clean
    assert '"Status"' in clean and "tickets" in clean
    assert sanitize_cql("SELECT * FROM t1 WHERE id = 123e4567-e89b-12d3-a456-426614174000 AND k = 0xCAFE AND n = 42") == \
        "SELECT * FROM t1 WHERE id = ? AND k = ? AND n = ?"
    assert cql_target(clean) == ("ks", "tickets")
    assert cql_target("SELECT a, b FROM \"My Table\" WHERE x = ?") == (None, "My Table")
    assert cql_target("UPDATE t SET a = ? WHERE id = ?") == (None, "t")
    assert cql_target("DELETE FROM t WHERE id = ?") == (None, "t")
    assert cql_target("TRUNCATE TABLE t") == (None, "t")
    assert cql_target("DESCRIBE TABLES") == (None, None)


def test_statement_shape_reads_quotes_and_comments_like_the_server():
    assert statement_shape("SELECT 'a;b' ; ", dollar=True).multiple is False
    assert statement_shape("SELECT \"a;b\" FROM t; SELECT 1").multiple is True
    assert statement_shape("-- c\n  select x", slash_comments=True).first == "SELECT"
    assert statement_shape("list all permissions").second == "ALL"
    assert statement_shape("SELECT `a").broken is False  # backticks are quotes only in the SQL dialects
    assert statement_shape("SELECT `a", backticks=True).broken is True


# ------------------------------------------------------------------ Elasticsearch and OpenSearch
def test_elasticsearch_paths_match_after_decoding_and_normalising():
    assert classify_elasticsearch("POST", "//a//_search/").operation == "search"
    assert classify_elasticsearch("POST", "/a/%5Fsearch").operation == "search"
    assert classify_elasticsearch("post", "/a,b*/_count?x=1").kind == "read"
    assert classify_elasticsearch("POST", "/_x/_search").kind == "write"  # an index never starts with an underscore
    assert classify_elasticsearch(b"GET", b"/_cluster/health").kind == "read"


def test_elasticsearch_sql_endpoints_read_only_for_one_select_show_or_describe():
    sql = lambda body, path="/_sql": classify_elasticsearch("POST", path, body).kind  # noqa: E731
    assert sql({"query": "SELECT 1"}) == "read" and sql(b'{"query": "show tables"}') == "read"
    assert sql({"query": "SELECT 'a;b'"}) == "read"
    assert sql({"query": "SELECT 1; SELECT 2"}) == "write" and sql({"query": "DELETE FROM x"}, "/_plugins/_sql") == "write"
    assert sql({"cursor": "c"}) == "read" and sql({"cursor": "c", "query": "SELECT 1"}) == "read"
    assert sql({"cursor": 5}) == "write" and sql(None) == "write" and sql([1]) == "write" and sql("{") == "write"
    assert sql({"query": "SELECT `x"}) == "write"


def test_elasticsearch_host_declared_reads_name_unlisted_endpoints():
    reads = frozenset({"POST /{}/_refresh"})
    assert classify_elasticsearch("POST", "/a/_refresh").kind == "write"
    assert classify_elasticsearch("POST", "/a/_refresh", treat_as_read=reads).kind == "read"
    assert classify_elasticsearch("POST", "/a/_bulk", treat_as_read=reads).kind == "write"


def test_request_bodies_become_statements_without_values():
    assert sanitize_body(None) is None and sanitize_body("") is None
    assert sanitize_body({"query": {"ids": {"values": ["seeded"]}}, "size": 1}) == '{"query":{"ids":{"values":["?"]}},"size":"?"}'
    bulk = sanitize_body([{"index": {"_id": "secret"}}, {"title": "secret"}])
    assert "secret" not in bulk and "title" in bulk
    ndjson = sanitize_body(b'{"index":"a"}\n{"query":{"match":{"t":"secret"}}}\n')
    assert "secret" not in ndjson and ndjson.count("\n") == 1
    assert sanitize_body("not json") == "?"
    assert sanitize_body(object()) == '"?"'


# ------------------------------------------------------------------ Cosmos DB
def test_cosmos_triggers_make_any_operation_a_write_and_names_compare_case_insensitively():
    assert classify_cosmos("QUERY").operation == "Query" and classify_cosmos("query").kind == "read"
    request = {"method": "GET", "path": "/dbs/d/colls/c/docs/i", "headers": {"X-MS-DOCUMENTDB-POST-TRIGGER-INCLUDE": "t"}}
    assert classify_cosmos(request=request).kind == "write"
    assert classify_cosmos("Read", triggers=True).kind == "write"
    assert classify_cosmos("Execute", treat_as_read=frozenset({"Execute"})).kind == "read"
    assert classify_cosmos("Execute", triggers=True, treat_as_read=frozenset({"Execute"})).kind == "write"
    assert classify_cosmos(request={"method": "TRACE", "path": "/", "headers": {}}).operation == "TRACE"


def test_cosmos_operation_is_derived_from_method_path_and_headers():
    assert cosmos_operation("POST", "/dbs/d/colls/c/docs", {"x-ms-documentdb-isquery": "true"}) == "Query"
    assert cosmos_operation("POST", "/dbs/d/colls/c/sprocs/p", {}) == "ExecuteJavaScript"
    assert cosmos_operation("POST", "/dbs/d/colls/c/sprocs", {}) == "Create"
    assert cosmos_operation("GET", "/", {}) == "ReadFeed" and cosmos_operation("HEAD", "/dbs/d", {}) == "Head"


def test_cosmos_query_text_loses_its_literals():
    assert sanitize_cosmos_sql("SELECT * FROM c WHERE c.status = 'open' AND c.n > 5.5 AND c.s = \"x\" AND c.id = @id") == \
        "SELECT * FROM c WHERE c.status = ? AND c.n > ? AND c.s = ? AND c.id = @id"
    assert sanitize_cosmos_sql("SELECT c.a1 FROM c WHERE c.k = 'it\\'s'") == "SELECT c.a1 FROM c WHERE c.k = ?"


# ------------------------------------------------------------------ Firestore
def test_firestore_commit_without_a_readable_message_is_a_write():
    commit = "/google.firestore.v1.Firestore/Commit"
    assert classify_firestore(commit).kind == "write"
    assert classify_firestore(commit, object()).kind == "write"
    assert classify_firestore(commit, {"writes": [{}]}).kind == "write"
    assert classify_firestore(commit, {"writes": []}).kind == "session"
    assert classify_firestore(commit, {"writes": 5}).kind == "write"


def test_firestore_methods_of_other_services_and_versions_are_writes():
    assert classify_firestore("/google.firestore.v1beta1.Firestore/GetDocument").kind == "write"
    assert classify_firestore("/google.firestore.admin.v1.FirestoreAdmin/GetIndex").kind == "read"
    assert classify_firestore("/google.firestore.admin.v1.FirestoreAdmin/DeleteIndex").kind == "write"
    assert classify_firestore("/google.firestore.v1.Firestore/ExecutePipeline").kind == "write"
    assert classify_firestore("/google.firestore.v1.Firestore/ExecutePipeline", treat_as_read=frozenset({"ExecutePipeline"})).kind == "read"
    assert classify_firestore(b"/google.firestore.v1.Firestore/Listen").kind == "read"
    assert classify_firestore("").kind == "write"


# ------------------------------------------------------------------ pinned client versions
def test_the_pinned_client_versions_match_the_package_metadata_and_the_installed_clients():
    """The hooks that rely on private internals refuse unverified versions; the extras say the same range,
    and the installed clients the tests ran against are inside it."""
    import re

    from sendproof_core.stores import versions

    metadata = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    for distribution, (lowest, beyond) in versions.SUPPORTED.items():
        assert re.search(rf'"{re.escape(distribution)}>={re.escape(lowest)},<{re.escape(beyond)}"', metadata), distribution
        installed = versions.installed(distribution)
        if installed is not None:
            versions.require_supported(distribution, "test")  # raises when the installed client is unsupported


@pytest.mark.parametrize("found", ["4.16.9", "4.18.0", "5.0.0", None])
def test_an_unsupported_or_missing_version_is_refused(monkeypatch, found):
    from sendproof_core.stores import versions

    monkeypatch.setattr(versions, "installed", lambda distribution: found)
    with pytest.raises(TypeError, match=r"azure-cosmos>=4\.17,<4\.18"):
        versions.require_supported("azure-cosmos", "cosmosdb_store")
    monkeypatch.setattr(versions, "installed", lambda distribution: "4.17.0b1")
    versions.require_supported("azure-cosmos", "cosmosdb_store")
