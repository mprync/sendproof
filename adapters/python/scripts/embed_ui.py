#!/usr/bin/env python3
"""Embed the shared UI bundle into ``sendproof-core``.

Runs the repository's packer (``node tools/pack-ui.mjs``) into a temporary directory, then
copies the result, including ``manifest.json``, to ``core/src/sendproof_core/ui``. The UI
source is never copied or edited. Re-run after any UI change. The target is ignored by git.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TARGET = ROOT / "adapters/python/core/src/sendproof_core/ui"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default="0.1.0-alpha.1", help="UI bundle version passed to the packer")
    parser.add_argument("--target", type=Path, default=TARGET)
    args = parser.parse_args()
    packer = ROOT / "tools/pack-ui.mjs"
    if not packer.is_file():
        print(f"error: {packer} not found", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory(prefix="sendproof-ui-") as scratch:
        subprocess.run(["node", str(packer), "--version", args.version, "--out", scratch], cwd=ROOT, check=True)
        manifest = json.loads((Path(scratch) / "manifest.json").read_text("utf-8"))
        if args.target.exists():
            shutil.rmtree(args.target)
        shutil.copytree(scratch, args.target)
    print(f"Embedded {len(manifest['files'])} UI files ({manifest['bundleHash'][:12]}) into {args.target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
