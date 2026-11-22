#!/usr/bin/env bash
# Verifies and packages the Go modules for release.
#
#   adapters/go/scripts/package.sh <version> [output directory]
#
# 1. Checks the module metadata: one module path (MODULE_PATH), no replace
#    directive in any go.mod, and every internal requirement at <version>.
# 2. Regenerates the embedded UI and fails if the committed copy was stale.
# 3. Runs vet and the race-detector tests of every module (in go.work mode).
# 4. Writes the module zips the Go proxy would serve to artifacts/go-packages/,
#    without the local go.work files, and checks the core zip carries the
#    embedded workbench. Also writes the git tags to create (tags.txt) and
#    SHA256SUMS.
#
# Pair it with scripts/verify-release.sh, which proves a fresh consumer can
# fetch the zips and the tags.
set -euo pipefail

# Git for Windows ships sha256sum but not shasum; both print "<hash>  <file>".
if ! command -v shasum >/dev/null 2>&1; then
  shasum() { shift 2; sha256sum "$@"; }
fi

version="${1:?usage: package.sh <version, e.g. v0.1.0> [output directory]}"
[[ "$version" == v* ]] || version="v$version"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
out="${2:-$root/artifacts/go-packages}"
base="$(tr -d '[:space:]' < "$here/MODULE_PATH")"
modules=(. chi gin echo gorm redisbench dynamobench mongobench cassandrabench searchbench cosmosbench firestorebench)

echo "Checking module metadata"
node "$root/tools/set-go-module-path.mjs" --check
tags="$("$here/scripts/tags.sh" "$version")"
for module in "${modules[@]}" examples; do
  # Internal requirements must name the release, or a consumer would resolve a
  # different version of a sibling module than the one tested here.
  stale="$(awk -v base="$base" -v want="$version" '
    { for (i = 1; i <= NF; i++) if (index($i, base) == 1 && $(i + 1) ~ /^v[0-9]/ && $(i + 1) != want) print $i " " $(i + 1) }
  ' "$here/$module/go.mod")"
  if [[ -n "$stale" ]]; then
    echo "$module/go.mod requires internal modules at a version other than $version:" >&2
    echo "$stale" >&2
    echo "Update the requirements and the go.work replace block to $version, then run scripts/tidy.sh." >&2
    exit 1
  fi
done
if ! grep -q "$version => " "$here/go.work"; then
  echo "go.work does not map $version to the local modules; update its replace block." >&2
  exit 1
fi

mkdir -p "$out"
echo "Checking the embedded UI is current"
before="$(shasum -a 256 "$here/internal/ui/dist/manifest.json" | cut -d' ' -f1)"
(cd "$here" && ./scripts/go.sh generate ./internal/ui >/dev/null)
after="$(shasum -a 256 "$here/internal/ui/dist/manifest.json" | cut -d' ' -f1)"
if [[ "$before" != "$after" ]]; then
  echo "internal/ui/dist was stale and has been regenerated; review and commit it, then rerun." >&2
  exit 1
fi

"$here/scripts/test.sh"

zipper="$out/modzip"
(cd "$here/tools/modzip" && "$here/scripts/go.sh" build -o "$zipper" .)
"$here/scripts/make-zips.sh" "$here" "$version" "$out" "$zipper"
rm -f "$zipper"
printf '%s\n' "$tags" > "$out/tags.txt"
(cd "$out" && shasum -a 256 -- *@"$version".zip > SHA256SUMS)
echo "Tags to create, core first:"
sed 's/^/  /' "$out/tags.txt"
