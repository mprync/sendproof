"""Secret detection and redaction, shared with the other adapters."""

from sendproof_core.redaction import REDACTED, looks_secret

__all__ = ["REDACTED", "looks_secret"]
