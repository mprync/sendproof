"""Flask-SQLAlchemy under Preview and Observed Send.

These tests run against a real database. They use a SQLite file by default; set ``BENCH_DATABASE``
(``postgresql`` or ``mysql``) and ``BENCH_DATABASE_URL`` to a disposable database to run the same
checks on that server. The tests drop and recreate the ``items`` table they use.
"""

from __future__ import annotations

import os

import pytest
from flask import Flask, abort, jsonify, request, session
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import String, event, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from testbench_core import is_previewing, record_email
from testbench_flask import AuthProvider, Identity, TestBench, preview
from testbench_sqlalchemy import SQLAlchemyPreview

ROLLBACK = {"Prefer": "tx=rollback"}
DEFAULT_DRIVERS = {"postgresql": "psycopg", "mysql": "pymysql"}


def _url(tmp_path):
    kind = os.environ.get("BENCH_DATABASE", "sqlite").lower()
    if kind == "sqlite":
        return f"sqlite:///{tmp_path / 'db.sqlite'}"
    url = make_url(os.environ["BENCH_DATABASE_URL"])
    if "+" not in url.drivername:
        url = url.set(drivername=f"{kind}+{DEFAULT_DRIVERS[kind]}")
    return url.render_as_string(hide_password=False)


class Clock:
    now = 0.0

    def __call__(self):
        return self.now


class Harness:
    """A Flask app using Flask-SQLAlchemy plus the facts its handlers observed."""

    def __init__(self, tmp_path, *, clock=None, extra_bind=False, enroll_extra_bind=True):
        # A fresh declarative base per app, so that every test owns its own metadata.
        self.db = SQLAlchemy(model_class=type("Base", (DeclarativeBase,), {}))
        db = self.db

        class Item(db.Model):
            __tablename__ = "items"
            id: Mapped[str] = mapped_column(String(255), primary_key=True)
            name: Mapped[str] = mapped_column(String(255))

        self.Item = Item
        if extra_bind:
            class Audit(db.Model):
                __tablename__ = "audit"
                __bind_key__ = "audit"
                id: Mapped[str] = mapped_column(String(255), primary_key=True)

            self.Audit = Audit
        self.app = app = Flask(__name__)
        app.secret_key = "test"
        app.config["SQLALCHEMY_DATABASE_URI"] = _url(tmp_path)
        if extra_bind:
            app.config["SQLALCHEMY_BINDS"] = {"audit": f"sqlite:///{tmp_path / 'audit.sqlite'}"}
        db.init_app(app)
        with app.app_context():
            self.engine = db.engine
            self.audit_engine = db.engines["audit"] if extra_bind else None
            db.drop_all()
            db.create_all()
        self.delivered: list[str] = []
        self.committed: list[str] = []
        self.sessions: list[Session] = []
        self._routes()

        engines = [self.engine, *([self.audit_engine] if extra_bind and enroll_extra_bind else [])]
        self.provider = SQLAlchemyPreview(*engines, database="db")
        TestBench(
            app,
            provider=self.provider,
            environment="Development",
            identity=lambda req: Identity(session["name"], session["role"], session["user"], "session")
            if "user" in session else None,
            auth_providers=[AuthProvider("Password", "cookie", "/auth")],
            trace_ttl=5,
            **({"clock": clock} if clock else {}),
        )

    def _routes(self) -> None:
        app, db, Item = self.app, self.db, self.Item

        def require(role: str | None = None) -> None:
            if "user" not in session:
                abort(401)
            if role and session["role"] != role:
                abort(403)

        # On-commit behaviour: ``after_commit`` runs for the emulated commit of a preview too.
        @event.listens_for(db.session, "after_commit")
        def committed(_session):
            self.committed.append("previewing" if is_previewing() else "real")

        @app.post("/items")
        @preview
        def create():
            require("admin")
            data = request.get_json()
            db.session.add(Item(id=data["id"], name=data["name"]))
            db.session.commit()
            # Flask-SQLAlchemy expires instances on commit; this read reloads through the session.
            self.sessions.append(db.session())
            created = db.session.get(Item, data["id"])
            if not record_email("Created", "a@x", ["b@x"], [], "Hi", created.name):
                self.delivered.append(created.id)
            return jsonify(id=created.id, name=created.name), 201

        @app.post("/two-commits")
        @preview
        def two_commits():
            require("admin")
            db.session.add(Item(id="first", name="First"))
            db.session.commit()
            db.session.add(Item(id="second", name="Second"))
            db.session.rollback()  # undoes only the work since the last commit
            return jsonify(ok=True)

        @app.post("/nested")
        @preview
        def nested():
            require("admin")
            db.session.add(Item(id="outer", name="Outer"))
            db.session.flush()
            try:
                with db.session.begin_nested():  # a real SAVEPOINT inside the preview transaction
                    db.session.add(Item(id="outer", name="Duplicate"))
                    db.session.flush()
            except IntegrityError:
                pass
            db.session.add(Item(id="inner", name="Inner"))
            db.session.commit()
            return jsonify(ok=True)

        @app.post("/audited")
        @preview
        def audited():
            require("admin")
            db.session.add(Item(id="main", name="Main"))
            db.session.add(self.Audit(id="audit"))
            db.session.commit()
            return jsonify(ok=True)

        @app.post("/boom")
        @preview
        def boom():
            db.session.add(Item(id="boom", name="Boom"))
            db.session.flush()
            raise RuntimeError("unhandled")

        @app.post("/raw")
        @preview
        def raw():
            require("admin")
            db.session.execute(text("DELETE FROM items WHERE id = :id"), {"id": "gone"})
            with db.engine.begin() as connection:  # a connection outside the scoped session
                connection.execute(text("INSERT INTO items (id, name) VALUES ('raw', 'Raw')"))
            return jsonify(ok=True)

        @app.post("/auth/<user>")
        def sign_in(user: str):
            session.update(user=user, name=user.title(), role="admin" if user == "admin" else "viewer")
            return jsonify(ok=True)

    # ----------------------------------------------------------------- helpers
    def client(self, user: str | None = None):
        http = self.app.test_client()
        if user:
            http.post(f"/auth/{user}")
        return http

    def stored(self, model=None):
        with Session(self.audit_engine if model is not None and model is getattr(self, "Audit", None) else self.engine) as plain:
            return sorted(row.id for row in plain.scalars(select(model or self.Item)))

    def checked_out(self) -> int:
        return getattr(self.engine.pool, "checkedout", lambda: 0)()


