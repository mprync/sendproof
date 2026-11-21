import httpx
import pytest
from fastapi import Depends, FastAPI, HTTPException
from sqlalchemy import String, create_engine, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from sendproof_core import AuthProvider, record_email
from sendproof_fastapi import Identity, Sendproof, preview
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


def build(tmp_path, *, environment="Development", provider=True, authorize=None, clock=None):
    engine = create_engine(f"sqlite:///{tmp_path / 'db.sqlite'}")
    Base.metadata.create_all(engine)
    app = FastAPI(title="Inventory")

    def db():
        with Session(engine) as session:
            yield session

    @app.post("/items", status_code=201)
    @preview
    def create(item: dict, session: Session = Depends(db)):
        session.add(Item(id=item["id"], name=item["name"]))
        session.commit()
        if not record_email("Created", "a@x", ["b@x"], [], "Hi", "Body"):
            app.state.sent = getattr(app.state, "sent", 0) + 1
        return item

    @app.post("/boom")
    @preview
    def boom(session: Session = Depends(db)):
        session.add(Item(id="boom", name="x"))
        session.flush()
        raise RuntimeError("unhandled")

    @app.post("/plain")
    def plain(session: Session = Depends(db)):
        session.add(Item(id="plain", name="x"))
        session.commit()
        return {"ok": True}

    kwargs = {}
    if clock is not None:
        kwargs["clock"] = clock
    sqlalchemy_provider = SQLAlchemyPreview(engine, database="db") if provider else None
    bench = Sendproof(
        app,
        provider=sqlalchemy_provider,
        environment=environment,
        identity=lambda request: Identity("Alex", "admin", "alex", "test") if request.headers.get("x-user") else None,
        authorize=authorize,
        auth_providers=[AuthProvider("Password", "cookie", "/auth")],
        trace_ttl=5,
        **kwargs,
    )
    return app, engine, bench


def client(app, **kwargs):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", **kwargs)


def stored(engine):
    with Session(engine) as session:
        return sorted(item.id for item in session.scalars(select(Item)))


async def test_disabled_by_default_everywhere(tmp_path, monkeypatch):
    monkeypatch.delenv("SENDPROOF_ENVIRONMENT", raising=False)
    app, engine, _ = build(tmp_path, environment=None)
    async with client(app) as http:
        assert (await http.get("/sendproof/_api/capabilities")).status_code == 404
        assert (await http.post("/sendproof/_preview/items", json={}, headers=ROLLBACK)).status_code == 404
        # Ordinary routes are untouched, including a stray rollback preference.
        assert (await http.post("/plain", headers=ROLLBACK)).status_code == 200
    assert stored(engine) == ["plain"]


async def test_preview_rolls_back_and_suppresses_effects(tmp_path):
    app, engine, _ = build(tmp_path)
    async with client(app) as http:
        response = await http.post("/sendproof/_preview/items", json={"id": "a", "name": "A"}, headers=ROLLBACK)
        body = response.json()
        assert response.status_code == 200 and body["rolledBack"] is True and body["status"] == 201
        assert response.headers["preference-applied"] == "tx=rollback"
        assert "server-timing" in response.headers and "db;dur=" in response.headers["server-timing"]
        assert body["changes"][0]["operation"] == "insert"
        assert body["effects"][0]["description"] == "Created" and "delivered" not in body["effects"][0]
        assert getattr(app.state, "sent", 0) == 0  # delivery suppressed
        assert stored(engine) == []
        assert (await http.post("/items", json={"id": "a", "name": "A"})).status_code == 201
        assert app.state.sent == 1 and stored(engine) == ["a"]


async def test_unhandled_exception_is_an_unconfirmed_500_and_still_rolls_back(tmp_path):
    app, engine, _ = build(tmp_path)
    async with client(app) as http:
        response = await http.post("/sendproof/_preview/boom", headers=ROLLBACK)
    assert response.status_code == 500 and "rolledBack" not in response.json()
    assert "preference-applied" not in response.headers
    assert stored(engine) == []


