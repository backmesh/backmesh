#!/usr/bin/env bash
# e2e.yml's `test-org` install and uninstall: runs the command, and puts each
# GitHub device sign-in it prints in an annotation and the job summary, for a
# maintainer who is an admin of the test org to approve. A code expires
# after 15 minutes, and the command then fails on its own. The App is
# already on the test org, so a prompt to install it fails at once.
#
#   test/e2e/with-sign-in.sh backmesh install --org backmesh-dryrun ...
set -uo pipefail
log=$(mktemp)
"$@" >"$log" 2>&1 &
pid=$!
tail -f --pid="$pid" "$log" &
shown=0
while kill -0 "$pid" 2>/dev/null; do
  sleep 5
  mapfile -t codes < <(grep 'login/device' "$log")
  for line in "${codes[@]:shown}"; do
    echo "::notice title=GitHub sign-in for $ORG::$line"
    echo "**GitHub sign-in for $ORG ($1 ${2:-}):** $line" >>"$GITHUB_STEP_SUMMARY"
  done
  shown=${#codes[@]}
  if grep -q 'installs the backmesh GitHub App' "$log"; then
    kill "$pid" 2>/dev/null
    wait
    echo "::error::install asked for the backmesh App on $ORG, which the test org keeps installed; an org owner installs it, then dispatch again"
    exit 1
  fi
done
wait "$pid" && code=0 || code=$?
wait
exit "$code"
