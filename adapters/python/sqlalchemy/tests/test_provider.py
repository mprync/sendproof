import pytest
from sqlalchemy import String, create_engine, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from sendproof_core import PreviewRollbackError, PreviewUnavailable, RequestScope
from sendproof_core.capture import Capture
from sendproof_core.scope import activate, deactivate
from sendproof_sqlalchemy import SQLAlchemyPreview, looks_secret


class Base(DeclarativeBase):
    pass


class Item(Base):
    __tablename__ = "items"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)


@pytest.fixture
def engine(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'db.sqlite'}")
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


def names(engine):
    with Session(engine) as session:
        return sorted(row.name for row in session.scalars(select(Item)))


def make_scope(rollback=True, values=True):
    return RequestScope(Capture(rollback=rollback), "Development", values)


class Running:
    """Context manager that mimics what the adapter does around a handler."""

    def __init__(self, provider, rollback=True, values=True):
        self.provider, self.rollback, self.values = provider, rollback, values

    def __enter__(self):
        self.scope = make_scope(self.rollback, self.values)
        self.token = activate(self.scope)
        self.session = self.provider.begin(self.scope) if self.rollback else self.provider.begin_observation(self.scope)
        return self

    def __exit__(self, *exc):
        deactivate(self.token)


def test_preview_sees_its_own_writes_across_sessions_and_rolls_everything_back(engine):
    provider = SQLAlchemyPreview(engine, database="d")
    with Session(engine) as session:
        session.add(Item(id="keep", name="Keep"))
        session.commit()
    with Running(provider) as run:
        with Session(engine) as one:
            one.add(Item(id="a", name="A"))
            one.commit()
            one.refresh(one.get(Item, "a"))  # commit-then-refresh must work
        with Session(engine) as two:  # a different Session in the same request sees the write
            assert two.get(Item, "a").name == "A"
            two.get(Item, "keep").name = "Renamed"
            two.commit()
        run.session.rollback()
        run.session.close()
    assert names(engine) == ["Keep"]
    provider.uninstall()


def test_changes_have_keys_and_before_after_snapshots(engine):
    provider = SQLAlchemyPreview(engine)
    with Session(engine) as session:
        session.add_all([Item(id="u", name="Old"), Item(id="d", name="Gone")])
        session.commit()
    with Running(provider) as run:
        with Session(engine) as session:
            session.add(Item(id="n", name="New"))
            session.get(Item, "u").name = "Updated"
            session.delete(session.get(Item, "d"))
            session.commit()
        run.session.rollback()
        by_operation = {change.operation: change for change in run.session.changes}
        run.session.close()
    assert by_operation["insert"].before is None and by_operation["insert"].after == {"id": "n", "name": "New"}
    assert by_operation["insert"].key == {"id": "n"} and by_operation["insert"].table == "items"
    assert by_operation["update"].before == {"id": "u", "name": "Old"}
    assert by_operation["update"].after == {"id": "u", "name": "Updated"}
    assert by_operation["delete"].before["name"] == "Gone" and by_operation["delete"].after is None
    assert names(engine) == ["Gone", "Old"]
    provider.uninstall()


def test_changes_are_capped_and_flagged(engine):
    provider = SQLAlchemyPreview(engine)
    with Running(provider) as run:
        with Session(engine) as session:
            session.add_all(Item(id=str(n), name="x") for n in range(205))
            session.commit()
        run.session.rollback()
        assert len(run.session.changes) == 200 and run.session.changes_truncated
        run.session.close()
    assert names(engine) == []
    provider.uninstall()


def test_requests_without_a_scope_commit_normally(engine):
    provider = SQLAlchemyPreview(engine)
    with Session(engine) as session:
        session.add(Item(id="real", name="Real"))
        session.commit()
    assert names(engine) == ["Real"]
    provider.uninstall()


def test_observation_commits_and_records_changes(engine):
    provider = SQLAlchemyPreview(engine)
    with Running(provider, rollback=False) as run:
        with Session(engine) as session:
            session.add(Item(id="o", name="Observed"))
            session.commit()
        run.session.close()
        assert [change.operation for change in run.session.changes] == ["insert"]
    assert names(engine) == ["Observed"]
    provider.uninstall()


def test_sql_logging_redacts_secret_parameters_and_hides_values_when_disabled(engine):
    provider = SQLAlchemyPreview(engine)
    with Running(provider) as run:
        with Session(engine) as session:
            session.execute(text("SELECT :fixture_secret, :quantity"), {"fixture_secret": "s3cr3t", "quantity": 7})
        run.session.rollback()
        run.session.close()
        logs = run.scope.capture.finish().logs
    parameters = {p["name"]: p["value"] for log in logs for p in log["sql"]["parameters"]}
    assert parameters == {"fixture_secret": "[REDACTED]", "quantity": "7"}
    with Running(provider, values=False) as run:
        with Session(engine) as session:
            session.execute(text("SELECT :quantity"), {"quantity": 7})
        run.session.rollback()
        run.session.close()
        hidden = run.scope.capture.finish().logs
    assert hidden[0]["sql"]["parameters"][0]["value"] == "[REDACTED]"
    provider.uninstall()


