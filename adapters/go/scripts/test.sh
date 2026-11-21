#!/usr/bin/env bash
# Runs vet and the tests of every Go module with the race detector.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for module in . chi gin echo gorm redisbench dynamobench mongobench examples tools/modzip; do
  (cd "$here/$module" && "$here/scripts/go.sh" vet ./... && "$here/scripts/go.sh" test -race -count=1 ./...)
done
