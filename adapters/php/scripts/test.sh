#!/bin/sh
# Runs the PHP unit and integration suites. Run from the repository root: sh adapters/php/scripts/test.sh
set -eu
root="$(cd "$(dirname "$0")/../../.." && pwd)"
for package in core laravel symfony; do
  (cd "$root/adapters/php/$package" && vendor/bin/phpunit)
done
# core resolves elasticsearch/elasticsearch 9; many applications are still on 8 (elastic/transport 8).
(cd "$root/adapters/php/core/compat/elasticsearch-8" && vendor/bin/phpunit)
