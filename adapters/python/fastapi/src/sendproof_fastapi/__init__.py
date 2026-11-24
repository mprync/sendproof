"""Sendproof workbench, rollback previews and observed sends for FastAPI and Starlette."""

from sendproof_core import AuthProvider, Identity, OpenApiDocument

from .bench import Sendproof
from .marker import preview

__all__ = ["AuthProvider", "Identity", "OpenApiDocument", "Sendproof", "preview"]
__version__ = "0.1.0a2"