async def test_unmarked_and_unknown_targets_do_not_execute(tmp_path):
    app, engine, _ = build(tmp_path)
    async with client(app) as http:
        assert (await http.post("/sendproof/_preview/plain", headers=ROLLBACK)).status_code == 409
        assert (await http.post("/sendproof/_preview/nope", headers=ROLLBACK)).status_code == 404
        assert (await http.get("/sendproof/_preview/items", headers=ROLLBACK)).status_code == 405
    assert stored(engine) == []


async def test_no_provider_advertises_nothing_and_refuses_previews(tmp_path):
    app, engine, _ = build(tmp_path, provider=False)
    async with client(app) as http:
        capabilities = (await http.get("/sendproof/_api/capabilities")).json()
        assert capabilities["previewOperations"] == [] and capabilities["database"] is None
        assert (await http.post("/sendproof/_preview/items", json={"id": "x", "name": "x"}, headers=ROLLBACK)).status_code == 503
    assert stored(engine) == []


async def test_workbench_authorization_hook(tmp_path):
    app, _, _ = build(tmp_path, authorize=lambda request, identity: identity is not None and identity.role == "admin")
    async with client(app) as http:
        assert (await http.get("/sendproof/_api/capabilities")).status_code == 401
        assert (await http.get("/sendproof/_api/capabilities", headers={"x-user": "1"})).status_code == 200


async def test_trace_is_owner_scoped_and_expires_with_the_injected_clock(tmp_path):
    clock = Clock()
    app, engine, _ = build(tmp_path, clock=clock)
    async with client(app) as http:
        anonymous = await http.post("/items", json={"id": "t0", "name": "T"}, headers={"Prefer": "trace"})
        assert "x-sendproof-trace" not in anonymous.headers
        sent = await http.post("/items", json={"id": "t1", "name": "T"}, headers={"Prefer": "trace", "x-user": "1"})
        trace_id = sent.headers["x-sendproof-trace"]
        assert stored(engine) == ["t0", "t1"]
        found = await http.get(f"/sendproof/_api/traces/{trace_id}", headers={"x-user": "1"})
        assert found.status_code == 200 and found.json()["effects"][0]["delivered"] is True
        assert found.headers["cache-control"] == "no-store"
        assert (await http.get(f"/sendproof/_api/traces/{trace_id}")).status_code == 404
        clock.now = 5
        assert (await http.get(f"/sendproof/_api/traces/{trace_id}", headers={"x-user": "1"})).status_code == 404


async def sendproof_after_startup_is_rejected(tmp_path):
    app, _, _ = build(tmp_path)
    async with client(app) as http:
        await http.get("/sendproof/_api/capabilities")
    with pytest.raises(RuntimeError):
        Sendproof(app, environment="Development")


async def test_async_endpoints_with_an_async_engine(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'async.sqlite'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    app = FastAPI(title="Async")

    @app.post("/items", status_code=201)
    @preview
    async def create(item: dict):
        async with maker() as session:
            session.add(Item(id=item["id"], name=item["name"]))
            await session.commit()
        async with maker() as other:
            if await other.get(Item, item["id"]) is None:
                raise HTTPException(500, "not visible")
        return item

    Sendproof(app, provider=SQLAlchemyPreview(engine, database="async"), environment="Development")
    async with client(app) as http:
        response = await http.post("/sendproof/_preview/items", json={"id": "a", "name": "A"}, headers=ROLLBACK)
        assert response.status_code == 200 and response.json()["status"] == 201
        assert response.json()["changes"][0]["key"] == {"id": "a"}
        async with maker() as session:
            assert list(await session.scalars(select(Item))) == []
        assert (await http.post("/items", json={"id": "b", "name": "B"})).status_code == 201
    await engine.dispose()
