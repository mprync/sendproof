"""Security regressions for the FastAPI adapter: preview dispatch, rollback and redaction."""

import json

import httpx
import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import String, create_engine, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column
from starlette.middleware.sessions import SessionMiddleware

from sendproof_core import PreviewProvider, PreviewSession
from sendproof_fastapi import Sendproof, preview
from sendproof_sqlalchemy import SQLAlchemyPreview

ROLLBACK = {"Prefer": "tx=rollback"}


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "accounts"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    password_hash: Mapped[str] = mapped_column(String)


def build(tmp_path, **engine_options):
    engine = create_engine(f"sqlite:///{tmp_path / 'db.sqlite'}", **engine_options)
    Base.metadata.create_all(engine)
    app = FastAPI()

    def db():
        with Session(engine) as session:
            yield session

    return app, engine, db


def client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def stored(engine):
    with Session(engine) as session:
        return sorted(session.scalars(select(Account.id)))


async def test_path_based_host_middleware_guards_the_preview_target(tmp_path):
    app, engine, db = build(tmp_path)

    @app.middleware("http")
    async def admin_only(request: Request, call_next):
        if request.url.path.startswith("/admin") and request.headers.get("x-admin") != "yes":
            return JSONResponse({"detail": "admins only"}, status_code=403)
        return await call_next(request)

    @app.post("/admin/accounts", status_code=201)
    @preview
    def create(session: Session = Depends(db)):
        session.add(Account(id="a", password_hash="x"))
        session.commit()
        return {"ok": True}

    Sendproof(app, provider=SQLAlchemyPreview(engine, database="db"), environment="Development")
    async with client(app) as http:
        denied = await http.post("/sendproof/_preview/admin/accounts", headers=ROLLBACK)
        assert denied.status_code == 403 and "rolledBack" not in denied.json()
        allowed = await http.post("/sendproof/_preview/admin/accounts", headers={**ROLLBACK, "x-admin": "yes"})
        assert allowed.status_code == 200 and allowed.json()["status"] == 201
    assert stored(engine) == []


async def test_preview_session_changes_never_reach_the_real_response(tmp_path):
    app, engine, _ = build(tmp_path)
    app.add_middleware(SessionMiddleware, secret_key="tests")

    @app.post("/sign-in")
    @preview
    def sign_in(request: Request):
        request.session["user"] = "mallory"
        return {"ok": True}

    Sendproof(app, provider=SQLAlchemyPreview(engine, database="db"), environment="Development")
    async with client(app) as http:
        response = await http.post("/sendproof/_preview/sign-in", headers=ROLLBACK)
        assert response.status_code == 200 and response.json()["status"] == 200
        assert "set-cookie" not in response.headers
        assert "set-cookie" not in response.json()["headers"]
        assert "session" not in http.cookies


async def test_middleware_that_reroutes_the_inner_request_is_refused(tmp_path):
    app, engine, db = build(tmp_path)

    class MethodOverride:
        """Rewrites POST /accounts to DELETE, as a method-override middleware would."""

        def __init__(self, inner):
            self.inner = inner

        async def __call__(self, scope, receive, send):
            if scope["type"] == "http" and scope["path"] == "/accounts" and scope["method"] == "POST":
                scope = {**scope, "method": "DELETE"}
            await self.inner(scope, receive, send)

    app.add_middleware(MethodOverride)

    @app.post("/accounts")
    @preview
    def create():
        return {"ok": True}

    ran = []

    @app.delete("/accounts")
    def delete_everything(session: Session = Depends(db)):
        ran.append("delete")  # an outside effect a rollback could not undo
        session.add(Account(id="unmarked-ran", password_hash="x"))
        session.commit()
        return {"deleted": True}

    Sendproof(app, provider=SQLAlchemyPreview(engine, database="db"), environment="Development")
    async with client(app) as http:
        response = await http.post("/sendproof/_preview/accounts", headers=ROLLBACK)
    assert response.status_code == 409 and "rolledBack" not in response.json()
    assert ran == [] and stored(engine) == []


class Abort(BaseException):
    """Stands in for cancellation or a client abort, which are not ``Exception`` subclasses."""


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


async def test_aborted_handler_is_still_rolled_back_and_closed():
    app = FastAPI()

    @app.post("/abort")
    @preview
    async def abort():
        raise Abort()

    provider = RecordingProvider()
    Sendproof(app, provider=provider, environment="Development")
    async with client(app) as http:
        with pytest.raises(Abort):
            await http.post("/sendproof/_preview/abort", headers=ROLLBACK)
    assert provider.calls == ["rollback", "close"]


async def test_handler_commit_cannot_escape_the_preview(tmp_path):
    app, engine, db = build(tmp_path)

    @app.post("/accounts")
    @preview
    def create(session: Session = Depends(db)):
        session.add(Account(id="escaped", password_hash="x"))
        session.flush()
        session.execute(text("COMMIT"))
        return {"ok": True}

    @app.post("/autocommit")
    @preview
    def autocommit(session: Session = Depends(db)):
        session.add(Account(id="autocommitted", password_hash="x"))
        session.commit()
        with engine.connect() as connection:
            connection.execution_options(isolation_level="AUTOCOMMIT")
        return {"ok": True}

    Sendproof(app, provider=SQLAlchemyPreview(engine, database="db"), environment="Development")
    async with client(app) as http:
        for path in ("/sendproof/_preview/accounts", "/sendproof/_preview/autocommit"):
            response = await http.post(path, headers=ROLLBACK)
            assert response.status_code == 500 and "rolledBack" not in response.json()
    assert stored(engine) == []


async def test_secret_columns_and_sql_echo_never_appear_in_the_envelope(tmp_path):
    app, engine, db = build(tmp_path, echo=True)

    @app.post("/accounts", status_code=201)
    @preview
    def create(session: Session = Depends(db)):
        session.add(Account(id="a", password_hash="pbkdf2-s3cret-value"))
        session.commit()
        session.execute(text("UPDATE accounts SET password_hash = :v WHERE id = 'a'"), {"v": "s3cret-two"})
        return {"ok": True}

    Sendproof(app, provider=SQLAlchemyPreview(engine, database="db"), environment="Development")
    async with client(app) as http:
        response = await http.post("/sendproof/_preview/accounts", headers=ROLLBACK)
    body = response.json()
    assert response.status_code == 200 and body["status"] == 201
    assert body["changes"][0]["after"] == {"id": "a", "password_hash": "[REDACTED]"}
    assert "s3cret" not in json.dumps(body)
    assert any(entry.get("sql") for entry in body["logs"])  # the redacted SQL entries remain
