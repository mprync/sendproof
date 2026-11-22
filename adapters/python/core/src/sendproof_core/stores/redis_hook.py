"""Sendproof write guard for Redis (``spec/data-stores.md``, ``guard`` mode).

``redis_store(client)`` hooks a redis-py client (``redis.Redis`` or ``redis.asyncio.Redis``) or its
connection pool in place. The hook is a ``Connection`` subclass: every command, whether sent alone
or queued in a pipeline or ``MULTI``, is classified **before any byte of it is packed or written**:

* ``send_command``, ``pack_command`` and ``pack_commands`` are overridden, so single commands,
  scripts and raw ``execute_command`` calls are covered, and so is every pipeline. A pipeline or
  transaction is classified as a whole before its first command is sent, so a refused write sends
  nothing, not even ``MULTI``.
* Reads run normally. In a Preview the first write raises
  :class:`~sendproof_core.stores.guard.PreviewWriteBlocked` and the Preview answers 409. Session
  commands (``AUTH``, ``HELLO``, ``SELECT``, ``PING``...) are never guarded or logged, so the
  password never reaches a capture.
* Every other command becomes a ``Db`` log entry whose statement keeps the command name and key
  arguments only (``SET session:42 ?``).

The same hook works for a client you build yourself, through the connection class::

    store = redis_store(name="cache")
    pool = redis.ConnectionPool.from_url(url, connection_class=store.connection_class)

and for django-redis or Django's ``RedisCache`` through their ``connection_class`` option.

Coverage: only hooked clients are covered. A client built from an unhooked pool, a Redis Cluster
or Sentinel client built without the connection class, or a raw socket is not.
"""

from __future__ import annotations

import inspect
import re
import time
from collections import deque
from typing import Any, Iterable, Optional

from ..scope import current_scope
from .base import DataStore
from .classify import SESSION, TRANSACTION, WRITE, classify_redis
from .guard import PreviewWriteBlocked, guard, read_set, refuse_unattributed, store_label

