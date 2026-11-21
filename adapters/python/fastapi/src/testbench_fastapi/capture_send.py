"""Buffers an ASGI response so that a preview can wrap it in an envelope."""

from __future__ import annotations

from typing import Any

from testbench_core import limits


class ResponseTooLarge(Exception):
    """The inner response exceeded the 1 MiB preview cap."""


class BufferedResponse:
    """An ASGI ``send`` callable that keeps the status, headers and a bounded body."""

    def __init__(self, maximum: int = limits.RESPONSE_BYTES) -> None:
        self.status = 500
        self.headers: list[tuple[str, str]] = []
        self.started = False
        self.complete = False
        self.exceeded = False
        self._maximum = maximum
        self._chunks: list[bytes] = []
        self._size = 0

    async def __call__(self, message: dict[str, Any]) -> None:
        kind = message["type"]
        if kind == "http.response.start":
            self.started = True
            self.status = message["status"]
            self.headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in message.get("headers", [])]
        elif kind == "http.response.body":
            chunk = message.get("body", b"")
            self._size += len(chunk)
            if self._size > self._maximum:
                self.exceeded = True
                raise ResponseTooLarge
            self._chunks.append(chunk)
            self.complete = not message.get("more_body", False)
        elif kind in ("http.response.pathsend", "http.response.zerocopysend"):
            raise RuntimeError("Test Bench previews require a buffered response.")

    def header(self, name: str) -> str | None:
        """First header value, case-insensitive."""
        lowered = name.lower()
        return next((v for k, v in self.headers if k.lower() == lowered), None)

    @property
    def body(self) -> bytes:
        return b"".join(self._chunks)
