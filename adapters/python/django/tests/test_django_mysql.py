"""MySQL transaction escapes through the Django ORM provider.

spec/data-stores.md, "Transaction-control statements from the handler": during a Preview the provider
refuses, before sending, ``CALL`` (unless the host declared the procedure safe by exact name), DDL and
the other implicitly committing statements; and before rolling back it checks that the savepoint the
Preview opened its transaction with still exists, answering 500 when something committed anyway.

These run against the compose MySQL (or ``BENCH_MYSQL_URL``) in a fresh database that ``conftest``
creates; they skip when no server answers.
"""

from __future__ import annotations

import pytest
from django.db import connections

import conftest
from sendproof_core import PreviewRollbackError, RequestScope
from sendproof_core.capture import Capture
from sendproof_core.scope import activate, deactivate
from sendproof_django import DjangoOrmPreview

pytestmark = pytest.mark.skipif(
    conftest.mysql_database is None,
    reason="MySQL is not running: docker compose -f tests/conformance/compose.yml up -d --wait mysql",
)


@pytest.fixture
def mysql():
    """The ``mysql`` alias with an empty ``items`` table and two procedures."""
    connection = connections["mysql"]
    with connection.cursor() as cursor:
        cursor.execute("DROP TABLE IF EXISTS items")
        cursor.execute("DROP TABLE IF EXISTS escape_probe")
        cursor.execute("CREATE TABLE items (id VARCHAR(40) PRIMARY KEY)")
        cursor.execute("DROP PROCEDURE IF EXISTS commits")
        cursor.execute("CREATE PROCEDURE commits() BEGIN COMMIT; END")
        cursor.execute("DROP PROCEDURE IF EXISTS reads_only")
        cursor.execute("CREATE PROCEDURE reads_only() BEGIN SELECT 1; END")
    yield connection
    connection.close()


def stored(connection) -> list[str]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT id FROM items ORDER BY id")
        return [row[0] for row in cursor.fetchall()]


def preview(provider, body) -> None:
    """Run ``body`` inside a Preview the way the middleware does, then roll back and close."""
    scope = RequestScope(Capture(rollback=True), "Development", True)
    token = activate(scope)
    session = provider.begin(scope)
    try:
        body()
        session.rollback()
    finally:
        try:
            session.close()
        finally:
            deactivate(token)


def test_call_and_implicit_commits_are_refused_before_sending(mysql):
    provider = DjangoOrmPreview(using=("mysql",), safe_procedures=["reads_only"])
    for statement in ("CALL commits()", "CREATE TABLE escape_probe (n INT)", "/*!50000 COMMIT */",
                      "RELEASE SAVEPOINT sendproof_preview"):
        def body():
            with mysql.cursor() as cursor:
                cursor.execute("INSERT INTO items VALUES ('a')")
                cursor.execute("CALL reads_only()")  # declared safe: allowed
                with pytest.raises(PreviewRollbackError):
                    cursor.execute(statement)

        with pytest.raises(PreviewRollbackError):
            preview(provider, body)
        assert stored(mysql) == [], statement
    with mysql.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() "
                       "AND table_name = 'escape_probe'")
        assert cursor.fetchone()[0] == 0
    with pytest.raises(ValueError):
        DjangoOrmPreview(using=("mysql",), safe_procedures=["reads_*"])


def test_a_preview_whose_transaction_was_committed_anyway_is_never_confirmed(mysql):
    """Django runs MySQL with autocommit off inside ``atomic``, so after a commit MySQL opens a new
    transaction by itself: only a savepoint made at the start shows the Preview's is gone."""
    provider = DjangoOrmPreview(using=("mysql",))

    def body():
        with mysql.cursor() as cursor:
            cursor.execute("INSERT INTO items VALUES ('escaped')")
        mysql.connection.commit()  # the driver's own commit, around every guard
        with mysql.cursor() as cursor:
            cursor.execute("INSERT INTO items VALUES ('after')")  # a new transaction opens

    with pytest.raises(PreviewRollbackError, match="committed"):
        preview(provider, body)
    assert stored(mysql) == ["escaped"]

    def ordinary():
        with mysql.cursor() as cursor:
            cursor.execute("INSERT INTO items VALUES ('b')")

    preview(provider, ordinary)  # an ordinary Preview still confirms its rollback
    assert stored(mysql) == ["escaped"]
