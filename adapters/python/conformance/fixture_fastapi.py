"""Conformance fixture: a disposable FastAPI + SQLAlchemy app for the shared protocol runner.

Environment variables (set by the runner): ``PORT``, ``BENCH_PATH_BASE`` (empty or ``/tenant``)
and ``BENCH_SCENARIO`` (``standard``, ``disabled``, ``no-provider`` or ``rollback-failure``).
Each process starts with an empty ``items`` table in a temporary SQLite file.
"""

from __future__ import annotations

import logging
import os
import secrets
import shutil
import tempfile
import time
from pathlib import Path
from typing import Iterator

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import String, create_engine, event, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from starlette.applications import Starlette
from starlette.routing import Mount, Route

from sendproof_core import PreviewRollbackError, PreviewSession, RequestScope, record_effect, record_email
from sendproof_fastapi import AuthProvider, Identity, Sendproof, preview
from sendproof_sqlalchemy import SQLAlchemyPreview

from fixture_stores import REMEMBERABLE, AsyncStores
from fixture_database import JOURNEY_FILE, sqlite_path

PORT = int(os.environ.get("PORT", "8000"))
BASE = os.environ.get("BENCH_PATH_BASE", "").rstrip("/")
SCENARIO = os.environ.get("BENCH_SCENARIO", "standard")
TRACE_TTL_SECONDS = 5.0

logging.getLogger("fixture").setLevel(logging.INFO)
log = logging.getLogger("fixture")

# ----------------------------------------------------------------------------- database
_directory = Path(tempfile.mkdtemp(prefix="sendproof-fixture-"))
engine = create_engine(f"sqlite:///{sqlite_path(_directory)}")


@event.listens_for(engine, "connect")
def _use_write_ahead_log(connection, _record) -> None:
    """Readers no longer block the single writer, as a service that serves concurrent traffic from SQLite configures it.

    The default rollback journal made ordinary writes fail with "database is locked" under sustained concurrent load.
    """
    connection.execute("PRAGMA journal_mode=WAL")


class Base(DeclarativeBase):
    pass


class Item(Base):
    __tablename__ = "items"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)


class Account(Base):
    __tablename__ = "accounts"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    email: Mapped[str] = mapped_column(String)
    password_hash: Mapped[str] = mapped_column(String)


Base.metadata.create_all(engine)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session


# -------------------------------------------------------------------------------- users
USERS = {
    "admin@example.test": {"name": "Fixture Admin", "role": "admin", "password": "bench-fixture"},
    "viewer@example.test": {"name": "Fixture Viewer", "role": "viewer", "password": "bench-fixture"},
}
SESSIONS: dict[str, str] = {}
COOKIE = "fixture_session"
OUTBOX: list[dict] = []  # emails that were really delivered


def user_of(request: Request) -> dict | None:
    email = SESSIONS.get(request.cookies.get(COOKIE, ""))
    return None if email is None else {"email": email, **USERS[email]}


def identity(request: Request) -> Identity | None:
    user = user_of(request)
    return None if user is None else Identity(user["name"], user["role"], user["email"], "cookie")


def require_user(request: Request) -> dict:
    user = user_of(request)
    if user is None:
        raise HTTPException(401, "Sign in first.")
    return user


