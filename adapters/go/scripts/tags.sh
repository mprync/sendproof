#!/usr/bin/env bash
# Prints the git tags that publish the Go modules at one version, one per line.
#
#   adapters/go/scripts/tags.sh <version, e.g. v0.1.0>
#
# A Go module in a repository subdirectory is versioned by a tag named
# "<subdirectory>/<version>", so the core module (adapters/go) is
# adapters/go/v0.1.0 and the chi module is adapters/go/chi/v0.1.0. Tag the core
# first, wait for the proxy to serve it, then tag the others: they require it.
# Fails when a module path does not equal the repository path plus its
# subdirectory, because a tag could then never resolve to that path.
set -euo pipefail

version="${1:?usage: tags.sh <version, e.g. v0.1.0>}"
[[ "$version" == v* ]] || version="v$version"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base="$(tr -d '[:space:]' < "$here/MODULE_PATH")"
repository="${base%/adapters/go}"
[[ "$repository" != "$base" ]] || { echo "MODULE_PATH must end with /adapters/go: $base" >&2; exit 1; }

for module in . chi gin echo gorm redisbench dynamobench mongobench; do
  directory="adapters/go"; [[ "$module" == . ]] || directory="adapters/go/$module"
  declared="$(awk '$1 == "module" { print $2; exit }' "$here/$module/go.mod")"
  if [[ "$declared" != "$repository/$directory" ]]; then
    echo "$module/go.mod declares $declared but its tag path implies $repository/$directory" >&2
    exit 1
  fi
  echo "$directory/$version"
done
