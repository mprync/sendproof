import os
import uuid

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


def test_a_preview_committed_on_the_raw_driver_connection_is_never_confirmed(engine):
    """The start-savepoint backstop on every dialect: a commit the pre-send guard can't see (the driver's own
    commit) ends the Preview transaction, and the driver opens a new one for the next write, so a plain
    rollback would succeed. The savepoint made when the Preview began is gone, so it answers 500."""
    provider = SQLAlchemyPreview(engine)
    with Running(provider) as run:
        try:
            held = engine.raw_connection()  # the Preview's held connection
            cursor = held.cursor()
            cursor.execute("INSERT INTO items VALUES ('escaped', 'E')")
            held.dbapi_connection._tb_real.commit()  # around every guard
            cursor.execute("INSERT INTO items VALUES ('after', 'A')")  # the driver begins a new transaction
            cursor.close()
            held.close()
            with pytest.raises(PreviewRollbackError, match="committed"):
                run.session.rollback()
        finally:
            run.session.close()
    assert names(engine) == ["E"]
    provider.uninstall()


POSTGRES_URL = os.environ.get("BENCH_POSTGRES_URL", "postgresql://bench:bench_local@127.0.0.1:55432/postgres")


@pytest.fixture
def postgres_engine():
    """A fresh PostgreSQL database on the compose server (or ``BENCH_POSTGRES_URL``); skips when none answers."""
    from sqlalchemy.engine import make_url

    server = make_url(POSTGRES_URL).set(drivername="postgresql+psycopg")
    admin = create_engine(server, isolation_level="AUTOCOMMIT", connect_args={"connect_timeout": 2})
    name = "sp_backstop_" + uuid.uuid4().hex[:10]
    try:
        with admin.connect() as connection:
            connection.execute(text(f"CREATE DATABASE {name}"))
    except Exception as error:  # noqa: BLE001 - no server: skip, with the command that starts one
        admin.dispose()
        pytest.skip(f"PostgreSQL is not running ({error.__class__.__name__}): docker compose -f tests/conformance/compose.yml up -d --wait postgres")
    engine = create_engine(server.set(database=name))
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()
    with admin.connect() as connection:
        connection.execute(text(f"DROP DATABASE {name}"))
    admin.dispose()


def test_a_postgresql_preview_committed_on_the_raw_driver_connection_is_never_confirmed(postgres_engine):
    """psycopg opens a new transaction for the next statement after its own commit, so only the savepoint
    made when the Preview began shows the Preview transaction is gone."""
    test_a_preview_committed_on_the_raw_driver_connection_is_never_confirmed(postgres_engine)


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


def test_mysql_previews_take_turns_and_other_dialects_do_not():
    """A MySQL preview waits for the one before it; InnoDB would otherwise deadlock same-key inserts."""
    import threading
    from types import SimpleNamespace

    from sendproof_sqlalchemy.turns import take_turn

    class FakeEngine:  # engines are held weakly, so the stand-in must support weak references
        def __init__(self, name: str) -> None:
            self.dialect = SimpleNamespace(name=name, is_async=False)

    assert take_turn(FakeEngine("sqlite")) is None
    mysql = FakeEngine("mysql")
    release = take_turn(mysql)
    assert release is not None
    second: list[object] = []
    waiter = threading.Thread(target=lambda: second.append(take_turn(mysql)))
    waiter.start()
    waiter.join(0.2)
    assert waiter.is_alive() and second == []  # still waiting for the first preview's turn
    release()
    waiter.join(5)
    assert len(second) == 1 and callable(second[0])
    second[0]()


# ------------------------------------------------------------------ MySQL transaction escapes
# These run against the compose MySQL (``docker compose -f tests/conformance/compose.yml up -d --wait mysql``),
# or the server ``BENCH_MYSQL_URL`` names, each in a fresh database; they skip when no server answers.
MYSQL_URL = os.environ.get("BENCH_MYSQL_URL", "mysql://root:bench_local@127.0.0.1:53306/mysql")


@pytest.fixture
def mysql_engine():
    from sqlalchemy.engine import make_url

    server = make_url(MYSQL_URL).set(drivername="mysql+pymysql")
    admin = create_engine(server, connect_args={"connect_timeout": 2})
    name = "sp_escape_" + uuid.uuid4().hex[:10]
    try:
        with admin.begin() as connection:
            connection.execute(text(f"CREATE DATABASE {name}"))
    except Exception as error:  # noqa: BLE001 - no server: skip, with the command that starts one
        admin.dispose()
        pytest.skip(f"MySQL is not running ({error.__class__.__name__}): docker compose -f tests/conformance/compose.yml up -d --wait mysql")
    engine = create_engine(server.set(database=name))
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE items (id VARCHAR(40) PRIMARY KEY, name VARCHAR(80))"))
        connection.execute(text("CREATE PROCEDURE commits() BEGIN COMMIT; END"))
        connection.execute(text("CREATE PROCEDURE reads_only() BEGIN SELECT 1; END"))
    yield engine
    engine.dispose()
    with admin.begin() as connection:
        connection.execute(text(f"DROP DATABASE {name}"))
    admin.dispose()


