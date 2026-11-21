"""The start-savepoint backstop on SQLite (spec/data-stores.md, "Transaction-control statements from the handler").

A commit the pre-send guard can't see (on the driver's own connection), followed by a new transaction,
would let a plain rollback succeed. The savepoint the Preview opened its transaction with is gone, so the
Preview is never confirmed.
"""

from __future__ import annotations

import pytest
from django.db import connections

from sendproof_core import PreviewRollbackError, RequestScope
from sendproof_core.capture import Capture
from sendproof_core.scope import activate, deactivate
from sendproof_django import DjangoOrmPreview


def _stored() -> list[str]:
    with connections["default"].cursor() as cursor:
        cursor.execute("SELECT id FROM items ORDER BY id")
        return [row[0] for row in cursor.fetchall()]


def test_a_preview_committed_on_the_raw_driver_connection_is_never_confirmed():
    provider = DjangoOrmPreview()
    scope = RequestScope(Capture(rollback=True), "Development", True)
    token = activate(scope)
    session = provider.begin(scope)
    try:
        raw = connections["default"].connection.cursor()  # the driver's own cursor, around every guard
        raw.execute("INSERT INTO items VALUES ('escaped', 'E')")
        raw.execute("COMMIT")
        raw.execute("BEGIN")  # a new transaction, so a plain rollback would succeed
        raw.execute("INSERT INTO items VALUES ('after', 'A')")
        raw.close()
        with pytest.raises(PreviewRollbackError, match="committed"):
            session.rollback()
    finally:
        try:
            session.close()
        finally:
            deactivate(token)
    assert _stored() == ["escaped"]
    with connections["default"].cursor() as cursor:
        cursor.execute("DELETE FROM items")


def test_a_handler_may_not_release_the_preview_savepoint():
    provider = DjangoOrmPreview()
    scope = RequestScope(Capture(rollback=True), "Development", True)
    token = activate(scope)
    session = provider.begin(scope)
    try:
        with pytest.raises(PreviewRollbackError):
            with connections["default"].cursor() as cursor:
                cursor.execute("RELEASE SAVEPOINT sendproof_preview")
    finally:
        try:
            session.close()
        finally:
            deactivate(token)
