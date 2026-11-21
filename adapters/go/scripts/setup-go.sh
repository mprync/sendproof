#!/usr/bin/env bash
# Installs a pinned, checksum-verified Go toolchain under artifacts/go-toolchain.
# Nothing is installed system-wide. go.sh runs this on demand when no Go is on PATH.
set -euo pipefail

GO_VERSION="1.26.11"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
target="$root/artifacts/go-toolchain"

if [[ -x "$target/go/bin/go" ]] && "$target/go/bin/go" version | grep -q "go${GO_VERSION} "; then
  echo "Go ${GO_VERSION} already installed at $target/go"
  exit 0
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="amd64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# SHA-256 values are copied from https://go.dev/dl/?mode=json for go${GO_VERSION}.
case "${os}-${arch}" in
  darwin-arm64) sha="e3a42e67a7a8acf450ebada2b074c7ca863000ca514907b7185b45e8f5cdff57" ;;
  darwin-amd64) sha="394baae971332f2bc783d6e2004ae57101479bd3b06ed8209a3fe3570d4ce498" ;;
  linux-amd64)  sha="9849f4e04ee35303714e34fbc3ac8ab44ea3e448a95aa182f91e3b9b79c710ec" ;;
  linux-arm64)  sha="6c2f29b458b5add0835f18b776f69c8881a6d88428f1484a6da55755e620757e" ;;
  *) echo "No pinned Go archive for ${os}-${arch}" >&2; exit 1 ;;
esac

archive="go${GO_VERSION}.${os}-${arch}.tar.gz"
download="$root/artifacts/go-download/dl"
mkdir -p "$download" "$target"
if [[ ! -f "$download/$archive" ]]; then
  curl --fail --silent --show-error --location --output "$download/$archive" "https://dl.google.com/go/$archive"
fi

actual="$(shasum -a 256 "$download/$archive" | cut -d' ' -f1)"
if [[ "$actual" != "$sha" ]]; then
  rm -f "$download/$archive"
  echo "Checksum mismatch for $archive: expected $sha, got $actual" >&2
  exit 1
fi

rm -rf "$target/go"
tar -xzf "$download/$archive" -C "$target"
"$target/go/bin/go" version
