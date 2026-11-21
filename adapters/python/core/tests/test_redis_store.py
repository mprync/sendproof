"""The Redis write guard against a real Redis (``docker compose -f tests/conformance/compose.yml up -d redis``).

Every check runs for redis-py and ``redis.asyncio``. An independent, unhooked client reads the
data back, so a passing check proves the refused command never reached the server.
"""

from __future__ import annotations

import asyncio

import pytest
import redis
import redis.asyncio as aredis

from sendproof_core.stores import PreviewWriteBlocked, redis_store
from store_support import REDIS_URL, active, db_entries, fresh, needs, observed_scope, preview_scope

pytestmark = needs("redis")


@pytest.fixture
def prefix():
    prefix = fresh() + ":"
    yield prefix
    reader = redis.Redis.from_url(REDIS_URL)
    keys = reader.keys(prefix + "*")
    if keys:
        reader.delete(*keys)
    reader.close()


@pytest.fixture
def reader():
    client = redis.Redis.from_url(REDIS_URL)
    yield client
    client.close()


@pytest.fixture
def hooked():
    client = redis.Redis.from_url(REDIS_URL)
    store = redis_store(client, name="cache")
    yield client, store
    client.close()


# ------------------------------------------------------------------------ redis-py
def test_reads_run_and_a_write_is_refused_before_any_byte_is_sent(hooked, reader, prefix):
    client, store = hooked
    key = prefix + "counter"
    reader.set(key, 5)
    with active(preview_scope()) as scope:
        assert client.get(key) == b"5"
        with pytest.raises(PreviewWriteBlocked) as blocked:
            client.execute_command("INCR", key)
        assert (blocked.value.store, blocked.value.operation) == ("redis", "INCR")
        with pytest.raises(PreviewWriteBlocked):
            client.getdel(key)  # looks like a read, deletes the key
    assert reader.get(key) == b"5"
    assert scope.capture.blocked["operation"] == "INCR"  # the first block wins
    assert store.describe() == {"system": "redis", "name": "cache", "mode": "guard"}


def test_a_pipeline_is_refused_as_a_whole_before_its_first_command(hooked, reader, prefix):
    client, _ = hooked
    a, b = prefix + "a", prefix + "b"
    reader.set(a, "keep")
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            pipe = client.pipeline(transaction=False)
            pipe.get(a)
            pipe.set(b, "x")  # the write sits after a read
            pipe.delete(a)
            pipe.execute()
    assert reader.get(a) == b"keep" and reader.get(b) is None


def test_a_transaction_pipeline_sends_nothing_not_even_multi(hooked, reader, prefix):
    client, _ = hooked
    key = prefix + "t"
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            with client.pipeline() as pipe:  # MULTI ... EXEC
                pipe.incr(key)
                pipe.execute()
        # The connection went back to the pool clean: no MULTI is pending on it.
        assert client.set.__self__ is client
    assert reader.get(key) is None
    with active(observed_scope()):
        assert client.incr(key) == 1  # an observed Send runs the same command normally


def test_a_write_refused_after_a_raw_multi_closes_the_connection(hooked, reader, prefix):
    client, _ = hooked
    key = prefix + "m"
    with active(preview_scope()):
        client.execute_command("MULTI")
        with pytest.raises(PreviewWriteBlocked):
            client.execute_command("SET", key, "x")
    with active(observed_scope()):
        with pytest.raises(redis.ResponseError):
            client.execute_command("EXEC")  # nothing is queued: the server discards MULTI with the connection
    assert reader.get(key) is None


def test_outside_a_preview_and_in_observed_send_everything_runs_and_is_logged(hooked, reader, prefix):
    client, _ = hooked
    key = prefix + "c"
    assert client.set(key, 1) and client.incr(key) == 2  # no scope at all
    with active(observed_scope()) as scope:
        assert client.set(key, 7) and client.incr(key) == 8
        assert [e["db"]["operation"] for e in db_entries(scope, "redis")] == ["SET", "INCRBY"]
    assert reader.get(key) == b"8"


