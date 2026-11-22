#!/usr/bin/env bash
# Proves a fresh consumer can fetch the released Go modules, both ways Go can:
#
#   adapters/go/scripts/verify-release.sh [version, default v0.1.0-alpha.1]
#
# It works on a COPY of the Go tree under artifacts/go-release-check, so the
# repository is not changed. The copy is retargeted to a placeholder repository
# path (never a real one) with tools/set-go-module-path.mjs, which also exercises
# that tool on the real tree. Then it checks two paths a consumer can take:
#
#   zip   the module zips (make-zips.sh) are served by a file-backed module
#         proxy, as the Go proxy would after publication;
#   tags  a git repository holds the commit and the per-module tags from
#         scripts/tags.sh, and Go resolves them by itself (a local git config
#         redirects the placeholder repository URL to the copy).
#
# In each, an empty module outside the repository (scripts/consumer) imports
# every released module with GOWORK=off and a fresh module cache, so go.work and
# any local cache cannot hide a problem (module and build caches are new per run), runs `go mod tidy`, checks every
# released module resolved to the version, and serves the embedded workbench.
#
# Needs network access for third-party dependencies (proxy.golang.org) and git.
set -euo pipefail

version="${1:-v0.1.0-alpha.1}"
[[ "$version" == v* ]] || version="v$version"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
placeholder="github.com/placeholder-owner/placeholder-repo"
work="$root/artifacts/go-release-check"
repo="$work/repo"
golang="$here/scripts/go.sh"

rm -rf "$work"
mkdir -p "$repo/adapters" "$repo/tools"

echo "Copying the Go tree and retargeting it to $placeholder"
# tar rather than rsync, which Git for Windows does not ship.
mkdir -p "$repo/adapters/go"
(cd "$here" && tar --exclude=.git -cf - .) | (cd "$repo/adapters/go" && tar -xf -)
cp "$root/tools/set-go-module-path.mjs" "$repo/tools/"
node "$root/tools/set-go-module-path.mjs" --root "$repo" "$placeholder" | tail -1
base="$(tr -d '[:space:]' < "$repo/adapters/go/MODULE_PATH")"
[[ "$base" == "$placeholder/adapters/go" ]]
node "$root/tools/set-go-module-path.mjs" --root "$repo" --check
old="$(tr -d '[:space:]' < "$here/MODULE_PATH")"
if grep -rqF "$old" "$repo/adapters/go" --include='*.go' --include='go.mod' --include='go.work'; then
  echo "the retargeted copy still names the old module path" >&2
  exit 1
fi

echo "Building the module zips"
(cd "$here/tools/modzip" && "$golang" build -o "$work/modzip" .)
"$here/scripts/make-zips.sh" "$repo/adapters/go" "$version" "$work/zips" "$work/modzip"

proxy="$work/proxy"
for module in . chi gin echo gorm redisbench dynamobench mongobench cassandrabench searchbench cosmosbench firestorebench; do
  path="$base"; [[ "$module" == . ]] || path="$base/$module"
  dir="$proxy/$path/@v"
  mkdir -p "$dir"
  cp "$work/zips/$(echo "$path" | tr '/' '_')@$version.zip" "$dir/$version.zip"
  cp "$repo/adapters/go/$module/go.mod" "$dir/$version.mod"
  printf '{"Version":"%s","Time":"2026-01-01T00:00:00Z"}\n' "$version" > "$dir/$version.info"
  printf '%s\n' "$version" > "$dir/list"
done

echo "Creating the git repository and tags"
tags="$("$repo/adapters/go/scripts/tags.sh" "$version")"
(
  cd "$repo"
  git init -q -b main
  git config core.autocrlf false
  git add -A
  git -c user.name=verify -c user.email=verify@example.invalid commit -q -m "Go modules $version"
  while read -r tag; do git -c user.name=verify -c user.email=verify@example.invalid tag "$tag"; done <<< "$tags"
)
printf '[url "file://%s"]\n\tinsteadOf = https://%s\n' "$repo" "$placeholder" > "$work/gitconfig"

# consume <name> <GOPROXY> <GOPRIVATE> — builds the consumer module and checks the result.
# GOPRIVATE makes Go skip the proxy and fetch the placeholder repository by git.
consume() {
  local name="$1" proxy_setting="$2" private="$3" dir="$work/consumer-$1"
  mkdir -p "$dir"
  sed "s#{{BASE}}#$base#g" "$here/scripts/consumer/main.go.tmpl" > "$dir/main.go"
  printf 'module example.com/consumer\n\ngo 1.24\n' > "$dir/go.mod"
  echo "Fresh consumer via $name"
  (
    cd "$dir"
    export GOWORK=off GOFLAGS=-modcacherw GOSUMDB=off GOPROXY="$proxy_setting" \
      GOPRIVATE="$private" GOPATH="$work/gopath-$name" GOCACHE="$work/gocache-$name" \
      GIT_CONFIG_GLOBAL="$work/gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
    "$golang" mod tidy
    resolved="$("$golang" list -m -f '{{.Path}} {{.Version}}' all | grep "^$base" || true)"
    echo "$resolved" | sed 's/^/  /'
    count="$(echo "$resolved" | grep -c " $version\$" || true)"
    if [[ "$count" != "12" ]]; then
      echo "expected the twelve released modules at $version, resolved $count" >&2
      exit 1
    fi
    "$golang" run .
  )
}

consume zip "file://$proxy,https://proxy.golang.org,direct" ""
consume tags "https://proxy.golang.org,direct" "${placeholder%/*}/*"

echo "Release verification passed for $version (zip and tags)."
