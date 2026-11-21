#!/usr/bin/env python3
"""Build wheels and sdists for every package into ``adapters/python/dist``.

Embeds the UI bundle first and fails if the core wheel does not contain it with its manifest.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
PACKAGES = ["core", "sqlalchemy", "fastapi", "flask", "django"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extra", nargs="*", default=[], help="additional package directories")
    parser.add_argument("--out", type=Path, default=HERE / "dist")
    args = parser.parse_args()
    subprocess.run([sys.executable, str(HERE / "scripts/embed_ui.py")], check=True)
    if args.out.exists():
        shutil.rmtree(args.out)
    cache = HERE / ".cache"
    env = {**os.environ, "PIP_CACHE_DIR": os.environ.get("PIP_CACHE_DIR", str(cache / "pip"))}
    for name in [*PACKAGES, *args.extra]:
        subprocess.run([sys.executable, "-m", "build", "--no-isolation", "--outdir", str(args.out), str(HERE / name)], check=True, env=env)
    wheel = next(args.out.glob("sendproof_core-*.whl"))
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
    if "sendproof_core/ui/manifest.json" not in names or "sendproof_core/ui/index.html" not in names:
        print("error: the core wheel is missing the embedded UI bundle", file=sys.stderr)
        return 1
    print("Built:", *sorted(path.name for path in args.out.iterdir()), sep="\n  ")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