def stored_ids(engine):
    with engine.connect() as connection:
        return sorted(connection.scalars(text("SELECT id FROM items")))


def test_mysql_call_and_implicit_commits_are_refused_before_sending(mysql_engine):
    """spec/data-stores.md, "Transaction-control statements from the handler": CALL is refused unless the
    host declared the procedure safe by exact name, and DDL never reaches the server."""
    provider = SQLAlchemyPreview(mysql_engine, safe_procedures=["reads_only"])
    for statement in ("CALL commits()", "CREATE TABLE escape_probe (n INT)", "/*!50000 COMMIT */", "SET @@session.autocommit = 1"):
        with Running(provider) as run:
            try:
                with Session(mysql_engine) as session:
                    session.execute(text("INSERT INTO items VALUES ('a', 'A')"))
                    session.execute(text("CALL reads_only()"))  # declared safe: allowed
                    with pytest.raises(PreviewRollbackError):
                        session.execute(text(statement))
                with pytest.raises(PreviewRollbackError):
                    run.session.rollback()
            finally:
                run.session.close()
        assert stored_ids(mysql_engine) == [], statement
    with mysql_engine.connect() as connection:
        assert connection.scalar(text("SELECT COUNT(*) FROM information_schema.tables "
                                      "WHERE table_schema = DATABASE() AND table_name = 'escape_probe'")) == 0
    with pytest.raises(ValueError):
        SQLAlchemyPreview(mysql_engine, safe_procedures=["reads_*"])
    provider.uninstall()


def test_mysql_deadlock_refuses_every_later_statement_in_the_preview(mysql_engine):
    """A deadlock (1213) rolls back the whole Preview transaction, so a retry would run outside it, and with
    autocommit=1 commit for real. Every later statement is refused before sending; the Preview answers 500."""
    import threading
    import time

    from sqlalchemy.exc import OperationalError

    with mysql_engine.begin() as connection:
        connection.execute(text("INSERT INTO items VALUES ('a', 'A'), ('b', 'B')"))
    other = mysql_engine.raw_connection()  # outside the Preview: taken before its scope is active
    other_cursor = other.cursor()
    # The other transaction holds more locks, so InnoDB picks the Preview as the deadlock victim.
    other_cursor.execute("UPDATE items SET name = 'O' WHERE id = 'b'")
    other_cursor.executemany("INSERT INTO items VALUES (%s, 'filler')", [(f"f{n}",) for n in range(10)])
    provider = SQLAlchemyPreview(mysql_engine)
    with Running(provider) as run:
        try:
            with mysql_engine.connect() as connection:
                connection.execute(text("UPDATE items SET name = 'P' WHERE id = 'a'"))
                waiter = threading.Thread(target=lambda: other_cursor.execute("UPDATE items SET name = 'O' WHERE id = 'a'"))
                waiter.start()
                time.sleep(0.3)  # the other transaction now waits on the Preview's row
                with pytest.raises(OperationalError) as deadlock:
                    connection.execute(text("UPDATE items SET name = 'P' WHERE id = 'b'"))
                assert deadlock.value.orig.args[0] == 1213  # the handler still gets the original error
            waiter.join(5)
            other.commit()
            held = mysql_engine.raw_connection()  # still the Preview's held connection after the error
            held.dbapi_connection._tb_real.autocommit(True)  # a driver at autocommit=1
            with pytest.raises(PreviewRollbackError, match="deadlock"):
                with mysql_engine.connect() as connection:  # the handler's retry
                    connection.execute(text("INSERT INTO items VALUES ('retry', 'R')"))
            with pytest.raises(PreviewRollbackError):
                run.session.rollback()
        finally:
            run.session.close()
            other.close()
    assert "retry" not in stored_ids(mysql_engine)
    provider.uninstall()


def test_mysql_preview_answers_500_when_its_transaction_was_committed_anyway(mysql_engine):
    """The backstop: something the guard can't see (here the driver's own commit) ended the Preview
    transaction, so the rollback is never confirmed, whatever the handler returned."""
    provider = SQLAlchemyPreview(mysql_engine)
    with Running(provider) as run:
        try:
            held = mysql_engine.raw_connection()  # the Preview's held connection
            cursor = held.cursor()
            cursor.execute("INSERT INTO items VALUES ('escaped', 'E')")
            held.dbapi_connection._tb_real.commit()  # around every guard
            # autocommit is off, so MySQL opens a new transaction here: a SAVEPOINT made now would succeed.
            cursor.execute("INSERT INTO items VALUES ('after', 'A')")
            cursor.close()
            held.close()
            with pytest.raises(PreviewRollbackError, match="committed"):
                run.session.rollback()
        finally:
            run.session.close()  # hands the connection and the MySQL turn back even when an assertion fails
    assert stored_ids(mysql_engine) == ["escaped"]
    with Running(provider) as run:  # an ordinary Preview still confirms its rollback
        with Session(mysql_engine) as session:
            session.execute(text("INSERT INTO items VALUES ('b', 'B')"))
            session.commit()
        run.session.rollback()
        run.session.close()
    assert stored_ids(mysql_engine) == ["escaped"]
    provider.uninstall()