def test_failed_rollback_is_reported_and_the_connection_is_discarded(engine, monkeypatch):
    provider = SQLAlchemyPreview(engine)
    with Running(provider) as run:
        with Session(engine) as session:
            session.add(Item(id="x", name="X"))
            session.commit()
        hold = next(iter(run.scope.extensions["sqlalchemy"].holds.values()))
        real = hold.proxy._tb_real

        class Broken:
            def __getattr__(self, name):
                return getattr(real, name)

            def rollback(self):
                raise RuntimeError("boom")

        object.__setattr__(hold.proxy, "_tb_real", Broken())
        with pytest.raises(PreviewRollbackError):
            run.session.rollback()
        object.__setattr__(hold.proxy, "_tb_real", real)
        run.session.close()  # unconfirmed: the connection is invalidated, never reused
    assert names(engine) == []
    provider.uninstall()


def test_autocommit_engines_are_refused(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'a.sqlite'}", isolation_level="AUTOCOMMIT")
    provider = SQLAlchemyPreview(engine)
    with pytest.raises(PreviewUnavailable):
        provider.begin(make_scope())
    provider.uninstall()


def test_close_without_use_is_safe_and_idempotent(engine):
    provider = SQLAlchemyPreview(engine)
    with Running(provider) as run:
        run.session.rollback()
        run.session.close()
        run.session.close()
    provider.uninstall()


def test_secret_detection():
    for secret in ("password", "api_key", "apiKey", "clientSecret", "auth_token", "password_hash", "x_salt"):
        assert looks_secret(secret), secret
    for ordinary in ("id", "primary_key", "key", "idempotency_key", "name"):
        assert not looks_secret(ordinary), ordinary
    assert looks_secret("UPDATE users SET password_hash = ?")


@pytest.mark.asyncio
async def test_async_engine_preview_rolls_back(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'async.sqlite'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    provider = SQLAlchemyPreview(engine, database="async")
    scope = make_scope()
    token = activate(scope)
    session = provider.begin(scope)
    async with AsyncSession(engine, expire_on_commit=False) as one:
        one.add(Item(id="a", name="A"))
        await one.commit()
    async with AsyncSession(engine) as two:
        assert (await two.get(Item, "a")).name == "A"
    await session.arollback()
    assert [c.operation for c in session.changes] == ["insert"]
    await session.aclose()
    deactivate(token)
    async with AsyncSession(engine) as check:
        assert list(await check.scalars(select(Item))) == []
    provider.uninstall()
    await engine.dispose()


def test_a_handler_rollback_only_undoes_work_since_its_last_commit(engine):
    provider = SQLAlchemyPreview(engine)
    with Running(provider) as run:
        with Session(engine) as session:
            session.add(Item(id="committed", name="C"))
            session.commit()
            session.add(Item(id="undone", name="U"))
            session.flush()
            session.rollback()
            assert session.get(Item, "committed") is not None and session.get(Item, "undone") is None
        run.session.rollback()
        run.session.close()
    assert names(engine) == []
    provider.uninstall()


def test_unsupported_dialects_are_refused():
    from sendproof_sqlalchemy.connection import ensure_supported

    class Dialect:
        name = "mssql"
        _on_connect_isolation_level = None

    class Fake:
        dialect = Dialect()

        def get_execution_options(self):
            return {}

    with pytest.raises(PreviewUnavailable):
        ensure_supported(Fake())


def test_concurrent_sqlite_previews_wait_for_each_other_instead_of_failing(engine):
    """Previews that read then write one row must queue on SQLite's write lock.

    A deferred ``BEGIN`` lets two previews both take the read lock and then collide when they upgrade to a write
    (``database is locked`` straight away, without waiting). Load testing showed 87% of 300 concurrent previews of one
    row failing that way, so a preview opens with ``BEGIN IMMEDIATE``.
    """
    import threading

    provider = SQLAlchemyPreview(engine, database="d")
    with Session(engine) as session:
        session.add(Item(id="row", name="Initial"))
        session.commit()
    failures = []
    barrier = threading.Barrier(12)

    def preview(index):
        try:
            barrier.wait()
            with Running(provider) as run:
                with Session(engine) as session:
                    item = session.get(Item, "row")
                    assert item.name == "Initial"  # never another preview's uncommitted update
                    item.name = f"Temp-{index}"
                    session.commit()
                run.session.rollback()
                run.session.close()
        except BaseException as error:  # noqa: BLE001 - reported below
            failures.append(repr(error))

    threads = [threading.Thread(target=preview, args=(index,)) for index in range(12)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert failures == []
    assert names(engine) == ["Initial"]
    provider.uninstall()
