"""Security regressions for the Flask adapter: preview dispatch and rollback on interruption."""

import pytest
from flask import Flask, jsonify
from sqlalchemy import String, create_engine, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from sendproof_core import PreviewProvider, PreviewSession
from sendproof_flask import Sendproof, preview
from sendproof_sqlalchemy import SQLAlchemyPreview

ROLLBACK = {"Prefer": "tx=rollback"}


class Base(DeclarativeBase):
    pass


class Note(Base):
    __tablename__ = "notes"
    id: Mapped[str] = mapped_column(String, primary_key=True)


def build(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'db.sqlite'}")
    Base.metadata.create_all(engine)
    app = Flask(__name__)

    def write(note_id):
        with Session(engine) as db:
            db.add(Note(id=note_id))
            db.commit()

    return app, engine, write


def stored(engine):
    with Session(engine) as db:
        return sorted(db.scalars(select(Note.id)))


def test_path_based_wsgi_middleware_wrapped_later_guards_the_preview_target(tmp_path):
    app, engine, write = build(tmp_path)

    @app.post("/admin/notes")
    @preview
    def create():
        write("admin")
        return jsonify(ok=True), 201

    Sendproof(app, provider=SQLAlchemyPreview(engine, database="db"), environment="Development")
    inner = app.wsgi_app

    def admin_only(environ, start_response):
        if environ["PATH_INFO"].startswith("/admin") and environ.get("HTTP_X_ADMIN") != "yes":
            start_response("403 Forbidden", [("Content-Type", "text/plain")])
            return [b"admins only"]
        return inner(environ, start_response)

    app.wsgi_app = admin_only  # wrapped around Sendproof after it was installed
    http = app.test_client()
    denied = http.post("/sendproof/_preview/admin/notes", headers=ROLLBACK)
    assert denied.status_code == 403 and "rolledBack" not in denied.get_json()
    allowed = http.post("/sendproof/_preview/admin/notes", headers={**ROLLBACK, "X-Admin": "yes"})
    assert allowed.status_code == 200 and allowed.get_json()["status"] == 201
    assert stored(engine) == []


def test_method_override_inside_sendproof_cannot_reach_an_unmarked_view(tmp_path):
    app, engine, write = build(tmp_path)

    @app.post("/notes")
    @preview
    def create():
        return jsonify(ok=True)

    ran = []

    @app.delete("/notes")
    def delete_everything():
        ran.append("delete")  # an outside effect a rollback could not undo
        write("unmarked-ran")
        return jsonify(deleted=True)

    original = app.wsgi_app

    def method_override(environ, start_response):
        override = environ.get("HTTP_X_HTTP_METHOD_OVERRIDE")
        if override:
            environ = {**environ, "REQUEST_METHOD": override}
        return original(environ, start_response)

    app.wsgi_app = method_override  # installed before Sendproof, so it runs inside it
    Sendproof(app, provider=SQLAlchemyPreview(engine, database="db"), environment="Development")
    response = app.test_client().post(
        "/sendproof/_preview/notes", headers={**ROLLBACK, "X-HTTP-Method-Override": "DELETE"}
    )
    assert response.status_code == 409 and "rolledBack" not in response.get_json()
    assert ran == [] and stored(engine) == []


def test_raw_commit_in_a_preview_fails_closed(tmp_path):
    app, engine, _ = build(tmp_path)

    @app.post("/notes")
    @preview
    def create():
        with Session(engine) as db:
            db.add(Note(id="escaped"))
            db.flush()
            db.execute(text("COMMIT"))
        return jsonify(ok=True)

    Sendproof(app, provider=SQLAlchemyPreview(engine, database="db"), environment="Development")
    response = app.test_client().post("/sendproof/_preview/notes", headers=ROLLBACK)
    assert response.status_code == 500 and "rolledBack" not in response.get_json()
    assert stored(engine) == []


class Abort(BaseException):
    """Stands in for SystemExit or gevent.Timeout, which are not ``Exception`` subclasses."""


class RecordingSession(PreviewSession):
    def __init__(self, calls):
        self.calls = calls

    @property
    def changes(self):
        return []

    def rollback(self):
        self.calls.append("rollback")

    def close(self):
        self.calls.append("close")


class RecordingProvider(PreviewProvider):
    database = "recording"

    def __init__(self):
        self.calls = []

    def begin(self, scope):
        return RecordingSession(self.calls)


def test_interrupted_view_is_still_rolled_back_and_closed():
    app = Flask(__name__)

    @app.post("/abort")
    @preview
    def abort_view():
        raise Abort()

    provider = RecordingProvider()
    Sendproof(app, provider=provider, environment="Development")
    with pytest.raises(Abort):
        app.test_client().post("/sendproof/_preview/abort", headers=ROLLBACK)
    assert provider.calls == ["rollback", "close"]
