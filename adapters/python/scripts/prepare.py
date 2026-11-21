#!/usr/bin/env python3
"""Create ``adapters/python/.venv`` and install every package from source.

Steps: create the virtual environment (``uv`` when available, else ``venv``), install the local
packages in editable mode with their test dependencies, then embed the shared UI bundle.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
VENV = HERE / ".venv"
PACKAGES = ["core", "sqlalchemy", "fastapi", "flask", "django"]
TEST_DEPENDENCIES = [
    "greenlet", "uvicorn", "httpx", "pytest", "pytest-asyncio", "aiosqlite", "build", "hatchling",
    "django-ninja", "djangorestframework", "flask-sqlalchemy", "psycopg[binary]", "pymysql",
    # Data-store clients: the hooks in sendproof_core.stores are tested against these.
    "redis", "boto3", "aioboto3", "pymongo", "motor",
]


def run(*command: str) -> None:
    # Caches live in the project so that sandboxed runs never need to write to the home directory.
    cache = HERE / ".cache"
    env = {**os.environ, "UV_CACHE_DIR": os.environ.get("UV_CACHE_DIR", str(cache / "uv")),
           "PIP_CACHE_DIR": os.environ.get("PIP_CACHE_DIR", str(cache / "pip"))}
    subprocess.run(command, check=True, env=env)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", default="3.12", help="Python version for the virtual environment")
    parser.add_argument("--extra", nargs="*", default=[], help="additional package directories to install")
    args = parser.parse_args()
    # Virtual environments keep the interpreter in Scripts\ on Windows and bin/ everywhere else.
    python = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    uv = shutil.which("uv")
    if not python.exists():
        if uv:
            run(uv, "venv", "-p", args.python, str(VENV))
        else:
            run(sys.executable, "-m", "venv", str(VENV))
    editable = [arg for name in [*PACKAGES, *args.extra] for arg in ("-e", str(HERE / name))]
    if uv:
        run(uv, "pip", "install", "-p", str(python), *editable, *TEST_DEPENDENCIES)
    else:
        run(str(python), "-m", "pip", "install", *editable, *TEST_DEPENDENCIES)
    run(str(python), str(HERE / "scripts/embed_ui.py"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
