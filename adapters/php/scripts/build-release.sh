#!/bin/sh
# Builds installable release ZIPs for the PHP packages, with the shared workbench UI embedded.
#
#   sh adapters/php/scripts/build-release.sh [version]     # default 0.1.0-alpha.1
#
# The UI bundle is generated output and is not tracked in git, so a git tag alone would ship
# without it. These archives are the distributable form: `composer archive` honours each
# package's `archive.exclude` (no vendor, tests or lockfiles) and includes `core/resources/ui`.
# Output goes to adapters/php/dist/ (ignored by git). Fails if a ZIP lacks the UI manifest.
set -eu
version="${1:-0.1.0-alpha.1}"
root="$(cd "$(dirname "$0")/../../.." && pwd)"
dist="$root/adapters/php/dist"

node "$root/tools/pack-ui.mjs" --version "$version" --out "$root/adapters/php/core/resources/ui"
rm -rf "$dist"
mkdir -p "$dist"

for package in core laravel symfony; do
  composer archive --working-dir "$root/adapters/php/$package" --format=zip --dir="$dist" --file="testbench-$package-$version" --no-interaction
done

# Verify packaging: the core ZIP must carry the UI, and no ZIP may carry dependencies or tests.
for zip in "$dist"/*.zip; do
  listing="$(unzip -Z1 "$zip")"
  if printf '%s\n' "$listing" | grep -Eq '(^|/)(vendor|tests)/'; then
    echo "error: $zip contains vendor/ or tests/" >&2
    exit 1
  fi
done
unzip -Z1 "$dist/testbench-core-$version.zip" | grep -q '^resources/ui/manifest.json$' \
  || { echo "error: core ZIP is missing resources/ui/manifest.json" >&2; exit 1; }
unzip -Z1 "$dist/testbench-core-$version.zip" | grep -q '^resources/ui/index.html$' \
  || { echo "error: core ZIP is missing resources/ui/index.html" >&2; exit 1; }

echo "Built:"
ls -1 "$dist"
