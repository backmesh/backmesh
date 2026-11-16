#!/bin/sh
# Installs the backmesh CLI:
#
#   curl -fsSL https://backmesh.com/install.sh | sh
#
# It downloads the latest release's binary for this machine from
# backmesh/backmesh-releases, checks it against the release's
# checksums.txt, and puts it in ~/.local/bin (/usr/local/bin as root), or
# replaces the backmesh already on PATH. BACKMESH_VERSION=0.3.2 pins a release.
set -eu

fail() {
  echo "Error: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "backmesh runs on macOS and Linux, not $(uname -s)." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "backmesh has no build for $(uname -m)." ;;
esac
asset="backmesh-$os-$arch.tar.gz"

base=https://github.com/backmesh/backmesh-releases/releases
version="${BACKMESH_VERSION:-}"
version="${version#v}"
if [ -n "$version" ]; then
  url="$base/download/v$version"
else
  url="$base/latest/download"
fi

# Replace a backmesh already on PATH, unless Homebrew manages it.
existing=$(command -v backmesh 2>/dev/null || true)
case "$existing" in
  /*)
    case "$(readlink "$existing" 2>/dev/null || true)" in
      */Cellar/backmesh/*) fail "Homebrew manages $existing. Update it with: brew upgrade backmesh" ;;
    esac
    dir=$(dirname "$existing")
    ;;
  *)
    if [ "$(id -u)" -eq 0 ]; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
    ;;
esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/backmesh-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

echo "Downloading backmesh ${version:-latest} for $os-$arch..."
curl -fsSLo "$tmp/$asset" "$url/$asset" || fail "couldn't download $url/$asset"
curl -fsSLo "$tmp/checksums.txt" "$url/checksums.txt" || fail "couldn't download $url/checksums.txt"

# Check only this platform's line, and refuse anything that doesn't match.
awk -v a="$asset" '$2 == a' "$tmp/checksums.txt" >"$tmp/sum"
[ -s "$tmp/sum" ] || fail "checksums.txt has no line for $asset."
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$@"; }
else
  fail "sha256sum or shasum is needed to check the download."
fi
(cd "$tmp" && sha256 -c sum >/dev/null 2>&1) || fail "$asset doesn't match its SHA-256 in checksums.txt; nothing was installed."

tar --no-same-owner -xzf "$tmp/$asset" -C "$tmp" backmesh || fail "couldn't unpack $asset."
chmod 755 "$tmp/backmesh"

mkdir -p "$dir" 2>/dev/null || true
if [ -w "$dir" ]; then
  mv -f "$tmp/backmesh" "$dir/backmesh"
elif [ -n "$existing" ]; then
  # Only an existing install somewhere an administrator owns uses sudo.
  echo "$dir needs an administrator to change, so replacing backmesh there uses sudo."
  sudo install -m 755 "$tmp/backmesh" "$dir/backmesh"
else
  fail "can't write to $dir."
fi

# The PATH hint names $HOME rather than its value, so the line needs no quoting.
# shellcheck disable=SC2016
if [ "$dir" = "$HOME/.local/bin" ]; then shown='$HOME/.local/bin'; else shown=$dir; fi
echo "Installed backmesh $("$dir/backmesh" --version) to $dir/backmesh."
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "$dir isn't on your PATH. Add this line to your shell's profile, such as ~/.zshrc or ~/.bashrc: export PATH=\"$shown:\$PATH\"" ;;
esac
