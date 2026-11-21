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

from testbench_core import PreviewUnavailable

#: Dialects with ANSI ``SAVEPOINT`` / ``RELEASE SAVEPOINT`` / ``ROLLBACK TO SAVEPOINT``.
SUPPORTED_DIALECTS = frozenset({"sqlite", "postgresql", "mysql", "mariadb", "oracle"})
SAVEPOINT = "testbench_preview"


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


class RollbackOnlyConnection:
    """A DBAPI connection proxy that never commits.

    Everything not overridden is forwarded to the real connection.
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
        return getattr(self._tb_real, name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name == "autocommit" and value:
            # The driver would commit every statement on its own.
            self._tb_hold.unsafe = "The connection switched to autocommit."
        setattr(self._tb_real, name, value)


class Hold:
    """The connection one engine contributes to a preview."""

    def __init__(self, engine: Any, fairy: Any) -> None:
        self.engine = engine
        self.fairy = fairy  # real pooled connection, checked out for the whole preview
        self.unsafe: str | None = None
        self.proxy = RollbackOnlyConnection(fairy.dbapi_connection, self)
        # SQLite starts a transaction on SAVEPOINT but would commit it on the final RELEASE.
        opening = ["BEGIN"] if engine.dialect.name == "sqlite" else []
        self.run(*opening, "SAVEPOINT " + SAVEPOINT)
        self.pool = StaticPool(
            lambda: self.proxy, reset_on_return=None, dialect=engine.dialect, logging_name="testbench-preview"
        )

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
