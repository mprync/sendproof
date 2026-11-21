"""Database selection shared by the Python conformance fixtures.

The runner sets ``BENCH_DATABASE`` (``sqlite``, ``postgresql``, ``mysql`` or ``sqlserver``) and, for
every database except SQLite, ``BENCH_DATABASE_URL`` pointing at a fresh disposable database. SQLite
needs no URL: the fixture creates a file inside its own temporary directory.

``SQLAlchemyPreview`` supports SQLite, PostgreSQL, MySQL/MariaDB and Oracle. SQL Server has no
``SAVEPOINT`` dialect support there, so selecting it is a configuration error, not a skipped test.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from sqlalchemy.engine import URL, make_url

#: Driver used when the runner supplies a URL without one (``postgresql://...`` or ``mysql://...``).
DEFAULT_DRIVERS = {"postgresql": "psycopg", "mysql": "pymysql"}
ALIASES = {"postgres": "postgresql", "pg": "postgresql", "mariadb": "mysql", "mssql": "sqlserver"}


def database_kind() -> str:
    """The database family requested through ``BENCH_DATABASE`` (default ``sqlite``)."""
    kind = os.environ.get("BENCH_DATABASE", "sqlite").strip().lower() or "sqlite"
    return ALIASES.get(kind, kind)


def resolve(directory: Path) -> tuple[URL, str]:
    """Return the SQLAlchemy URL and the family name for this fixture process.

    Exits with a clear message when the selection cannot be honoured, so that a misconfigured run
    never silently falls back to SQLite.
    """
    kind = database_kind()
    if kind == "sqlite":
        return URL.create("sqlite", database=str(directory / "items.db")), kind
    if kind not in DEFAULT_DRIVERS:
        sys.exit(f"BENCH_DATABASE={kind!r} is not supported by the Python SQLAlchemy provider "
                 f"(supported: sqlite, {', '.join(DEFAULT_DRIVERS)}).")
    raw = os.environ.get("BENCH_DATABASE_URL", "").strip()
    if not raw:
        sys.exit(f"BENCH_DATABASE={kind} requires BENCH_DATABASE_URL.")
    url = make_url(raw)
    family = ALIASES.get(url.get_backend_name(), url.get_backend_name())
    if family != kind:
        sys.exit(f"BENCH_DATABASE_URL is a {family} URL but BENCH_DATABASE={kind}.")
    if "+" not in url.drivername:
        url = url.set(drivername=f"{kind}+{DEFAULT_DRIVERS[kind]}")
    return url, kind
