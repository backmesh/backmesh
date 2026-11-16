#!/bin/bash
# Builds the CLI as one binary per platform, each in its own
# binaries/backmesh-<platform>.tar.gz with LICENSE and the third-party
# NOTICE, and binaries/checksums.txt. Each binary
# embeds BACKMESH_RELEASE_VERSION when set (the release's tag, such as
# 0.3.0-rc.4), else package.json's version, and, when it's there,
# compatibility.json.
#
#   scripts/build-binaries.sh [bun-<os>-<arch>...]
set -euo pipefail

targets=("$@")
[[ ${#targets[@]} -gt 0 ]] || targets=(bun-linux-x64 bun-linux-arm64 bun-darwin-x64 bun-darwin-arm64)
version=${BACKMESH_RELEASE_VERSION:-$(jq -r .version package.json)}
defines=(--define "BACKMESH_VERSION=$(jq -n --arg v "$version" '$v')")
if [[ -f compatibility.json ]]; then
  defines+=(--define "BACKMESH_COMPATIBILITY=$(jq -c . compatibility.json | jq -R .)")
fi

# Bun's darwin output can carry a signature macOS rejects at launch (a
# zero-padded last page hash before Bun 1.4.1, and darwin-x64 keeps
# its template's stale signature), so each darwin binary is ad-hoc re-signed
# and verified. On Linux that uses rcodesign, pinned by version and checksum.
RCODESIGN_VERSION=0.29.0
rcodesign_dir=""
trap '[[ -z $rcodesign_dir ]] || rm -rf "$rcodesign_dir"' EXIT
ad_hoc_sign() {
  if [[ $(uname -s) == Darwin ]]; then
    codesign --force --sign - "$1"
    return
  fi
  local arch sha name
  arch=$(uname -m)
  name=apple-codesign-$RCODESIGN_VERSION-$arch-unknown-linux-musl
  if [[ -z $rcodesign_dir ]]; then
    case $arch in
      x86_64) sha=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002 ;;
      aarch64) sha=4af92c87ddf52f5f2d1258a3b4e56c7dcb8f1b2468df744976c5f139e031961f ;;
      *) echo "No pinned rcodesign for $arch" >&2; exit 1 ;;
    esac
    rcodesign_dir=$(mktemp -d)
    # GitHub's release downloads can answer 504 for a while.
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 -o "$rcodesign_dir/rcodesign.tar.gz" \
      "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/$RCODESIGN_VERSION/$name.tar.gz"
    echo "$sha  $rcodesign_dir/rcodesign.tar.gz" | sha256sum -c --quiet
    tar -xzf "$rcodesign_dir/rcodesign.tar.gz" -C "$rcodesign_dir"
  fi
  "$rcodesign_dir/$name/rcodesign" sign "$1"
}

rm -rf binaries && mkdir -p binaries/stage
# The packages each binary bundles, from a plain bundle's markers, and the
# Bun runtime it embeds, whose licence file is vendored per Bun version.
bun_version=$(jq -r .version node_modules/bun/package.json)
yarn --silent bun build src/cli/index.ts --target bun --outfile binaries/stage/cli.js >/dev/null
{
  cat <<'NOTICE'
backmesh
Copyright 2026 backmesh

backmesh is licensed under the Apache License, Version 2.0 (LICENSE, next to
this file). The binary embeds the Bun runtime and the packages below, under
their own licences.
NOTICE
  printf '\n%s\n\nBun %s, from https://github.com/oven-sh/bun/blob/bun-v%s/LICENSE.md\n\n' \
    "$(printf -- '-%.0s' {1..78})" "$bun_version" "$bun_version"
  cat "scripts/bun-$bun_version-LICENSE.md"
  node scripts/notice.mjs binaries/stage/cli.js
} >binaries/stage/NOTICE
rm binaries/stage/cli.js
cp LICENSE binaries/stage/
for target in "${targets[@]}"; do
  platform=${target#bun-}
  binary=binaries/stage/backmesh
  yarn --silent bun build --compile --target="$target" "${defines[@]}" \
    src/cli/index.ts --outfile "$binary"
  if [[ $platform == darwin-* ]]; then
    yarn --silent bun scripts/macho-signature.ts fit "$binary"
    ad_hoc_sign "$binary"
    yarn --silent bun scripts/macho-signature.ts verify "$binary"
  fi
  tar -czf "binaries/backmesh-$platform.tar.gz" -C binaries/stage backmesh LICENSE NOTICE
  rm "$binary"
done
rm -r binaries/stage
(cd binaries && sha256sum backmesh-*.tar.gz >checksums.txt)