@pytest.fixture
def make(tmp_path):
    built: list[Harness] = []

    def factory(**options):
        harness = Harness(tmp_path, **options)
        built.append(harness)
        return harness

    yield factory
    for harness in built:
        harness.provider.uninstall()
        with harness.app.app_context():
            harness.db.drop_all()
        harness.engine.dispose()


def test_preview_rolls_back_a_session_commit_and_suppresses_effects(make):
    bench = make()
    http = bench.client("admin")
    response = http.post("/bench/_preview/items", json={"id": "a", "name": "A"}, headers=ROLLBACK)
    body = response.get_json()
    assert response.status_code == 200 and body["status"] == 201 and body["rolledBack"] is True
    assert body["body"] == {"id": "a", "name": "A"}  # the handler read its own committed row
    assert [(c["operation"], c["table"], c["key"]) for c in body["changes"]] == [("insert", "items", {"id": "a"})]
    assert body["effects"][0]["description"] == "Created"
    assert bench.delivered == [] and bench.stored() == []


def test_observed_send_commits_for_real_and_delivers_the_effect(make):
    bench = make()
    http = bench.client("admin")
    assert http.post("/items", json={"id": "a", "name": "A"}).status_code == 201
    assert bench.delivered == ["a"] and bench.stored() == ["a"]
    traced = http.post("/items", json={"id": "b", "name": "B"}, headers={"Prefer": "trace"}, buffered=True)
    trace = http.get(f"/bench/_api/traces/{traced.headers['X-TestBench-Trace']}").get_json()
    assert bench.stored() == ["a", "b"]
    assert [c["operation"] for c in trace["changes"]] == ["insert"] and trace["effects"][0]["delivered"] is True


def test_after_commit_listeners_run_in_both_modes(make):
    bench = make()
    http = bench.client("admin")
    http.post("/bench/_preview/items", json={"id": "a", "name": "A"}, headers=ROLLBACK)
    assert bench.committed == ["previewing"]
    http.post("/items", json={"id": "b", "name": "B"})
    assert bench.committed == ["previewing", "real"]
    assert bench.stored() == ["b"]


def test_session_lifecycle_releases_connections_and_scoped_sessions(make):
    bench = make()
    http = bench.client("admin")
    for n in range(3):
        http.post("/bench/_preview/items", json={"id": f"p{n}", "name": "P"}, headers=ROLLBACK)
        assert bench.checked_out() == 0
    assert bench.stored() == []
    # Flask-SQLAlchemy's teardown closed each request's session, and ordinary work still succeeds.
    assert len(bench.sessions) == 3 and not any(s.in_transaction() for s in bench.sessions)
    assert http.post("/items", json={"id": "after", "name": "After"}).status_code == 201
    assert bench.stored() == ["after"]


