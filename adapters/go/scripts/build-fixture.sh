#!/usr/bin/env bash
# Builds the conformance fixture binary to artifacts/go/fixture (fixture.exe on Windows,
# which the conformance runner finds from the same manifest path).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
mkdir -p "$root/artifacts/go"
cd "$root/adapters/go/examples"
go="$root/adapters/go/scripts/go.sh"
"$go" build -o "$root/artifacts/go/fixture$("$go" env GOEXE)" ./cmd/fixture
