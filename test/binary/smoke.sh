#!/bin/bash
# Runs a built linux backmesh binary outside the checkout, with a fake
# anycloud where backmesh keeps the pinned one, so nothing is downloaded.
#
#   test/binary/smoke.sh <backmesh-linux-*.tar.gz> <version> <anycloud version>
set -euo pipefail

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
tar -xzf "$1" -C "$dir" backmesh
mkdir -p "$dir/.backmesh/bin/$3"
printf '#!/bin/sh\necho "$*" >>"%s/calls"\nexit 1\n' "$dir" >"$dir/.backmesh/bin/$3/anycloud"
chmod +x "$dir/.backmesh/bin/$3/anycloud"
cd "$dir"
export HOME=$dir PATH=/usr/bin:/bin

[[ $(./backmesh --version) == "$2" ]] || { echo "--version isn't $2" >&2; exit 1; }
# `upgrade` reads the embedded matrix: it stops at the pinned anycloud's
# missing features while the pin predates them, else at the active API,
# which the fake refuses. Either way it names the embedded pin's state.
if out=$(./backmesh upgrade --json); then
  echo "upgrade succeeded against a fake anycloud" >&2
  exit 1
fi
jq -e --arg pin "$3" '.error.message | startswith("Couldn'"'"'t read which control plane") or startswith("This backmesh'"'"'s control plane (\($pin)) lacks")' <<<"$out" >/dev/null ||
  { echo "upgrade failed early: $out" >&2; exit 1; }
# `status` asks the pinned binary for the active API.
if out=$(./backmesh status --json); then
  echo "status succeeded against a fake anycloud" >&2
  exit 1
fi
jq -e '.error.message | startswith("Couldn'"'"'t read which control plane")' <<<"$out" >/dev/null ||
  { echo "status failed early: $out" >&2; exit 1; }
diff <(printf -- 'api status --json\n') <(sort -u calls)
echo "smoke test passed: $1"
