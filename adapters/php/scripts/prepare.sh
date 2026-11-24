#!/bin/sh
# Installs project-local dependencies for the PHP bindings and embeds the shared workbench UI bundle.
# Run from the repository root: sh adapters/php/scripts/prepare.sh
set -eu
root="$(cd "$(dirname "$0")/../../.." && pwd)"
node "$root/tools/pack-ui.mjs" --version 0.1.0-alpha.3 --out "$root/adapters/php/core/resources/ui"
for package in core core/compat/elasticsearch-8 laravel symfony examples/laravel-fixture examples/symfony-fixture; do
  composer install --working-dir "$root/adapters/php/$package" --no-interaction --no-progress --prefer-dist
done
