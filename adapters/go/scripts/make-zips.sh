#!/usr/bin/env bash
# Writes the module zip of each released Go module, as the module proxy builds it.
#
#   make-zips.sh <adapters/go directory> <version> <output directory> <modzip binary>
#
# Used by package.sh for the real tree and by verify-release.sh for a copy with a
# placeholder module path. The local go.work files are left out of the zips, and
# the core zip must carry the embedded workbench.
set -euo pipefail

dir="${1:?adapters/go directory}"
version="${2:?version}"
out="${3:?output directory}"
zipper="${4:?modzip binary}"
base="$(tr -d '[:space:]' < "$dir/MODULE_PATH")"

mkdir -p "$out"
rm -f "$out"/*@"$version".zip
for module in . chi gin echo gorm redisbench dynamobench mongobench; do
  path="$base"; [[ "$module" == . ]] || path="$base/$module"
  required="go.mod"
  [[ "$module" != . ]] || required="internal/ui/dist/index.html,internal/ui/dist/manifest.json,go.mod,MODULE_PATH"
  "$zipper" -dir "$dir/$module" -path "$path" -version "$version" \
    -out "$out/$(echo "$path" | tr '/' '_')@$version.zip" \
    -exclude go.work,go.work.sum -forbid go.work,go.work.sum -require "$required"
done
