#!/bin/bash
# Runs website/public/install.sh against a stand-in release: a `curl` on PATH
# serves a fake backmesh binary and its checksums.txt, and records each URL.
#
#   test/install/install.test.sh
set -euo pipefail

script=$(cd "$(dirname "$0")/../.." && pwd)/website/public/install.sh
shellcheck -s sh "$script"

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset=backmesh-linux-x64.tar.gz ;;
  Linux-aarch64) asset=backmesh-linux-arm64.tar.gz ;;
  Darwin-x86_64) asset=backmesh-darwin-x64.tar.gz ;;
  Darwin-arm64) asset=backmesh-darwin-arm64.tar.gz ;;
esac

mkdir -p "$root/release" "$root/shim"
printf '#!/bin/sh\necho 9.9.9\n' >"$root/release/backmesh"
chmod +x "$root/release/backmesh"
tar -czf "$root/release/$asset" -C "$root/release" backmesh
(cd "$root/release" && sha256sum "$asset" >checksums.txt)
# curl -fsSLo <file> <url>
cat >"$root/shim/curl" <<EOF
#!/bin/sh
echo "\$3" >>"$root/urls"
cp "$root/release/\${3##*/}" "\$2"
EOF
chmod +x "$root/shim/curl"

run() { # <home> [env...]: the installer's output, with a minimal PATH
  local home=$1
  shift
  env -i HOME="$home" PATH="${EXTRA_PATH:-}$root/shim:/usr/bin:/bin" "$@" sh "$script"
}
fail() { echo "FAIL: $*" >&2; exit 1; }

# A fresh install lands in ~/.local/bin and says how to put it on PATH.
out=$(run "$root/home1")
[[ $("$root/home1/.local/bin/backmesh") == 9.9.9 ]] || fail "not installed: $out"
grep -q "Installed backmesh 9.9.9 to $root/home1/.local/bin/backmesh." <<<"$out" || fail "$out"
# shellcheck disable=SC2016 # the hint's literal $HOME
grep -qF 'export PATH="$HOME/.local/bin:$PATH"' <<<"$out" || fail "no PATH hint: $out"
grep -qx "https://github.com/backmesh/backmesh-releases/releases/latest/download/$asset" "$root/urls" || fail "$(cat "$root/urls")"

# BACKMESH_VERSION pins the release, with or without its v.
run "$root/home2" BACKMESH_VERSION=v0.3.2 >/dev/null
grep -qx "https://github.com/backmesh/backmesh-releases/releases/download/v0.3.2/checksums.txt" "$root/urls" || fail "$(cat "$root/urls")"

# A backmesh already on PATH is replaced where it is, with no PATH hint.
mkdir -p "$root/opt"
printf '#!/bin/sh\necho 0.0.1\n' >"$root/opt/backmesh"
chmod +x "$root/opt/backmesh"
out=$(EXTRA_PATH="$root/opt:" run "$root/home3")
[[ $("$root/opt/backmesh") == 9.9.9 && ! -e "$root/home3/.local/bin/backmesh" ]] || fail "not replaced in place: $out"
! grep -q "isn't on your PATH" <<<"$out" || fail "PATH hint for a dir on PATH: $out"

# Without sha256sum, shasum checks it, as on macOS.
mkdir -p "$root/tools"
for tool in sh uname id mktemp awk dirname cat cp chmod mkdir mv rm tar gzip shasum perl readlink; do
  ln -s "$(command -v "$tool")" "$root/tools/$tool"
done
env -i HOME="$root/home5" PATH="$root/shim:$root/tools" "$root/tools/sh" "$script" >/dev/null
[[ $("$root/home5/.local/bin/backmesh") == 9.9.9 ]] || fail "not installed with shasum"

# Homebrew's backmesh is left to brew.
mkdir -p "$root/brew/Cellar/backmesh/1/bin" "$root/brew/bin"
cp "$root/opt/backmesh" "$root/brew/Cellar/backmesh/1/bin/backmesh"
ln -s ../Cellar/backmesh/1/bin/backmesh "$root/brew/bin/backmesh"
if out=$(EXTRA_PATH="$root/brew/bin:" run "$root/home6" 2>&1); then fail "replaced Homebrew's backmesh: $out"; fi
grep -q "brew upgrade backmesh" <<<"$out" || fail "$out"

# A checksums.txt without this platform's line installs nothing.
cp "$root/release/checksums.txt" "$root/checksums.txt"
sed -i "s/$asset/backmesh-other.tar.gz/" "$root/release/checksums.txt"
if out=$(run "$root/home7" 2>&1); then fail "installed without a checksum: $out"; fi
grep -q "has no line for $asset" <<<"$out" || fail "$out"
[[ ! -e "$root/home7/.local/bin/backmesh" ]] || fail "installed without a checksum"
cp "$root/checksums.txt" "$root/release/checksums.txt"

# A tampered download installs nothing.
echo tampered >>"$root/release/$asset"
if out=$(run "$root/home4" 2>&1); then fail "installed a tampered binary: $out"; fi
grep -q "doesn't match its SHA-256" <<<"$out" || fail "$out"
[[ ! -e "$root/home4/.local/bin/backmesh" ]] || fail "tampered binary installed"

echo "install.sh tests passed"
