"""The Cassandra write guard against the compose ``cassandra`` service
(``docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra``).

An independent, unhooked session (``cassandra_keyspace``) reads the table back, so a passing check
proves the refused statement never reached Cassandra.
"""

from __future__ import annotations

import threading

import pytest

pytest.importorskip("cassandra")
from cassandra.cluster import Cluster  # noqa: E402
from cassandra.concurrent import execute_concurrent_with_args  # noqa: E402
from cassandra.query import BatchStatement, SimpleStatement  # noqa: E402

from sendproof_core import detached  # noqa: E402
from sendproof_core.stores import PreviewWriteBlocked, cassandra_store  # noqa: E402
from store_support import CASSANDRA_SERVER, active, cassandra_keyspace, db_entries, needs, observed_scope, preview_scope  # noqa: E402

pytestmark = needs("cassandra")


@pytest.fixture
def tickets():
    """``(plain session, keyspace)``: the table holds the ticket ``seeded`` (status ``open``, 3 hits)."""
    with cassandra_keyspace() as (session, keyspace):
        session.execute(f"INSERT INTO {keyspace}.tickets (id, status, hits) VALUES ('seeded', 'open', 3)")
        yield session, keyspace


def hooked_cluster(**options):
    host, _, port = CASSANDRA_SERVER.partition(":")
    cluster = Cluster([host], port=int(port or 9042))
    store = cassandra_store(cluster, **options)
    return cluster, store


def ticket(session, keyspace, identifier):
    rows = list(session.execute(f"SELECT id, status, hits FROM {keyspace}.tickets WHERE id = %s", (identifier,)))
    return rows[0] if rows else None


def test_reads_run_and_every_write_is_refused_before_it_is_sent(tickets):
    plain, keyspace = tickets
    cluster, store = hooked_cluster(name="tickets")
    try:
        session = cluster.connect(keyspace)
        with active(preview_scope()) as scope:
            assert list(session.execute("SELECT id, status FROM tickets WHERE id = 'seeded'"))[0].status == "open"
            assert list(session.execute(SimpleStatement("SELECT * FROM tickets WHERE id = %s"), ("seeded",)))
            for text, operation in (
                ("INSERT INTO tickets (id, status, hits) VALUES ('blocked', 'new', 1)", "INSERT"),
                ("UPDATE tickets SET status = 'closed' WHERE id = 'seeded' IF EXISTS", "UPDATE"),
                ("DELETE FROM tickets WHERE id = 'seeded'", "DELETE"),
                ("TRUNCATE tickets", "TRUNCATE"),
                ("CREATE TABLE other (id text PRIMARY KEY)", "CREATE"),
                ("BEGIN BATCH INSERT INTO tickets (id) VALUES ('b') APPLY BATCH", "BATCH"),
                ("SELECT * FROM tickets; DELETE FROM tickets WHERE id = 'seeded'", "SELECT"),
            ):
                with pytest.raises(PreviewWriteBlocked) as blocked:
                    session.execute(text)
                assert (blocked.value.store, blocked.value.operation) == ("cassandra", operation), text
            assert scope.capture.blocked["operation"] == "INSERT"  # the first block wins
        assert ticket(plain, keyspace, "blocked") is None and ticket(plain, keyspace, "b") is None
        assert ticket(plain, keyspace, "seeded").status == "open"
        assert store.describe() == {"system": "cassandra", "name": "tickets", "mode": "guard"}
    finally:
        cluster.shutdown()


def test_prepared_statements_are_classified_by_the_text_they_were_prepared_from(tickets):
    plain, keyspace = tickets
    cluster, _ = hooked_cluster()
    try:
        session = cluster.connect(keyspace)
        read = session.prepare("SELECT id, status, hits FROM tickets WHERE id = ?")  # PREPARE is allowed and not guarded
        insert = session.prepare("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)")
        update = session.prepare("UPDATE tickets SET status = 'closed' WHERE id = ? IF EXISTS")
        with active(preview_scope()) as scope:
            assert session.execute(read, ("seeded",)).one().hits == 3
            assert session.execute(read.bind(("seeded",))).one().status == "open"  # a BoundStatement
            for prepared, operation in ((insert, "INSERT"), (update, "UPDATE")):
                for query in (prepared, prepared.bind(("blocked",))):
                    with pytest.raises(PreviewWriteBlocked) as blocked:
                        session.execute(query, ("blocked",)) if query is prepared else session.execute(query)
                    assert blocked.value.operation == operation
            assert scope.capture.blocked["operation"] == "INSERT"
        assert ticket(plain, keyspace, "blocked") is None and ticket(plain, keyspace, "seeded").status == "open"
    finally:
        cluster.shutdown()


