#!/usr/bin/env bash
# Builds the conformance fixture binary to artifacts/go/fixture.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
mkdir -p "$root/artifacts/go"
cd "$root/adapters/go/examples"
"$root/adapters/go/scripts/go.sh" build -o "$root/artifacts/go/fixture" ./cmd/fixture
