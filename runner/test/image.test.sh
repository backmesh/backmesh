#!/usr/bin/env bash
# The built image's first-use install, for real: a step run as the runner runs
# one, `bash --noprofile --norc -e -o pipefail <file>`, installs hello from
# Ubuntu's archive and runs it, and leaves a typo alone; the cloud CLIs install
# on first use from node. Then the image's gaps
# against GitHub's (runner/parity/gaps.sh).
# Run: runner/test/image.test.sh <image>
set -Eeuo pipefail

image=$1
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
status=0
out=$(docker run --rm -i --entrypoint sh "$image" \
  -c 'cat >/tmp/step.sh && exec bash --noprofile --norc -e -o pipefail /tmp/step.sh' 2>&1 <<'EOF'
hello --greeting=first
hello --greeting=second
if helo; then echo "typo ran"; else echo "typo $?"; fi
EOF
) || status=$?
printf '%s\n' "$out"
fail() { echo "::error::first-use install: $1"; exit 1; }
((status == 0)) || fail "the step exited with $status"
[[ $(grep -c '^backmesh:' <<<"$out") == 1 ]] || fail 'expected one backmesh line'
grep -qx 'backmesh: installing hello for hello' <<<"$out" || fail "it didn't log the install"
grep -qx first <<<"$out" || fail "hello didn't run"
grep -qx second <<<"$out" || fail "hello didn't run again"
grep -qx 'typo 127' <<<"$out" || fail "a typo didn't fail with 127"
echo 'first-use install: passed'

# az, gcloud and aws from a caller that isn't bash, as a JavaScript action
# calls them: two concurrent first calls each, which install once and both run.
# shellcheck disable=SC2016 # JavaScript
docker run --rm --entrypoint node "$image" -e '
  const { execFile } = require("node:child_process");
  const run = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, (e, out, err) =>
    e ? no(new Error(`${cmd}: ${e.message}${err}`)) : ok(err)));
  (async () => {
    for (const [cmd, args] of [["az", ["version"]], ["gcloud", ["version"]], ["aws", ["--version"]]]) {
      const err = (await Promise.all([run(cmd, args), run(cmd, args)])).join("");
      const n = err.split("\n").filter((l) => l.startsWith("backmesh: installing")).length;
      if (n !== 1) throw new Error(`${cmd}: ${n} install lines`);
      console.log(`${cmd}: installed once, ran twice`);
    }
  })().catch((e) => { console.log(`::error::cloud CLI first use: ${e.message}`); process.exit(1); });'

# The tool cache's link, GitHub's variables, apt's shims ahead of the real
# apt-get for sudo, and Ubuntu's archive as the only apt source.
# shellcheck disable=SC2016 # in the image
docker run --rm --entrypoint bash "$image" -c '
  set -e
  [[ $(readlink /opt/hostedtoolcache) == "$RUNNER_TOOL_CACHE" && $ImageOS == ubuntu24 && $LANG == C.UTF-8 ]]
  locale -a | grep -qx en_US.utf8
  [[ $(sudo -n sh -c "command -v apt-get") == /usr/local/bin/apt-get ]]
  [[ $(ls /etc/apt/sources.list.d) == ubuntu.sources ]]
  echo "environment and apt: passed"' || fail "the image's environment or apt sources"

"$here/../parity/gaps.sh" "$image"
