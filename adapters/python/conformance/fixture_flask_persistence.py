"""Persistence layers for the Flask conformance fixture.

``BENCH_FLASK_ORM`` selects how the fixture talks to the database. Both layers expose the same
four names, so the Flask app in ``fixture_flask.py`` is identical for either:

``sqlalchemy`` (default)
    Plain SQLAlchemy: one ``Session`` per request kept on ``flask.g`` and closed on teardown.
``flask-sqlalchemy``
    The Flask-SQLAlchemy extension: ``db.session`` is a ``scoped_session`` keyed by application
    context and removed by the extension's own ``teardown_appcontext`` hook.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from flask import Flask, g
from sqlalchemy import String, create_engine
from sqlalchemy.engine import Engine, URL
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

ORM = os.environ.get("BENCH_FLASK_ORM", "sqlalchemy")


class Base(DeclarativeBase):
    pass


class Persistence:
    """The fixture's view of its database: ``Item``, ``engine``, ``session()`` and ``init_app``."""

    Item: Any
    engine: Engine
    label: str

    def init_app(self, app: Flask) -> None:
        raise NotImplementedError

    def session(self) -> Session:
        raise NotImplementedError


def _define_item(base: type) -> Any:
    class Item(base):  # type: ignore[valid-type, misc]
        __tablename__ = "items"
        # MySQL needs a bounded key length, so every string column states one.
        id: Mapped[str] = mapped_column(String(255), primary_key=True)
        name: Mapped[str] = mapped_column(String(255))

    return Item


class PlainSqlAlchemy(Persistence):
    label = "sqlalchemy"

    def __init__(self, url: URL) -> None:
        self.engine = create_engine(url)
        self.Item = _define_item(Base)
        Base.metadata.drop_all(self.engine)
        Base.metadata.create_all(self.engine)

    def init_app(self, app: Flask) -> None:
        @app.teardown_request
        def close_session(error: BaseException | None) -> None:
            session = g.pop("db", None)
            if session is not None:
                session.close()

    def session(self) -> Session:
        if "db" not in g:
            g.db = Session(self.engine, expire_on_commit=False)
        return g.db


class FlaskSqlAlchemy(Persistence):
    label = "flask-sqlalchemy"

    def __init__(self, url: URL) -> None:
        from flask_sqlalchemy import SQLAlchemy

        self._url = url
        self.db = SQLAlchemy(model_class=Base)
        # Flask-SQLAlchemy's default ``expire_on_commit=True`` is kept on purpose: handlers read
        # attributes after ``commit()``, which reloads the row through the same session.
        self.Item = _define_item(self.db.Model)

    def init_app(self, app: Flask) -> None:
        app.config["SQLALCHEMY_DATABASE_URI"] = self._url.render_as_string(hide_password=False)
        self.db.init_app(app)
        with app.app_context():
            self.engine = self.db.engine
            self.db.drop_all()
            self.db.create_all()

    def session(self) -> Any:
        return self.db.session


def create(url: URL) -> Persistence:
    """Build the persistence layer chosen by ``BENCH_FLASK_ORM``."""
    if ORM == "flask-sqlalchemy":
        return FlaskSqlAlchemy(url)
    if ORM == "sqlalchemy":
        return PlainSqlAlchemy(url)
    raise SystemExit(f"BENCH_FLASK_ORM={ORM!r} is not one of 'sqlalchemy' or 'flask-sqlalchemy'.")