def test_commit_then_rollback_inside_the_handler_keeps_real_semantics(make):
    bench = make()
    http = bench.client("admin")
    body = http.post("/bench/_preview/two-commits", headers=ROLLBACK).get_json()
    assert [c["key"] for c in body["changes"]] == [{"id": "first"}] and bench.stored() == []
    http.post("/two-commits")
    assert bench.stored() == ["first"]


def test_nested_savepoint_failure_inside_a_preview(make):
    bench = make()
    body = bench.client("admin").post("/bench/_preview/nested", headers=ROLLBACK).get_json()
    assert body["rolledBack"] is True and bench.stored() == []
    assert sorted(c["key"]["id"] for c in body["changes"] if c["operation"] == "insert") == ["inner", "outer"]
    bench.client("admin").post("/nested")
    assert bench.stored() == ["inner", "outer"]


def test_raw_statements_and_engine_connections_join_the_preview(make):
    bench = make()
    body = bench.client("admin").post("/bench/_preview/raw", headers=ROLLBACK).get_json()
    assert body["rolledBack"] is True and bench.stored() == []
    assert any("INSERT INTO items" in log["message"] for log in body["logs"]), body["logs"]


def test_unhandled_exception_is_an_unconfirmed_500_and_rolls_back(make):
    bench = make()
    bench.app.testing = False
    http = bench.client("admin")
    response = http.post("/bench/_preview/boom", headers=ROLLBACK)
    assert response.status_code == 500 and "preference-applied" not in {k.lower() for k, _ in response.headers}
    assert bench.stored() == [] and bench.checked_out() == 0
    assert http.post("/items", json={"id": "ok", "name": "Ok"}).status_code == 201


def test_denials_never_become_envelopes_and_write_nothing(make):
    bench = make()
    anonymous = bench.client().post("/bench/_preview/items", json={"id": "a", "name": "A"}, headers=ROLLBACK)
    viewer = bench.client("viewer").post("/bench/_preview/items", json={"id": "a", "name": "A"}, headers=ROLLBACK)
    assert (anonymous.status_code, viewer.status_code) == (401, 403)
    assert "rolledBack" not in anonymous.get_json() and "rolledBack" not in viewer.get_json()
    assert bench.stored() == [] and bench.delivered == []


def test_capabilities_follow_the_signed_in_identity(make):
    bench = make()
    assert bench.client().get("/bench/_api/capabilities").get_json()["identity"] is None
    caps = bench.client("admin").get("/bench/_api/capabilities").get_json()
    assert caps["identity"] == {"name": "Admin", "role": "admin"} and caps["database"] == "db"
    assert bench.client("viewer").get("/bench/_api/capabilities").get_json()["identity"]["role"] == "viewer"


def test_traces_belong_to_their_owner_and_expire(make):
    clock = Clock()
    bench = make(clock=clock)
    admin = bench.client("admin")
    sent = admin.post("/items", json={"id": "t", "name": "T"}, headers={"Prefer": "trace"}, buffered=True)
    path = f"/bench/_api/traces/{sent.headers['X-TestBench-Trace']}"
    assert admin.get(path).status_code == 200
    assert bench.client("viewer").get(path).status_code == 404
    assert bench.client().get(path).status_code == 404
    clock.now = 5
    assert admin.get(path).status_code == 404
    assert bench.stored() == ["t"]


def test_every_enrolled_bind_is_rolled_back(make):
    bench = make(extra_bind=True)
    body = bench.client("admin").post("/bench/_preview/audited", headers=ROLLBACK).get_json()
    assert body["rolledBack"] is True and {c["table"] for c in body["changes"]} == {"items", "audit"}
    assert bench.stored() == [] and bench.stored(bench.Audit) == []


def test_a_bind_that_is_not_enrolled_is_not_rolled_back(make):
    bench = make(extra_bind=True, enroll_extra_bind=False)
    body = bench.client("admin").post("/bench/_preview/audited", headers=ROLLBACK).get_json()
    # Only the enrolled engine is captured and rolled back; the other bind committed for real.
    assert {c["table"] for c in body["changes"]} == {"items"}
    assert bench.stored() == [] and bench.stored(bench.Audit) == ["audit"]