def test_db_statements_keep_keys_and_never_values_and_session_commands_are_not_logged(hooked, prefix):
    client, _ = hooked
    other = redis.Redis.from_url(REDIS_URL)  # a new client has no connection yet: its AUTH and HELLO happen inside the scope
    redis_store(other)
    with active(observed_scope()) as scope:
        other.set(prefix + "session:42", "super-secret-value")
        other.mset({prefix + "x": "1", prefix + "y": "2"})
        other.eval("return redis.call('GET', KEYS[1])", 1, prefix + "k", )
        other.config_get("maxmemory")
        entries = db_entries(scope, "redis")
    statements = [e["db"]["statement"] for e in entries]
    assert statements[0] == f"SET {prefix}session:42 ?"
    assert statements[1] == f"MSET {prefix}x ? {prefix}y ?"
    assert statements[2] == f"EVAL ? ? {prefix}k"
    assert statements[3] == "CONFIG GET ?"
    assert entries[0]["db"]["target"] == prefix + "session:42"
    text = repr(entries)
    for secret in ("super-secret-value", "bench_redis_local", "return redis.call"):
        assert secret not in text
    assert not any(e["db"]["operation"] in ("AUTH", "HELLO", "CLIENT", "SELECT") for e in entries)
    other.close()


def test_db_entries_carry_the_time_to_reply_and_the_redis_error_code(hooked, prefix):
    client, _ = hooked
    key = prefix + "typed"
    with active(observed_scope()) as scope:
        client.set(key, "a string")
        with pytest.raises(redis.ResponseError):
            client.lpush(key, "x")  # WRONGTYPE: the reply is an error
        pipe = client.pipeline(transaction=False)
        pipe.get(key).incr(key).get(key)
        results = pipe.execute(raise_on_error=False)
        pubsub = client.pubsub()
        pubsub.subscribe(prefix + "news")  # from here this connection's replies don't pair with commands
        pubsub.get_message(timeout=1)
        pubsub.close()
        client.get(key)
        entries = db_entries(scope, "redis")
    assert isinstance(results[1], redis.ResponseError)
    by_operation = [(e["db"]["operation"], e["db"].get("error")) for e in entries]
    assert by_operation == [("SET", None), ("LPUSH", "WRONGTYPE"), ("GET", None), ("INCRBY", "ERR"), ("GET", None),
                            ("SUBSCRIBE", None), ("GET", None)]
    timed = [e for e in entries if e["db"]["operation"] != "SUBSCRIBE"]
    assert all(isinstance(e.get("elapsedMs"), float) for e in timed)
    assert "a string" not in repr(entries) and "not an integer" not in repr(entries)


async def test_async_db_entries_carry_the_time_to_reply_and_the_error_code(prefix):
    client = aredis.Redis.from_url(REDIS_URL)
    redis_store(client)
    key = prefix + "atyped"
    with active(observed_scope()) as scope:
        await client.set(key, "a string")
        with pytest.raises(redis.ResponseError):
            await client.lpush(key, "x")
        async with client.pipeline(transaction=True) as pipe:
            await pipe.get(key).set(key, "b").execute()
        entries = db_entries(scope, "redis")
    assert [(e["db"]["operation"], e["db"].get("error")) for e in entries] == [
        ("SET", None), ("LPUSH", "WRONGTYPE"), ("GET", None), ("SET", None)]
    assert all(isinstance(e.get("elapsedMs"), float) for e in entries)
    await client.aclose()


def test_a_write_no_request_accounts_for_fails_every_open_preview(hooked, reader, prefix):
    """A thread a handler started without its context writes unguarded: no open Preview may be confirmed."""
    import threading

    from sendproof_core import detached
    from sendproof_core.scope import request_context

    client, _ = hooked

    def in_thread(body):
        thread = threading.Thread(target=body)
        thread.start()
        thread.join()

    def worker():
        with detached():
            client.set(prefix + "worker", 1)

    def request():
        with request_context():
            client.set(prefix + "request", 1)

    with active(preview_scope()) as accounted, active(preview_scope()) as other:
        in_thread(worker)
        in_thread(request)
        in_thread(lambda: client.get(prefix + "worker"))  # reads are never a problem
        assert accounted.capture.fault is None and other.capture.fault is None
        in_thread(lambda: client.set(prefix + "stray", 1))
    assert accounted.capture.fault is not None and other.capture.fault is not None  # every open Preview
    assert "outside any request" in str(accounted.capture.fault)
    client.set(prefix + "idle", 1)  # no Preview open: nothing to fail


def test_treat_as_read_lets_an_exact_command_through():
    client = redis.Redis.from_url(REDIS_URL)
    redis_store(client, treat_as_read=["objectish"])
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            client.execute_command("OBJECTISH2", "k")
        # allowed by the guard; the server then answers that the command is unknown
        with pytest.raises(redis.ResponseError):
            client.execute_command("OBJECTISH", "k")
    client.close()


def test_a_client_hooked_twice_is_refused_and_labels_are_validated():
    client = redis.Redis.from_url(REDIS_URL)
    redis_store(client)
    with pytest.raises(TypeError):
        redis_store(client)
    with pytest.raises(ValueError):
        redis_store(name="redis://:pw@host:6379")
    with pytest.raises(TypeError):
        redis_store(object())
    client.close()


