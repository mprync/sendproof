"""Framework-neutral core of the Sendproof Python adapters.

Applications normally import the framework package (``sendproof_fastapi``) and use this
module for the effect recording helpers::

    from sendproof_core import record_email

    if not record_email("Welcome", sender, [to], [], "Hello", "Welcome aboard"):
        send_mail(...)
"""

from .effects import (
    is_previewing,
    record_effect,
    record_email,
    record_http,
    record_job,
    record_log,
    record_message,
)
from .identity import Identity
from .options import AuthProvider, BenchOptions, OpenApiDocument
from .provider import (
    PreviewChange,
    PreviewObservation,
    PreviewProvider,
    PreviewRollbackError,
    PreviewSession,
    PreviewUnavailable,
)
from .scope import RequestScope, current_scope, detached

__all__ = [
    "detached",
    "AuthProvider",
    "BenchOptions",
    "Identity",
    "OpenApiDocument",
    "PreviewChange",
    "PreviewObservation",
    "PreviewProvider",
    "PreviewRollbackError",
    "PreviewSession",
    "PreviewUnavailable",
    "RequestScope",
    "current_scope",
    "is_previewing",
    "record_effect",
    "record_email",
    "record_http",
    "record_job",
    "record_log",
    "record_message",
]

__version__ = "0.1.0a2"
