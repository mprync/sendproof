#!/usr/bin/env bash
# Packs the shared Sendproof UI into sendproof-core/ui-assets for embedding.
# The UI source is never copied into this tree; the packer output is generated.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
version="${1:-0.1.0-alpha.3}"
out="$here/../sendproof-core/ui-assets"
rm -rf "$out"
node "$root/tools/pack-ui.mjs" --version "$version" --out "$out"
