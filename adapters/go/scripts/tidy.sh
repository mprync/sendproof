#!/usr/bin/env bash
# Runs `go mod tidy` for the Go modules without putting a replace directive in
# any go.mod.
#
#   adapters/go/scripts/tidy.sh [module ...]     (default: every module)
#
# The modules require each other at a released version that does not exist
# until it is tagged, so a plain `go mod tidy` cannot resolve them. This script
# tidies a temporary copy of each go.mod (go.tidy.mod) that maps those versions to
# the checked-out directories, then writes the result back without the mapping.
# Add or change a third-party dependency by importing it and running this script;
# `go get` is not available in workspace mode.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base="$(tr -d '[:space:]' < "$here/MODULE_PATH")"
modules=("$@")
[[ ${#modules[@]} -gt 0 ]] || modules=(. chi echo gin gorm redisbench dynamobench mongobench cassandrabench searchbench cosmosbench firestorebench examples tools/modzip)

# Directory of each internal module, keyed by module path suffix.
dir_of() { case "$1" in "$base") echo "$here" ;; "$base"/*) echo "$here/${1#"$base"/}" ;; *) return 1 ;; esac; }

for module in "${modules[@]}"; do
  dir="$here/$module"
  [[ "$module" != . ]] || dir="$here"
  tmp="$dir/go.tidy.mod"
  trap 'rm -f "$dir/go.tidy.mod" "$dir/go.tidy.sum"' EXIT
  cp "$dir/go.mod" "$tmp"
  cp "$dir/go.sum" "${tmp%.mod}.sum" 2>/dev/null || : > "${tmp%.mod}.sum"
  {
    echo
    # Every internal module this go.mod requires, at the version it requires.
    awk -v base="$base" '
      { for (i = 1; i <= NF; i++) if (index($i, base) == 1 && $(i + 1) ~ /^v[0-9]/) print $i, $(i + 1) }
    ' "$dir/go.mod" | sort -u | while read -r path version; do
      printf 'replace %s %s => %s\n' "$path" "$version" "$(dir_of "$path")"
    done
  } >> "$tmp"
  (cd "$dir" && GOWORK=off "$here/scripts/go.sh" mod tidy -modfile="$tmp")
  # Write back without the temporary replace lines and trailing blank line.
  grep -v '^replace ' "$tmp" | perl -0pe 's/\n+\z/\n/' > "$dir/go.mod"
  if [[ -s "${tmp%.mod}.sum" ]]; then mv "${tmp%.mod}.sum" "$dir/go.sum"; else rm -f "${tmp%.mod}.sum" "$dir/go.sum"; fi
  rm -f "$tmp"
  trap - EXIT
  echo "tidied $module"
done
