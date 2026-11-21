"""Rollback-only connection sharing for one preview.

While a preview is active, every ``Engine.raw_connection()`` call for an enrolled engine is
answered from a private one-connection pool. That pool hands out the same DBAPI connection to
every ``Session`` and ``Connection`` of the request, so later statements see earlier writes
the way they would after a real commit.

Transaction boundaries are emulated with one SAVEPOINT inside a transaction that is never
committed:

* ``commit()``  -> ``RELEASE SAVEPOINT`` then ``SAVEPOINT`` (writes stay, nothing is durable)
* ``rollback()`` -> ``ROLLBACK TO SAVEPOINT`` (undoes work since the last emulated commit)

So a handler that commits and later rolls back behaves as it would for real. The adapter ends
the preview with a genuine rollback and returns the connection to the real pool.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.pool import StaticPool

from sendproof_core import PreviewRollbackError, PreviewUnavailable

#: Dialects with ANSI ``SAVEPOINT`` / ``RELEASE SAVEPOINT`` / ``ROLLBACK TO SAVEPOINT``.
SUPPORTED_DIALECTS = frozenset({"sqlite", "postgresql", "mysql", "mariadb", "oracle"})
SAVEPOINT = "sendproof_preview"


def ensure_supported(engine: Any) -> None:
    """Raise :class:`PreviewUnavailable` when rollback cannot be guaranteed for ``engine``."""
    name = engine.dialect.name
    if name not in SUPPORTED_DIALECTS:
        raise PreviewUnavailable(f"The '{name}' dialect is not supported for rollback previews.")
    level = getattr(engine.dialect, "_on_connect_isolation_level", None) or engine.get_execution_options().get(
        "isolation_level"
    )
    if level == "AUTOCOMMIT":
        raise PreviewUnavailable(
            "An engine uses AUTOCOMMIT, so its writes cannot be rolled back. Previews are unavailable."
        )


def _switches_autocommit_on(name: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> bool:
    """Whether a DBAPI method call would put the connection in autocommit mode.

    Covers ``autocommit(True)`` (PyMySQL, mysqlclient), ``set_autocommit(True)`` (psycopg),
    ``set_session(autocommit=True)`` and ``set_isolation_level(0)`` (psycopg2).
    """
    if name in ("autocommit", "set_autocommit"):
        return bool(args[0] if args else kwargs.get("value", kwargs.get("on", False)))
    if name == "set_session":
        return bool(kwargs.get("autocommit", args[3] if len(args) > 3 else False))
    if name == "set_isolation_level":
        return (args[0] if args else kwargs.get("level")) == 0
    return False


_AUTOCOMMIT_METHODS = frozenset({"autocommit", "set_autocommit", "set_session", "set_isolation_level"})


class RollbackOnlyConnection:
    """A DBAPI connection proxy that never commits.

    Everything not overridden is forwarded to the real connection. Switching the connection to
    autocommit is refused before it reaches the driver, because several drivers commit the open
    transaction as part of that switch (``sqlite3`` when ``isolation_level`` becomes ``None``,
    MySQL on ``SET autocommit = 1``).
    """

    __slots__ = ("_tb_real", "_tb_hold")

    def __init__(self, real: Any, hold: "Hold") -> None:
        object.__setattr__(self, "_tb_real", real)
        object.__setattr__(self, "_tb_hold", hold)

    def commit(self) -> None:
        """Keep the writes inside the preview transaction instead of committing them."""
        self._tb_hold.run("RELEASE SAVEPOINT " + SAVEPOINT, "SAVEPOINT " + SAVEPOINT)

    def rollback(self) -> None:
        """Undo the work since the last emulated commit."""
        self._tb_hold.run("ROLLBACK TO SAVEPOINT " + SAVEPOINT)

    def close(self) -> None:
        """Keep the connection open until the preview rolls it back."""

    def __getattr__(self, name: str) -> Any:
        attribute = getattr(self._tb_real, name)
        if name in _AUTOCOMMIT_METHODS and callable(attribute):
            hold = self._tb_hold

            def guarded(*args: Any, **kwargs: Any) -> Any:
                if _switches_autocommit_on(name, args, kwargs):
                    hold.refuse("The connection tried to switch to autocommit.")
                return attribute(*args, **kwargs)

            return guarded
        return attribute

    def __setattr__(self, name: str, value: Any) -> None:
        if (name == "autocommit" and value) or (name == "isolation_level" and value is None):
            self._tb_hold.refuse("The connection tried to switch to autocommit.")
        setattr(self._tb_real, name, value)


class Hold:
    """The connection one engine contributes to a preview."""

    def __init__(self, engine: Any, fairy: Any) -> None:
        self.engine = engine
        self.fairy = fairy  # real pooled connection, checked out for the whole preview
        self.unsafe: str | None = None
        self.proxy = RollbackOnlyConnection(fairy.dbapi_connection, self)
        # SQLite starts a transaction on SAVEPOINT but would commit it on the final RELEASE. IMMEDIATE takes the write
        # lock up front, so concurrent previews queue behind the driver's busy timeout. A deferred BEGIN lets two
        # previews take the read lock and then fail at once with "database is locked" when both try to write.
        opening = ["BEGIN IMMEDIATE"] if engine.dialect.name == "sqlite" else []
        self.run(*opening, "SAVEPOINT " + SAVEPOINT)
        self.pool = StaticPool(
            lambda: self.proxy, reset_on_return=None, dialect=engine.dialect, logging_name="sendproof-preview"
        )

    def refuse(self, reason: str) -> None:
        """Mark the preview unsafe and stop the operation before the driver commits anything."""
        self.unsafe = reason
        raise PreviewRollbackError(reason)

    def run(self, *statements: str) -> None:
        """Execute transaction-control statements on the real DBAPI connection."""
        real = self.proxy._tb_real
        cursor = real.cursor()
        try:
            for statement in statements:
                cursor.execute(statement)
        finally:
            cursor.close()

    def connect(self) -> Any:
        """A pooled-connection handle that shares the held DBAPI connection."""
        return self.pool.connect()