def require_admin(user: dict = Depends(require_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, "Only admins can write.")
    return user


def start_session(email: str) -> Response:
    token = secrets.token_urlsafe(24)
    SESSIONS[token] = email
    response = JSONResponse({"email": email, "name": USERS[email]["name"], "role": USERS[email]["role"]})
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", path="/")
    return response


# --------------------------------------------------------------------------------- app
app = FastAPI(title="Sendproof Conformance")


class ItemIn(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)


class ItemPatch(BaseModel):
    name: str = Field(min_length=1)


def body_of(item: Item) -> dict:
    return {"id": item.id, "name": item.name}


@app.get("/ready", include_in_schema=False)
def ready() -> dict:
    return {"status": "ready"}


@app.post("/auth/sign-in", include_in_schema=False)
def sign_in(credentials: dict):
    user = USERS.get(str(credentials.get("email")))
    if user is None or not secrets.compare_digest(user["password"], str(credentials.get("password"))):
        raise HTTPException(401, "Incorrect email or password.")
    return start_session(str(credentials["email"]))


@app.get("/auth/personas", include_in_schema=False)
def personas(user: dict = Depends(require_admin)):
    return [{"email": e, "name": u["name"], "role": u["role"]} for e, u in USERS.items()]


@app.post("/auth/personas/{email}", include_in_schema=False)
def switch_persona(email: str, user: dict = Depends(require_admin)):
    if email not in USERS:
        raise HTTPException(404, "Unknown persona.")
    return start_session(email)


@app.get("/items/{id}")
def read_item(id: str, hold: bool = False, db: Session = Depends(get_db), user: dict = Depends(require_user)):
    if hold:
        time.sleep(1)
    item = db.get(Item, id)
    if item is None:
        raise HTTPException(404, "Item not found.")
    return body_of(item)


@app.post("/items", status_code=201)
@preview
def create_item(item: ItemIn, db: Session = Depends(get_db), user: dict = Depends(require_admin)):
    entity = Item(id=item.id, name=item.name)
    db.add(entity)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Item already exists.")
    db.refresh(entity)  # the usual commit-then-refresh pattern must work inside a preview
    db.execute(text("SELECT :fixture_secret"), {"fixture_secret": "fixture-secret-value"})
    log.info("created:%s", item.id)
    if not record_email("Created item", "noreply@example.test", ["ops@example.test"], [], "Item created", item.name):
        OUTBOX.append({"subject": "Item created", "id": item.id})
    return body_of(entity)


@app.patch("/items/{id}")
@preview
def rename_item(id: str, patch: ItemPatch, response: Response, tag: str | None = Query(None),
                db: Session = Depends(get_db), user: dict = Depends(require_admin)):
    entity = db.get(Item, id)
    if entity is None:
        raise HTTPException(404, "Item not found.")
    entity.name = patch.name
    db.commit()
    if tag is not None:
        response.headers["X-Fixture-Tag"] = tag
    return body_of(entity)


@app.delete("/items/{id}", status_code=204)
@preview
def delete_item(id: str, db: Session = Depends(get_db), user: dict = Depends(require_admin)):
    entity = db.get(Item, id)
    if entity is None:
        raise HTTPException(404, "Item not found.")
    db.delete(entity)
    db.commit()


@app.post("/items/{id}/fail")
@preview
def fail_item(id: str, db: Session = Depends(get_db), user: dict = Depends(require_admin)):
    db.add(Item(id=id, name="Failing"))
    db.flush()
    raise HTTPException(409, "The operation failed after writing.")


@app.post("/items/{id}/large")
@preview
def large_item(id: str, db: Session = Depends(get_db), user: dict = Depends(require_admin)):
    db.add(Item(id=id, name="Large"))
    db.commit()
    return {"id": id, "padding": "x" * (1024 * 1024 + 512)}


@app.post("/items/{id}/redirect")
@preview
def redirect_item(id: str, db: Session = Depends(get_db), user: dict = Depends(require_admin)):
    db.add(Item(id=id, name="Redirected"))
    db.commit()
    return Response(status_code=302, headers={"Location": f"{BASE}/items/{id}", "Set-Cookie": "inner=secret; Path=/"})


@app.post("/items/{id}/capture")
@preview
def capture_items(id: str, db: Session = Depends(get_db), user: dict = Depends(require_admin)):
    db.add_all(Item(id=f"{id}-{n}", name=f"Captured {n}") for n in range(201))
    db.commit()
    for n in range(101):
        record_effect("message", f"Published {n}", {"topic": "items", "payload": {"n": n}})
    for n in range(501):
        log.info("capture:%s", n)
    return {"created": 201}


@app.post("/items/{id}/ordinary", status_code=201)
def ordinary_item(id: str, db: Session = Depends(get_db), user: dict = Depends(require_admin)):
    db.add(Item(id=id, name="Ordinary"))
    db.commit()
    return {"id": id, "name": "Ordinary"}


# ------------------------------------------------------------------ shared security rules
class AccountIn(BaseModel):
    id: str = Field(min_length=1)
    email: str = Field(min_length=1)
    password: str = Field(min_length=1)


@app.post("/accounts", status_code=201)
@preview
def create_account(account: AccountIn, db: Session = Depends(get_db), user: dict = Depends(require_admin)):
    db.add(Account(id=account.id, email=account.email, password_hash="hashed:" + account.password))
    db.commit()
    return {"id": account.id, "email": account.email}


@app.get("/accounts/{id}")
def read_account(id: str, db: Session = Depends(get_db), user: dict = Depends(require_user)):
    account = db.get(Account, id)
    if account is None:
        raise HTTPException(404, "Account not found.")
    return {"id": account.id, "email": account.email}


@app.post("/items/{id}/commit", status_code=201)
@preview
def commit_item(id: str, patch: ItemPatch, db: Session = Depends(get_db), user: dict = Depends(require_admin)):
    db.add(Item(id=id, name=patch.name))
    db.flush()
    db.execute(text("COMMIT"))  # a handler that ends the transaction itself: a Preview must refuse it
    return {"id": id, "name": patch.name}


# ------------------------------------------------------------------------- data stores
# Present only when the runner passes a store's variables. FastAPI uses the asynchronous clients
# (AsyncMongoClient, redis.asyncio, aioboto3); the Flask and Django fixtures use the synchronous ones.
stores = AsyncStores()


def reply(result: tuple[int, object]) -> Response:
    status, body = result
    return Response(status_code=status) if body is None else JSONResponse(body, status_code=status)


class DocumentIn(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    city: str = Field(min_length=1)
    password: str = Field(min_length=1)


class DocumentPatch(BaseModel):
    name: str | None = None
    city: str | None = None


if "mongodb" in stores.stores:
    @app.get("/documents/{id}")
    @preview
    async def read_document(id: str, user: dict = Depends(require_user)):
        return reply(await stores.get_document(id))

    @app.post("/documents", status_code=201)
    @preview
    async def create_document(document: DocumentIn, user: dict = Depends(require_admin)):
        return reply(await stores.create_document(document.model_dump()))

    @app.patch("/documents/{id}")
    @preview
    async def patch_document(id: str, patch: DocumentPatch, user: dict = Depends(require_admin)):
        return reply(await stores.patch_document(id, patch.model_dump()))

    @app.post("/documents/archive", status_code=204)
    @preview
    async def archive_documents(user: dict = Depends(require_admin)):
        return reply(await stores.archive_documents())

    @app.delete("/documents/{id}", status_code=204)
    @preview(False, stores=["mongodb"])
    async def delete_document(id: str, user: dict = Depends(require_admin)):
        return reply(await stores.delete_document(id))

if "redis" in stores.stores:
    @app.get("/counters/{key}")
    @preview
    async def read_counter(key: str, user: dict = Depends(require_user)):
        return reply(await stores.get_counter(key))

    @app.post("/counters/{key}")
    @preview
    async def increment_counter(key: str, user: dict = Depends(require_admin)):
        return reply(await stores.incr_counter(key))

    @app.post("/counters/{key}/take")
    @preview
    async def take_counter(key: str, user: dict = Depends(require_admin)):
        return reply(await stores.take_counter(key))

    @app.delete("/counters/{key}", status_code=204)
    @preview(False, stores=["redis"])
    async def delete_counter(key: str, user: dict = Depends(require_admin)):
        return reply(await stores.delete_counter(key))

if "dynamodb" in stores.stores:
    @app.get("/orders/{id}")
    @preview
    async def read_order(id: str, user: dict = Depends(require_user)):
        return reply(await stores.get_order(id))

    @app.post("/orders/{id}/touch")
    @preview
    async def touch_order(id: str, user: dict = Depends(require_admin)):
        return reply(await stores.touch_order(id))

    @app.post("/orders/{id}/cancel")
    @preview
    async def cancel_order(id: str, user: dict = Depends(require_admin)):
        return reply(await stores.cancel_order(id))

    @app.delete("/orders/{id}", status_code=204)
    @preview(False, stores=["dynamodb"])
    async def delete_order(id: str, user: dict = Depends(require_admin)):
        return reply(await stores.delete_order(id))

if "cassandra" in stores.stores:
    @app.get("/tickets/{id}")
    @preview
    async def read_ticket(id: str, user: dict = Depends(require_user)):
        return reply(await stores.get_ticket(id))

    @app.post("/tickets/{id}/touch")
    @preview
    async def touch_ticket(id: str, user: dict = Depends(require_admin)):
        return reply(await stores.touch_ticket(id))

    @app.post("/tickets/{id}/close")
    @preview
    async def close_ticket(id: str, user: dict = Depends(require_admin)):
        return reply(await stores.close_ticket(id))

    @app.delete("/tickets/{id}", status_code=204)
    @preview(False, stores=["cassandra"])
    async def delete_ticket(id: str, user: dict = Depends(require_admin)):
        return reply(await stores.delete_ticket(id))

if "opensearch" in stores.stores:
    @app.get("/articles/{id}")
    @preview
    async def read_article(id: str, user: dict = Depends(require_user)):
        return reply(await stores.get_article(id))

    @app.post("/articles/{id}/touch")
    @preview
    async def touch_article(id: str, user: dict = Depends(require_admin)):
        return reply(await stores.touch_article(id))

    @app.post("/articles/{id}/hide")
    @preview
    async def hide_article(id: str, user: dict = Depends(require_admin)):
        return reply(await stores.hide_article(id))

    @app.delete("/articles/{id}", status_code=204)
    @preview(False, stores=["opensearch"])
    async def delete_article(id: str, user: dict = Depends(require_admin)):
        return reply(await stores.delete_article(id))

if set(REMEMBERABLE) & set(stores.stores):
    @app.post("/items/{id}/remember", status_code=201)
    @preview
    async def remember_item(id: str, patch: ItemPatch, store: str = Query(...), db: Session = Depends(get_db),
                            user: dict = Depends(require_admin)):
        if store not in REMEMBERABLE or store not in stores.stores:
            raise HTTPException(400, "Unknown store.")
        db.add(Item(id=id, name=patch.name))
        db.commit()
        await stores.remember(store, id)
        return {"id": id, "name": patch.name}


# ----------------------------------------------------------------------- Sendproof
class RollbackFailingProvider(SQLAlchemyPreview):
    """Rolls back for real, then reports an injected failure so the transport withholds confirmation."""

    def begin(self, scope: RequestScope) -> PreviewSession:
        inner = super().begin(scope)

        class Failing(type(inner)):  # type: ignore[misc]
            async def arollback(self) -> None:  # noqa: D401
                await super().arollback()
                raise PreviewRollbackError("Injected rollback failure.")

        inner.__class__ = Failing
        return inner


provider = None
if SCENARIO == "rollback-failure":
    provider = RollbackFailingProvider(engine, database="fixture")
elif SCENARIO != "no-provider":
    provider = SQLAlchemyPreview(engine, database="fixture")

Sendproof(
    app,
    provider=provider,
    data_stores=stores.data_stores,
    identity=identity,
    environment="Production" if SCENARIO == "disabled" else "Development",
    auth_providers=[
        AuthProvider("Fixture password", "cookie", "/auth/sign-in"),
        AuthProvider("Fixture personas", "personas", "/auth/personas"),
    ],
    trace_ttl=TRACE_TTL_SECONDS,
    journey_files=[JOURNEY_FILE],
)

# Mount under the path base so that the workbench is absent without the prefix.
root = Starlette(routes=[Route("/ready", lambda request: JSONResponse({"status": "ready"})), Mount(BASE, app=app)]) if BASE else app

if __name__ == "__main__":
    try:
        uvicorn.run(root, host="127.0.0.1", port=PORT, log_level="warning")
    finally:
        shutil.rmtree(_directory, ignore_errors=True)