def test_a_pool_built_with_the_stores_connection_class_is_guarded(reader, prefix):
    store = redis_store(name="cache")
    pool = redis.ConnectionPool.from_url(REDIS_URL, connection_class=store.connection_class)
    client = redis.Redis(connection_pool=pool)
    with active(preview_scope()):
        assert client.get(prefix + "none") is None
        with pytest.raises(PreviewWriteBlocked):
            client.set(prefix + "none", "x")
    assert reader.get(prefix + "none") is None
    client.close()


def test_connections_a_pool_already_held_are_guarded_too(reader, prefix):
    client = redis.Redis.from_url(REDIS_URL)
    client.ping()  # opens a connection before the hook is installed
    redis_store(client)
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            client.set(prefix + "held", "x")
    assert reader.get(prefix + "held") is None
    client.close()


def test_the_scope_crosses_a_worker_thread(hooked, reader, prefix):
    """FastAPI runs ``def`` endpoints through ``run_in_threadpool``; asyncio.to_thread copies the context the same way."""
    client, _ = hooked

    async def main():
        with active(preview_scope()) as scope:
            with pytest.raises(PreviewWriteBlocked):
                await asyncio.to_thread(client.set, prefix + "thread", "x")
            assert scope.capture.blocked is not None

    asyncio.run(main())
    assert reader.get(prefix + "thread") is None


def test_the_checks_fail_without_the_hook(reader, prefix):
    """The negative test: an unhooked client sends the write, so the guard checks above would fail."""
    client = redis.Redis.from_url(REDIS_URL)
    with active(preview_scope()) as scope:
        client.execute_command("INCR", prefix + "unhooked")  # nothing refuses it
        assert scope.capture.blocked is None
    assert reader.get(prefix + "unhooked") == b"1"  # the write reached Redis
    client.close()


# ------------------------------------------------------------------ redis.asyncio
async def test_async_reads_run_and_writes_are_refused(reader, prefix):
    client = aredis.Redis.from_url(REDIS_URL)
    redis_store(client)
    key = prefix + "async"
    reader.set(key, 3)
    with active(preview_scope()) as scope:
        assert await client.get(key) == b"3"
        with pytest.raises(PreviewWriteBlocked):
            await client.incr(key)
        with pytest.raises(PreviewWriteBlocked):
            await client.getdel(key)
        assert scope.capture.blocked["operation"] == "INCRBY"
    assert reader.get(key) == b"3"
    await client.aclose()


async def test_async_pipelines_and_transactions_are_refused_whole(reader, prefix):
    client = aredis.Redis.from_url(REDIS_URL)
    redis_store(client)
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            async with client.pipeline(transaction=False) as pipe:
                pipe.get(prefix + "p")
                pipe.set(prefix + "p", "x")
                await pipe.execute()
        with pytest.raises(PreviewWriteBlocked):
            async with client.pipeline() as pipe:
                pipe.incr(prefix + "p")
                await pipe.execute()
    assert reader.get(prefix + "p") is None
    with active(observed_scope()):
        assert await client.incr(prefix + "p") == 1
    await client.aclose()


async def test_async_raw_multi_then_a_refused_write_discards_the_transaction(reader, prefix):
    client = aredis.Redis.from_url(REDIS_URL)
    redis_store(client)
    with active(preview_scope()):
        await client.execute_command("MULTI")
        with pytest.raises(PreviewWriteBlocked):
            await client.execute_command("SET", prefix + "am", "x")
    with active(observed_scope()):
        with pytest.raises(redis.ResponseError):
            await client.execute_command("EXEC")
    assert reader.get(prefix + "am") is None
    await client.aclose()


async def test_async_observed_send_logs_and_sessions_stay_out_of_the_log(prefix):
    client = aredis.Redis.from_url(REDIS_URL)
    redis_store(client)
    with active(observed_scope()) as scope:
        await client.set(prefix + "log", "v")
        entries = db_entries(scope, "redis")
    assert [e["db"]["statement"] for e in entries] == [f"SET {prefix}log ?"]
    assert "bench_redis_local" not in repr(entries)
    await client.aclose()


async def test_async_pool_hooked_in_place_covers_connections_it_already_held(reader, prefix):
    pool = aredis.ConnectionPool.from_url(REDIS_URL)
    client = aredis.Redis(connection_pool=pool)
    await client.ping()
    redis_store(pool)
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            await client.set(prefix + "ap", "x")
    assert reader.get(prefix + "ap") is None
    await client.aclose()
