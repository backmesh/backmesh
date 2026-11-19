#!/usr/bin/env bash
# e2e.yml's Worker check: fails unless the Worker at BACKMESH_API_URL
# (staging for an rc, production for a release) runs the one release.yml
# built from VERSION's commit.
#
#   VERSION=v0.5.0-rc.1 BACKMESH_API_URL=https://api-staging.backmesh.com \
#     test/e2e/worker-commit.sh
set -euo pipefail
want=$(gh api "repos/$GITHUB_REPOSITORY/commits/$VERSION" --jq .sha)
host=${BACKMESH_API_URL#https://}
got=$(curl -fsS --max-time 30 "$BACKMESH_API_URL/v1/version" | jq -r .commit) || got=
[[ $got == "$want" ]] \
  || { echo "::error::$host runs the Worker built from ${got:-an unknown commit}, not $VERSION's $want"; exit 1; }
echo "$host runs $VERSION's Worker, $want."
