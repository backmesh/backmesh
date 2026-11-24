#!/usr/bin/env bash
# The built image's first-use install, for real: a step run as the runner runs
# one, `bash --noprofile --norc -e -o pipefail <file>`, installs hello from
# Ubuntu's archive and runs it, and leaves a typo alone; the cloud CLIs install
# on first use from node; the index's corrections hold. Then the image's gaps
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
# gsutil then runs from gcloud's install.
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
    await run("gsutil", ["version"]);
    console.log("gsutil: ran");
  })().catch((e) => { console.log(`::error::cloud CLI first use: ${e.message}`); process.exit(1); });'

# The tool cache's link, GitHub's variables, apt's shims ahead of the real
# apt-get for sudo, Ubuntu's archive as the only apt source, and a gh with
# `gh attestation`, which Ubuntu's 2.45 lacks.
# shellcheck disable=SC2016 # in the image
docker run --rm --entrypoint bash "$image" -c '
  set -e
  [[ $(readlink /opt/hostedtoolcache) == "$RUNNER_TOOL_CACHE" && $ImageOS == ubuntu24 && $LANG == C.UTF-8 ]]
  locale -a | grep -qx en_US.utf8
  [[ $(sudo -n sh -c "command -v apt-get") == /usr/local/bin/apt-get ]]
  [[ $(ls /etc/apt/sources.list.d) == ubuntu.sources ]]
  gh attestation --help >/dev/null
  echo "environment, apt and gh: passed"' || fail "the image's environment, apt sources or gh"

# The first-use index's corrections (first-use-packages.txt): psql installs
# the client and runs; OpenStack's swift, Ubuntu's snap stubs and Bazel 4.2.3
# aren't indexed, so they fail as a typo does; dotnet installs an SDK.
# shellcheck disable=SC2016 # in the image
docker run --rm -i --entrypoint sh "$image" \
  -c 'cat >/tmp/step.sh && exec bash --noprofile --norc -e -o pipefail /tmp/step.sh' <<'EOF' || fail "the first-use index's corrections"
psql --version
if swift --version; then echo "swift ran"; exit 1; elif (($? != 127)); then echo "swift: not 127"; exit 1; fi
index() { awk -v c="$1" '$1 == c { print $2 }' /usr/share/backmesh/commands; }
[[ $(index dotnet) == dotnet-sdk-* ]] || { echo "dotnet: $(index dotnet)"; exit 1; }
for c in swift chromium-browser chromedriver firefox thunderbird lxc lxd bazel; do
  [[ -z $(index "$c") ]] || { echo "$c: $(index "$c")"; exit 1; }
done
echo 'first-use index: passed'
EOF

"$here/../parity/gaps.sh" "$image"
