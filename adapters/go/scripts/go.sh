#!/usr/bin/env bash
# Runs the project-local Go toolchain (installing it first when needed) with its
# module and build caches kept under artifacts/. Usage: adapters/go/scripts/go.sh <go args>
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
local_go="$root/artifacts/go-toolchain/go/bin/go"

if [[ ! -x "$local_go" ]]; then
  if command -v go >/dev/null 2>&1 && [[ "${TESTBENCH_FORCE_LOCAL_GO:-}" != "1" ]]; then
    exec go "$@"
  fi
  "$(dirname "${BASH_SOURCE[0]}")/setup-go.sh" >&2
fi

export GOTOOLCHAIN=local
export GOPATH="${GOPATH:-$root/artifacts/gopath}"
export GOCACHE="${GOCACHE:-$root/artifacts/gocache}"
exec "$local_go" "$@"
