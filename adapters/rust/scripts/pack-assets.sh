#!/usr/bin/env bash
# Packs the shared Test Bench UI into testbench-core/ui-assets for embedding.
# The UI source is never copied into this tree; the packer output is generated.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
version="${1:-0.1.0-alpha.1}"
out="$here/../testbench-core/ui-assets"
rm -rf "$out"
node "$root/tools/pack-ui.mjs" --version "$version" --out "$out"
