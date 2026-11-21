import pytest
from flask import Flask, abort, jsonify, request, session
from sqlalchemy import String, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from sendproof_core import record_email
from sendproof_flask import AuthProvider, Identity, Sendproof, preview
from sendproof_sqlalchemy import SQLAlchemyPreview

ROLLBACK = {"Prefer": "tx=rollback"}


class Base(DeclarativeBase):
    pass


class Item(Base):
    __tablename__ = "items"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)


class Clock:
    now = 0.0

    def __call__(self):
        return self.now


def build(tmp_path, *, environment="Development", provider=True, clock=None):
    engine = create_engine(f"sqlite:///{tmp_path / 'db.sqlite'}")
    Base.metadata.create_all(engine)
    app = Flask(__name__)
    app.secret_key = "test"
    sent = []

    @app.post("/items")
    @preview
    def create():
        if session.get("user") != "alex":  # flask.session works inside the handler
            abort(401)
        data = request.get_json()
        with Session(engine) as db:
            db.add(Item(id=data["id"], name=data["name"]))
            db.commit()
        if not record_email("Created", "a@x", ["b@x"], [], "Hi", "Body"):
            sent.append(data["id"])
        return jsonify(data), 201

    @app.post("/boom")
    @preview
    def boom():
        with Session(engine) as db:
            db.add(Item(id="boom", name="x"))
            db.commit()
        raise RuntimeError("unhandled")

    @app.get("/items/<id>")
    @preview
    def read(id):  # marked, but GET is not a write method, so it is not previewable
        return jsonify(id=id)

    kwargs = {"clock": clock} if clock else {}
    bench = Sendproof(
        app,
        provider=SQLAlchemyPreview(engine, database="db") if provider else None,
        environment=environment,
        # The identity hook runs inside a request context, so flask.session is available.
        identity=lambda req: Identity("Alex", "admin", "alex", "session") if session.get("user") == "alex" else None,
        auth_providers=[AuthProvider("Password", "cookie", "/auth")],
        trace_ttl=5,
        **kwargs,
    )
    return app, engine, bench, sent


def stored(engine):
    with Session(engine) as session_:
        return sorted(item.id for item in session_.scalars(select(Item)))


def signed_in(app):
    http = app.test_client()
    with http.session_transaction() as flask_session:
        flask_session["user"] = "alex"
    return http


def test_disabled_by_default(tmp_path, monkeypatch):
    monkeypatch.delenv("SENDPROOF_ENVIRONMENT", raising=False)
    app, engine, _, _ = build(tmp_path, environment=None)
    http = signed_in(app)
    assert http.get("/sendproof/_api/capabilities").status_code == 404
    assert http.post("/sendproof/_preview/items", json={}, headers=ROLLBACK).status_code == 404


def test_preview_rolls_back_and_suppresses_effects(tmp_path):
    app, engine, _, sent = build(tmp_path)
    http = signed_in(app)
    response = http.post("/sendproof/_preview/items", json={"id": "a", "name": "A"}, headers=ROLLBACK)
    body = response.get_json()
    assert response.status_code == 200 and body["status"] == 201 and body["rolledBack"] is True
    assert body["changes"][0]["operation"] == "insert" and body["effects"][0]["description"] == "Created"
    assert response.headers["Preference-Applied"] == "tx=rollback" and "db;dur=" in response.headers["Server-Timing"]
    assert sent == [] and stored(engine) == []
    assert http.post("/items", json={"id": "a", "name": "A"}).status_code == 201
    assert sent == ["a"] and stored(engine) == ["a"]


def test_denial_inside_the_handler_is_not_an_envelope(tmp_path):
    app, engine, _, _ = build(tmp_path)
    anonymous = app.test_client()
    # The identity is absent, the handler aborts with 401: no confirmed envelope.
    response = anonymous.post("/sendproof/_preview/items", json={"id": "a", "name": "A"}, headers=ROLLBACK)
    assert response.status_code == 401 and "rolledBack" not in response.get_json()


def test_unhandled_exception_is_an_unconfirmed_500_and_rolls_back(tmp_path):
    app, engine, _, _ = build(tmp_path)
    app.testing = False
    response = signed_in(app).post("/sendproof/_preview/boom", headers=ROLLBACK)
    assert response.status_code == 500 and "preference-applied" not in {k.lower() for k in response.headers.keys()}
    assert stored(engine) == []


def test_unmarked_methods_and_unknown_targets_do_not_execute(tmp_path):
    app, engine, _, _ = build(tmp_path)
    http = signed_in(app)
    assert http.post("/sendproof/_preview/nope", headers=ROLLBACK).status_code == 404
    assert http.post("/sendproof/_preview/items/a", headers=ROLLBACK).status_code in (404, 405)


def test_discovery_lists_only_marked_write_operations(tmp_path):
    app, _, bench, _ = build(tmp_path)
    operations = signed_in(app).get("/sendproof/_api/capabilities").get_json()["previewOperations"]
    assert operations == [{"method": "POST", "path": "/boom"}, {"method": "POST", "path": "/items"}]


def test_trace_is_owner_scoped_and_expires(tmp_path):
    clock = Clock()
    app, engine, _, _ = build(tmp_path, clock=clock)
    http = signed_in(app)
    sent = http.post("/items", json={"id": "t", "name": "T"}, headers={"Prefer": "trace"}, buffered=True)
    trace_id = sent.headers["X-Sendproof-Trace"]
    found = http.get(f"/sendproof/_api/traces/{trace_id}")
    assert found.status_code == 200 and found.get_json()["effects"][0]["delivered"] is True
    assert app.test_client().get(f"/sendproof/_api/traces/{trace_id}").status_code == 404
    clock.now = 5
    assert http.get(f"/sendproof/_api/traces/{trace_id}").status_code == 404
    assert stored(engine) == ["t"]


def test_observed_trace_is_published_when_the_body_completes_even_if_the_server_never_closes_it(tmp_path):
    """Werkzeug's development server skips ``close`` when it fails while draining a connection the client reset."""
    app, engine, _, _ = build(tmp_path)
    http = signed_in(app)
    sent = http.post("/items", json={"id": "t", "name": "T"}, headers={"Prefer": "trace"})  # not buffered, so not closed
    assert b"".join(sent.response)  # the server iterates the whole body...
    trace_id = sent.headers["X-Sendproof-Trace"]  # ...and never calls close()
    found = http.get(f"/sendproof/_api/traces/{trace_id}")
    assert found.status_code == 200 and found.get_json()["effects"][0]["delivered"] is True