def test_every_batch_is_a_write_even_an_empty_one_or_one_of_reads(tickets):
    plain, keyspace = tickets
    cluster, _ = hooked_cluster()
    try:
        session = cluster.connect(keyspace)
        prepared = session.prepare("UPDATE tickets SET status = ? WHERE id = ?")
        empty = BatchStatement()
        batch = BatchStatement()
        batch.add(prepared, ("closed", "seeded"))
        with active(preview_scope()):
            for statement in (batch, empty):
                with pytest.raises(PreviewWriteBlocked) as blocked:
                    session.execute(statement)
                assert blocked.value.operation == "BATCH"
        assert ticket(plain, keyspace, "seeded").status == "open"
    finally:
        cluster.shutdown()


def test_sessions_made_before_and_after_the_hook_and_concurrent_execution_are_guarded(tickets):
    plain, keyspace = tickets
    host, _, port = CASSANDRA_SERVER.partition(":")
    cluster = Cluster([host], port=int(port or 9042))
    before = cluster.connect(keyspace)  # a session the cluster already holds
    cassandra_store(cluster)
    after = cluster.connect(keyspace)  # a session made after registration
    try:
        for session in (before, after):
            with active(preview_scope()) as scope:
                with pytest.raises(PreviewWriteBlocked):
                    session.execute("DELETE FROM tickets WHERE id = 'seeded'")
                with pytest.raises(PreviewWriteBlocked):
                    session.execute_async("DELETE FROM tickets WHERE id = 'seeded'")
                insert = session.prepare("INSERT INTO tickets (id, status, hits) VALUES (?, 'n', 1)")
                with pytest.raises(PreviewWriteBlocked):  # execute_concurrent goes through execute_async
                    execute_concurrent_with_args(session, insert, [("c1",), ("c2",)])
                assert scope.capture.blocked["operation"] == "DELETE"
        assert ticket(plain, keyspace, "seeded") is not None and ticket(plain, keyspace, "c1") is None
    finally:
        cluster.shutdown()


def test_a_session_can_be_hooked_alone_and_neither_twice(tickets):
    plain, keyspace = tickets
    host, _, port = CASSANDRA_SERVER.partition(":")
    cluster = Cluster([host], port=int(port or 9042))
    try:
        session = cluster.connect(keyspace)
        cassandra_store(session)
        with active(preview_scope()):
            with pytest.raises(PreviewWriteBlocked):
                session.execute("DELETE FROM tickets WHERE id = 'seeded'")
        with pytest.raises(TypeError, match="already hooked"):
            cassandra_store(session)
        with pytest.raises(TypeError):
            cassandra_store(object())
        assert ticket(plain, keyspace, "seeded") is not None
        other = Cluster([host], port=int(port or 9042))
        cassandra_store(other)
        with pytest.raises(TypeError, match="already hooked"):
            cassandra_store(other)
        other.shutdown()
    finally:
        cluster.shutdown()


def test_reads_become_db_entries_without_literals_and_outside_a_preview_writes_run(tickets):
    plain, keyspace = tickets
    cluster, _ = hooked_cluster()
    try:
        session = cluster.connect()
        scope = observed_scope()
        with active(scope):
            session.execute(f"INSERT INTO {keyspace}.tickets (id, status, hits) VALUES ('sent', 'new', 1)")
            future = session.execute_async(f"SELECT id, status FROM {keyspace}.tickets WHERE id = 'seeded'")
            assert future.result()[0].status == "open"
            future.add_callbacks(lambda rows: None, lambda error: None)
        assert ticket(plain, keyspace, "sent").status == "new"  # an observed Send commits for real
        insert = db_entries(scope, "cassandra", "INSERT")[0]["db"]
        assert (insert["target"], insert["namespace"]) == ("tickets", keyspace)
        assert "'new'" not in insert["statement"] and "sent" not in insert["statement"] and "?" in insert["statement"]
        select = db_entries(scope, "cassandra", "SELECT")[0]["db"]
        assert select["rowsAffected"] == 1 and "seeded" not in select["statement"]
    finally:
        cluster.shutdown()


def test_a_write_no_request_accounts_for_fails_every_open_preview(tickets):
    plain, keyspace = tickets
    cluster, _ = hooked_cluster()
    try:
        session = cluster.connect(keyspace)

        def in_thread(body):
            thread = threading.Thread(target=body)
            thread.start()
            thread.join()

        with active(preview_scope()) as scope:
            in_thread(lambda: session.execute("INSERT INTO tickets (id, status, hits) VALUES ('thread', 'x', 1)"))
            assert isinstance(scope.capture.fault, Exception) and "outside any request" in str(scope.capture.fault)
        with active(preview_scope()) as scope:
            def marked() -> None:
                with detached():
                    session.execute("INSERT INTO tickets (id, status, hits) VALUES ('thread2', 'x', 1)")
            in_thread(marked)
            assert scope.capture.fault is None
    finally:
        cluster.shutdown()


def test_without_the_hook_the_same_write_lands(tickets):
    """The control for the tests above: an unhooked session in a Preview scope writes for real."""
    plain, keyspace = tickets
    with active(preview_scope()):
        plain.execute(f"DELETE FROM {keyspace}.tickets WHERE id = 'seeded'")
    assert ticket(plain, keyspace, "seeded") is None
