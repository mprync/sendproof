"""Capture limits shared by every adapter.

The values match the .NET adapters so that one UI renders every binding.
"""

from __future__ import annotations

LOGS = 500
EFFECTS = 100
CHANGES = 200
PROPERTIES = 32
PARAMETERS = 64
NAME = 256
TEXT = 4096
PAYLOAD_BYTES = 16 * 1024
LOG_BUDGET = 128 * 1024
CHANGE_BUDGET = 128 * 1024
MAX_DEPTH = 16
RESPONSE_BYTES = 1024 * 1024


def clip(value: str, maximum: int = TEXT) -> str:
    """Truncate ``value`` to ``maximum`` characters."""
    return value if len(value) <= maximum else value[:maximum]
