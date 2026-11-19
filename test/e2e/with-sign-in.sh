#!/usr/bin/env bash
# e2e.yml's `test-org` install and uninstall: runs the command, and puts each
# GitHub device sign-in it prints in an annotation and the job summary, for a
# maintainer who is an admin of the test org to approve. GitHub's API can't
# read those while the job runs, so it also comments the code on issue
# SIGN_IN_ISSUE with ISSUE_TOKEN: the leg, the code, its expiry and the run,
# nothing else from the log. A code expires after 15 minutes, and the command
# then fails on its own. The App is already on the test org, so a prompt to
# install it fails at once.
#
#   test/e2e/with-sign-in.sh backmesh install --org backmesh-dryrun ...
set -uo pipefail
log=$(mktemp)
env -u ISSUE_TOKEN "$@" >"$log" 2>&1 &
pid=$!
tail -f --pid="$pid" "$log" &
shown=0
what="$1 ${2:-}"
run=$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID
comment() {
  local code
  code=$(sed -nE 's|.*github\.com/login/device and enter ([A-Z0-9]{4}-[A-Z0-9]{4})( \(it expires at [0-9:]+ UTC\))?\.?$|\1|p' <<<"$1")
  [[ -n $code && -n ${SIGN_IN_ISSUE:-} ]] || { echo "::warning::No sign-in code commented on the issue"; return; }
  # Up to 5 s after GitHub issued it, so a minute early.
  GH_TOKEN=${ISSUE_TOKEN:-} gh issue comment "$SIGN_IN_ISSUE" --repo "$GITHUB_REPOSITORY" --body-file - \
    <<<"**$CLOUD** leg, \`$what\`: enter \`$code\` at https://github.com/login/device before $(date -u -d +14min +%H:%M) UTC. Run: $run" \
    || echo "::warning::Couldn't comment the sign-in code on issue $SIGN_IN_ISSUE"
}
while kill -0 "$pid" 2>/dev/null; do
  sleep 5
  mapfile -t codes < <(grep 'login/device' "$log")
  for line in "${codes[@]:shown}"; do
    echo "::notice title=GitHub sign-in for $ORG::$line"
    echo "**GitHub sign-in for $ORG ($what):** $line" >>"$GITHUB_STEP_SUMMARY"
    comment "$line"
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