# Commands whose every argument is a key.
_ALL_KEYS = frozenset({
    "DEL", "UNLINK", "EXISTS", "TOUCH", "MGET", "SUNION", "SINTER", "SDIFF", "WATCH", "PFCOUNT", "PFMERGE",
    "SUNIONSTORE", "SINTERSTORE", "SDIFFSTORE", "RENAME", "RENAMENX", "RPOPLPUSH", "COPY", "LMOVE", "BLMOVE",
    "SMOVE", "JSON.MGET", "TS.MGET",
})
# Commands whose arguments alternate key, value.
_PAIRS = frozenset({"MSET", "MSETNX"})
# Commands that name their keys after a key count: EVAL script numkeys key... arg...
_NUMKEYS = frozenset({"EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "FCALL", "FCALL_RO"})
# Container commands that put the key after the subcommand: OBJECT ENCODING key.
_KEY_AT_ONE = frozenset({"OBJECT", "MEMORY", "XINFO", "XGROUP"})
# Container commands: their first argument is a fixed subcommand word, not data, so it is shown.
_CONTAINERS = frozenset({
    "CONFIG", "CLIENT", "OBJECT", "MEMORY", "XINFO", "XGROUP", "SCRIPT", "FUNCTION", "ACL", "CLUSTER", "COMMAND",
    "PUBSUB", "LATENCY", "MODULE", "SLOWLOG", "DEBUG",
})
# Commands with no key. Their arguments (patterns, scripts, options) are all shown as ``?``.
_NO_KEYS = frozenset({
    "DBSIZE", "KEYS", "SCAN", "RANDOMKEY", "LOLWUT", "SCRIPT", "CONFIG", "CLIENT", "FLUSHALL", "FLUSHDB", "SAVE",
    "BGSAVE", "BGREWRITEAOF", "SHUTDOWN", "SLAVEOF", "REPLICAOF", "ACL", "MODULE", "DEBUG", "MONITOR", "PUBSUB",
    "FUNCTION", "CLUSTER", "FAILOVER", "SWAPDB", "MOVE", "SENTINEL", "LATENCY", "SLOWLOG", "WAIT", "FT._LIST",
    "BITOP", "ZUNIONSTORE", "ZINTERSTORE", "ZDIFFSTORE", "ZUNION", "ZINTER", "ZDIFF", "SINTERCARD", "PUBLISH",
    "SPUBLISH", "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "UNSUBSCRIBE", "PUNSUBSCRIBE", "SUNSUBSCRIBE", "PING", "ECHO",
})


def _text(value: Any) -> str:
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).decode("utf-8", errors="replace")
    return str(value)


def _key_indexes(name: str, args: list[Any]) -> list[int]:
    """Positions of the key arguments of a command, as far as the table below knows them.

    A command the table does not know shows no keys: its arguments might be values, and a value
    never appears in a ``Db`` entry.
    """
    if name in _NO_KEYS:
        if name in ("BITOP", "ZUNIONSTORE", "ZINTERSTORE", "ZDIFFSTORE", "ZUNION", "ZINTER", "ZDIFF", "SINTERCARD"):
            return _counted_keys(name, args)
        return []
    if name in _ALL_KEYS:
        return list(range(len(args)))
    if name in _PAIRS:
        return list(range(0, len(args), 2))
    if name in _NUMKEYS:
        try:
            count = int(_text(args[1]))
        except (IndexError, ValueError):
            return []
        return list(range(2, min(len(args), 2 + count)))
    if name in _KEY_AT_ONE:
        return [1] if len(args) > 1 else []
    return [0] if args else []


def _counted_keys(name: str, args: list[Any]) -> list[int]:
    """Keys of ``BITOP op dest key...``, ``ZUNIONSTORE dest n key...`` and ``ZUNION n key...``."""
    try:
        if name == "BITOP":
            return list(range(1, len(args)))
        if name in ("ZUNIONSTORE", "ZINTERSTORE", "ZDIFFSTORE"):
            return [0, *range(2, min(len(args), 2 + int(_text(args[1]))))]
        return list(range(1, min(len(args), 1 + int(_text(args[0])))))  # ZUNION n key..., SINTERCARD n key...
    except (IndexError, ValueError):
        return []


def describe_command(name: str, args: list[Any]) -> tuple[str, Optional[str]]:
    """The ``Db`` statement and target of a command: the name, then each key argument as written and
    every other argument as ``?`` (``SET session:42 ?``). Values never appear.
    """
    keys = set(_key_indexes(name, args))
    shown = [_text(arg) if index in keys else "?" for index, arg in enumerate(args)]
    if name in _CONTAINERS and args and re.fullmatch(r"[A-Za-z_-]{1,32}", _text(args[0])):
        shown[0] = _text(args[0]).upper()
    target = _text(args[min(keys)]) if keys else None
    return " ".join([name, *shown]), target


def _split(command: Iterable[Any]) -> tuple[str, list[Any]]:
    """The upper-case command name (its first word) and its arguments, as redis-py passes them."""
    items = list(command)
    if not items:
        return "", []
    words = _text(items[0]).split(" ")
    return words[0].upper(), [*words[1:], *items[1:]]


class _Settings:
    """Per-store settings every guarded connection of that store shares."""

    def __init__(self, reads: Optional[frozenset[str]]) -> None:
        self.reads = reads


#: Commands after which a connection receives messages it never asked for, so replies no longer
#: pair one-to-one with commands: such a connection logs its commands untimed, as they are sent.
_PUSH_MODE = frozenset({"SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "MONITOR"})

#: One command waiting for its reply: the capture to log it in, then the ``Db`` entry's fields.
_Entry = tuple  # (capture, name, target, namespace, statement)


def _error_code(error: BaseException) -> str:
    """The Redis error code of a refused command (``WRONGTYPE``, ``ERR``), or the error's class name.

    Only the code is kept: the rest of an error message may quote a key or a value.
    """
    from redis.exceptions import ResponseError

    if type(error) is ResponseError:
        word = str(error).split(" ", 1)[0]
        return word if re.fullmatch(r"[A-Z][A-Z_]{1,31}", word) else "ERR"
    return type(error).__name__


class _GuardBase:
    """What the synchronous and asynchronous guarded connections share: classify, guard, log.

    Logging pairs replies with commands. redis-py reads exactly one reply for each command it sends
    (pipelines and ``MULTI`` included), so each sent command waits in a queue on its connection and
    its ``Db`` entry is written when its reply arrives, with the time it took and the Redis error
    code if it failed. A connection in pub/sub or ``MONITOR`` mode receives replies nobody asked
    for, so from then on it logs each command as it is sent, without timing.
    """

    _sendproof_settings: _Settings = _Settings(None)
    _sendproof_handshake = 0
    _sendproof_skip = False
    _sendproof_in_multi = False
    _sendproof_dirty = False
    _sendproof_untimed = False
    _sendproof_staged: Optional[list[Optional[_Entry]]] = None
    _sendproof_waiting: Optional[deque] = None

    def _sendproof_kind(self, command: Iterable[Any]) -> tuple[str, str, list[Any], str]:
        items = list(command)
        name, args = _split(items)
        full = _text(items[0]).upper() if items else ""
        return classify_redis(full, items[1:], self._sendproof_settings.reads), name, args, full

    def _sendproof_namespace(self) -> Optional[str]:
        database = getattr(self, "db", None)
        return None if database is None else str(database)

    def _sendproof_check(self, commands: list[Iterable[Any]], single: bool) -> None:
        """Classify ``commands`` as one batch and refuse the first write, then stage their log entries
        for :meth:`_sendproof_sent`."""
        if not commands:
            return
        if self._sendproof_handshake:
            # A pub/sub client re-subscribes while it reconnects: its replies stop pairing from here.
            if any(_split(command)[0] in _PUSH_MODE for command in commands):
                self._sendproof_untimed, self._sendproof_waiting = True, None
            return
        classified = [self._sendproof_kind(command) for command in commands]
        scope = current_scope()
        try:
            for kind, name, _args, _full in classified:
                guard("redis", name, kind)
            if scope is None and any(kind == WRITE for kind, *_ in classified):
                refuse_unattributed("redis", next(name for kind, name, *_ in classified if kind == WRITE))
        except PreviewWriteBlocked:
            if self._sendproof_in_multi:
                self._sendproof_abandon()
            raise
        if single:
            kind, name, _args, _full = classified[0]
            if kind == TRANSACTION:
                self._sendproof_in_multi = name == "MULTI" or (self._sendproof_in_multi and name not in ("EXEC", "DISCARD"))
        staged: list[Optional[_Entry]] = []
        for kind, name, args, _full in classified:
            if scope is None or kind in (SESSION, TRANSACTION):
                staged.append(None)  # still holds the reply's place in the queue
                continue
            statement, target = describe_command(name, args)
            staged.append((scope.capture, name, target, self._sendproof_namespace(), statement))
        if any(name in _PUSH_MODE for _kind, name, _args, _full in classified):
            self._sendproof_untimed = True
            self._sendproof_waiting = None
        # Each packed batch is sent by exactly one send_packed_command, so the latest batch replaces
        # any that was packed and never sent.
        self._sendproof_staged = staged

    # -- pairing replies with commands
    def _sendproof_take(self) -> Optional[list[Optional[_Entry]]]:
        """The entries of the batch about to be sent. Taken before sending, so a health-check ``PING``
        the driver sends first stages and pairs its own entry."""
        staged, self._sendproof_staged = self._sendproof_staged, None
        return staged

    def _sendproof_sent(self, staged: Optional[list[Optional[_Entry]]], error: Optional[BaseException]) -> None:
        """Queue a sent batch for its replies, or log it now when it failed to send or replies can't be paired."""
        if not staged:
            return
        if error is not None or self._sendproof_untimed:
            for entry in staged:
                self._sendproof_log(entry, None, None if error is None else type(error).__name__)
            return
        now = time.perf_counter()
        waiting = self._sendproof_waiting
        if waiting is None:
            waiting = self._sendproof_waiting = deque()
        waiting.extend((entry, now) for entry in staged)

    def _sendproof_replied(self, error: Optional[BaseException]) -> None:
        """Log the oldest command waiting on this connection, now that its reply (or error) arrived."""
        waiting = self._sendproof_waiting
        if not waiting:
            return
        entry, sent = waiting.popleft()
        self._sendproof_log(entry, (time.perf_counter() - sent) * 1000, None if error is None else _error_code(error))
        if error is not None and not _is_reply_error(error):
            self._sendproof_flush(error)  # the connection failed: no other reply is coming

    def _sendproof_flush(self, error: Optional[BaseException]) -> None:
        """Log every command still waiting, with the error that ended the connection.

        Called when the connection closes, which also ends pub/sub mode: a pooled connection a
        ``PubSub`` released pairs replies again on its next use.
        """
        self._sendproof_untimed = False
        waiting, self._sendproof_waiting = self._sendproof_waiting, None
        for entry, _sent in waiting or ():
            self._sendproof_log(entry, None, type(error).__name__ if error is not None else "ConnectionError")

    def _sendproof_pairs(self, kwargs: dict) -> bool:
        """Whether this read answers a command: not during the handshake, and not a push-message read."""
        return not self._sendproof_handshake and not kwargs.get("push_request")

    @staticmethod
    def _sendproof_log(entry: Optional[_Entry], elapsed_ms: Optional[float], error: Optional[str]) -> None:
        if entry is None:
            return
        capture, name, target, namespace, statement = entry
        capture.record_db("redis", name, target=target, namespace=namespace, statement=statement,
                          elapsed_ms=elapsed_ms, error=error)

    def _sendproof_abandon(self) -> None:  # pragma: no cover - overridden
        raise NotImplementedError


def _is_reply_error(error: BaseException) -> bool:
    """A refusal Redis sent as its reply, after which the connection is still in step."""
    from redis.exceptions import ResponseError

    return isinstance(error, ResponseError)


class _SyncGuard(_GuardBase):
    """Mixin for ``redis.Connection`` and its subclasses."""

    def send_command(self, *args: Any, **kwargs: Any) -> Any:
        if self._sendproof_skip:
            return super().send_command(*args, **kwargs)  # type: ignore[misc]
        self._sendproof_check([args], single=True)
        self._sendproof_skip = True
        try:
            return super().send_command(*args, **kwargs)  # type: ignore[misc]
        finally:
            self._sendproof_skip = False

    def pack_command(self, *args: Any) -> Any:
        if not self._sendproof_skip:
            self._sendproof_check([args], single=True)
        return super().pack_command(*args)  # type: ignore[misc]

    def pack_commands(self, commands: Iterable[Iterable[Any]]) -> Any:
        batch = [tuple(command) for command in commands]
        if not self._sendproof_skip:
            self._sendproof_check(batch, single=False)
        self._sendproof_skip = True
        try:
            return super().pack_commands(batch)  # type: ignore[misc]
        finally:
            self._sendproof_skip = False

    def on_connect(self) -> Any:
        # Handshake commands (HELLO, AUTH, CLIENT SETINFO, SELECT...) set up the session and never
        # touch data, so they are not classified, and never reach a capture.
        self._sendproof_handshake += 1
        try:
            return super().on_connect()  # type: ignore[misc]
        finally:
            self._sendproof_handshake -= 1

    def on_connect_check_health(self, *args: Any, **kwargs: Any) -> Any:
        self._sendproof_handshake += 1
        try:
            return super().on_connect_check_health(*args, **kwargs)  # type: ignore[misc]
        finally:
            self._sendproof_handshake -= 1

    def send_packed_command(self, command: Any, check_health: bool = True) -> Any:
        staged = self._sendproof_take()
        try:
            result = super().send_packed_command(command, check_health)  # type: ignore[misc]
        except BaseException as error:
            self._sendproof_sent(staged, error)
            raise
        self._sendproof_sent(staged, None)
        return result

    def read_response(self, *args: Any, **kwargs: Any) -> Any:
        if not self._sendproof_pairs(kwargs):
            return super().read_response(*args, **kwargs)  # type: ignore[misc]
        try:
            response = super().read_response(*args, **kwargs)  # type: ignore[misc]
        except Exception as error:
            self._sendproof_replied(error)
            raise
        self._sendproof_replied(None)
        return response

    def disconnect(self, *args: Any, **kwargs: Any) -> Any:
        self._sendproof_flush(None)
        return super().disconnect(*args, **kwargs)  # type: ignore[misc]

    def _sendproof_abandon(self) -> None:
        """Close the socket: a write refused after ``MULTI`` must not be followed by an ``EXEC``."""
        self._sendproof_in_multi = False
        try:
            self.disconnect()  # type: ignore[attr-defined]
        except Exception:
            pass


class _AsyncGuard(_GuardBase):
    """Mixin for ``redis.asyncio.Connection`` and its subclasses."""

    def pack_command(self, *args: Any) -> Any:
        if not self._sendproof_skip:
            self._sendproof_check([args], single=True)
        return super().pack_command(*args)  # type: ignore[misc]

    def pack_commands(self, commands: Iterable[Iterable[Any]]) -> Any:
        batch = [tuple(command) for command in commands]
        if not self._sendproof_skip:
            self._sendproof_check(batch, single=False)
        self._sendproof_skip = True
        try:
            return super().pack_commands(batch)  # type: ignore[misc]
        finally:
            self._sendproof_skip = False

    async def on_connect(self) -> Any:
        self._sendproof_handshake += 1
        try:
            return await super().on_connect()  # type: ignore[misc]
        finally:
            self._sendproof_handshake -= 1

    async def on_connect_check_health(self, *args: Any, **kwargs: Any) -> Any:
        self._sendproof_handshake += 1
        try:
            return await super().on_connect_check_health(*args, **kwargs)  # type: ignore[misc]
        finally:
            self._sendproof_handshake -= 1

    async def send_packed_command(self, command: Any, check_health: bool = True) -> Any:
        staged = self._sendproof_take()
        if self._sendproof_dirty:
            self._sendproof_dirty = False
            await self.disconnect()  # type: ignore[attr-defined]
        try:
            result = await super().send_packed_command(command, check_health)  # type: ignore[misc]
        except BaseException as error:
            self._sendproof_sent(staged, error)
            raise
        self._sendproof_sent(staged, None)
        return result

    async def read_response(self, *args: Any, **kwargs: Any) -> Any:
        if not self._sendproof_pairs(kwargs):
            return await super().read_response(*args, **kwargs)  # type: ignore[misc]
        try:
            response = await super().read_response(*args, **kwargs)  # type: ignore[misc]
        except Exception as error:
            self._sendproof_replied(error)
            raise
        self._sendproof_replied(None)
        return response

    async def disconnect(self, *args: Any, **kwargs: Any) -> Any:
        self._sendproof_flush(None)
        return await super().disconnect(*args, **kwargs)  # type: ignore[misc]

    def _sendproof_abandon(self) -> None:
        """Close the socket before the next send: a write refused after ``MULTI`` must not be followed by an ``EXEC``."""
        self._sendproof_in_multi = False
        self._sendproof_dirty = True


_classes: dict[tuple[type, int], type] = {}


def _is_async(connection_class: type) -> bool:
    """Whether a redis-py connection class is an ``asyncio`` one."""
    return inspect.iscoroutinefunction(getattr(connection_class, "connect", None))


def guarded_connection_class(base: type, settings: _Settings) -> type:
    """A subclass of the redis-py connection class ``base`` that classifies every command before sending it."""
    key = (base, id(settings))
    found = _classes.get(key)
    if found is None:
        mixin = _AsyncGuard if _is_async(base) else _SyncGuard
        found = _classes[key] = type(f"Guarded{base.__name__}", (mixin, base), {
            "_sendproof_settings": settings, "__module__": __name__,
        })
    return found


def _pool_connections(pool: Any) -> list[Any]:
    """Every connection a redis-py pool currently holds, free or in use."""
    found: list[Any] = []
    for attribute in ("_available_connections", "_in_use_connections", "_connections"):
        found.extend(c for c in list(getattr(pool, attribute, None) or ()) if c is not None)
    return found


def _hook_pool(pool: Any, settings: _Settings) -> None:
    """Guard a connection pool: its future connections, and the ones it already holds."""
    if getattr(pool.connection_class, "_sendproof_settings", None) is not None and issubclass(
        pool.connection_class, (_SyncGuard, _AsyncGuard)
    ):
        raise TypeError("This Redis client is already hooked by redis_store.")
    original = pool.connection_class
    pool.connection_class = guarded_connection_class(original, settings)
    for connection in _pool_connections(pool):
        if not isinstance(connection, (_SyncGuard, _AsyncGuard)):
            try:
                connection.__class__ = guarded_connection_class(type(connection), settings)
            except TypeError:  # a class with a incompatible layout: new connections are still guarded
                pass


class RedisStore(DataStore):
    """A hooked Redis client, ready for ``data_stores``."""

    system = "redis"

    def __init__(self, name: Optional[str], settings: _Settings) -> None:
        self.name = name
        self._settings = settings
        #: A guarded ``redis.Connection`` for pools you build yourself.
        self.connection_class = guarded_connection_class(_default_connection(False), settings)
        #: A guarded ``redis.asyncio.Connection`` for async pools you build yourself.
        self.async_connection_class = guarded_connection_class(_default_connection(True), settings)

    def guard_connection_class(self, base: type) -> type:
        """A guarded subclass of another connection class, such as ``redis.SSLConnection``."""
        return guarded_connection_class(base, self._settings)

    def describe(self) -> dict[str, Any]:
        return {"system": "redis", **({"name": self.name} if self.name else {}), "mode": "guard"}


def _default_connection(asynchronous: bool) -> type:
    if asynchronous:
        from redis.asyncio import Connection
    else:
        from redis import Connection
    return Connection


def redis_store(
    client: Any = None, *, name: Optional[str] = None, treat_as_read: Optional[Iterable[str]] = None,
) -> RedisStore:
    """Hook a redis-py client or connection pool in place and return the store for ``data_stores``.

    ``client`` is a ``redis.Redis``, ``redis.asyncio.Redis``, or a ``ConnectionPool`` or
    ``BlockingConnectionPool`` of either. Pass nothing to get just the store, and build your pool
    with ``store.connection_class`` (or ``store.async_connection_class``). Hooking the same client
    twice is refused, so its commands are never logged twice.

    Args:
        name: A display label for discovery, such as ``cache``. Never a URL or host name.
        treat_as_read: Commands you state never write, such as a custom module read
            ``MYMODULE.GET``: exact upper-case names (or ``CONTAINER|SUB``), no wildcards.
            **The guard trusts this list**: a listed command that does write is not blocked.
    """
    settings = _Settings(read_set(treat_as_read, lambda item: item.upper()))
    store = RedisStore(store_label(name), settings)
    if client is not None:
        pool = getattr(client, "connection_pool", client)
        if not hasattr(pool, "connection_class"):
            raise TypeError(
                "redis_store takes a redis-py client or connection pool. A Redis Cluster client has a pool per node: "
                "call redis_store(name=...) first and build the cluster with connection_class=store.connection_class.")
        _hook_pool(pool, settings)
    return store
