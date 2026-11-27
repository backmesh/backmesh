#!/usr/bin/env bash
# The built image's first-use install, for real: a step run as the runner runs
# one, `bash --noprofile --norc -e -o pipefail <file>`, installs hello from
# Ubuntu's archive and runs it, and leaves a typo alone; the cloud CLIs,
# PowerShell, Go, Java and Chrome install on first use from node; Rust and the
# build tools run from sh; the index's corrections hold. Then the image's gaps
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

# PowerShell, Go, Java and Chrome on first use, the same way, each at
# its pinned version, and the commands that come with each install. Chrome
# renders a page headless.
# shellcheck disable=SC2016 # JavaScript
docker run --rm --entrypoint node "$image" -e '
  const { execFile } = require("node:child_process");
  const { readFileSync } = require("node:fs");
  const pins = Object.fromEntries(readFileSync("/usr/share/backmesh/pinned.env", "utf8")
    .trim().split("\n").map((l) => l.split("=")));
  const run = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, (e, out, err) =>
    e ? no(new Error(`${cmd}: ${e.message}${err}`)) : ok([out, err])));
  const tools = [
    ["pwsh", ["-c", "$PSVersionTable.PSVersion.ToString()"], pins.pwsh_version, []],
    ["go", ["version"], `go${pins.go_version} `, [["gofmt", ["-l", "/usr/local/go/src/errors"]]]],
    ["java", ["-version"], `"${pins.java_version.replace(/\+.*/, "")}"`, [["javac", ["-version"]], ["jar", ["--version"]], ["keytool", ["-help"]]]],
    ["google-chrome", ["--version"], pins.chrome_version, [["chromedriver", ["--version"]], ["google-chrome", ["--headless", "--dump-dom", "data:text/html,<p>backmesh</p>"]]]],
  ];
  (async () => {
    for (const [cmd, args, version, more] of tools) {
      const outs = await Promise.all([run(cmd, args), run(cmd, args)]);
      const n = outs.map(([, err]) => err).join("").split("\n").filter((l) => l.startsWith("backmesh: installing")).length;
      if (n !== 1) throw new Error(`${cmd}: ${n} install lines`);
      if (!outs[0].join("").includes(version)) throw new Error(`${cmd}: not ${version}: ${outs[0].join("")}`);
      for (const [c, a] of more) await run(c, a);
      console.log(`${cmd}: ${version.trim()} installed once, ran twice; ${more.map(([c]) => c).join(", ") || "nothing else"} ran`);
    }
  })().catch((e) => { console.log(`::error::pinned first use: ${e.message}`); process.exit(1); });'

# After the first use: ./mvnw, a sh script, finds Temurin through JAVA_HOME.
# ChromeDriver, from CHROMEWEBDRIVER, installs Chrome with it and runs a
# headless session in the Chrome it finds itself.
docker run --rm -i --entrypoint sh "$image" \
  -c 'cat >/tmp/step.sh && exec bash --noprofile --norc -e -o pipefail /tmp/step.sh' <<'EOF' || fail "./mvnw or a WebDriver session"
mkdir -p /tmp/mvnw/.mvn/wrapper && cd /tmp/mvnw
curl -fsSL -o mvnw https://raw.githubusercontent.com/apache/maven-wrapper/maven-wrapper-3.3.2/maven-wrapper-distribution/src/resources/only-mvnw
echo 'd552912fe186f0aeefae6a7d14c6c6639a1c3f9de96469a5ce0d18109ec21fde  mvnw' | sha256sum --check --strict --quiet
chmod +x mvnw
printf '%s\n' distributionType=only-script \
  distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.11/apache-maven-3.9.11-bin.zip \
  >.mvn/wrapper/maven-wrapper.properties
[[ $(./mvnw --version 2>/dev/null) == *"runtime: $JAVA_HOME"* ]]
"$CHROMEWEBDRIVER/chromedriver" --version >/dev/null 2>&1
"$CHROMEWEBDRIVER/chromedriver" --port=9515 >/dev/null 2>&1 &
for _ in $(seq 50); do curl -sf localhost:9515/status >/dev/null && break; sleep 0.2; done
wd() { curl -sf --max-time 120 "localhost:9515/session$1" "${@:2}"; }
id=$(wd '' -d '{"capabilities":{"alwaysMatch":{"goog:chromeOptions":{"args":["--headless"]}}}}' | jq -r .value.sessionId)
wd "/$id/url" -d '{"url":"data:text/html,<title>backmesh</title>"}' >/dev/null
[[ $(wd "/$id/title" | jq -r .value) == backmesh ]]
wd "/$id" -X DELETE >/dev/null
/usr/bin/google-chrome --version >/dev/null
echo 'after first use: passed'
EOF

# Rust, preinstalled, from a step with HOME moved as the runner moves it:
# rustup, cargo, rustc, rustdoc, clippy and rustfmt at RUST_VERSION, with no
# first-use line, as stable, so dtolnay/rust-toolchain@stable's install finds
# it unchanged; ~/.cargo is CARGO_HOME, so a cache of ~/.cargo/registry is
# cargo's, and so is Swatinem/rust-cache's os.homedir()/.cargo; and a crate
# builds, lints and formats.
rust_version=$(sed -n 's/^ARG RUST_VERSION=//p' "$here/../Dockerfile")
docker run --rm -i -e rust_version="$rust_version" --entrypoint sh "$image" \
  -c 'cat >/tmp/step.sh && exec bash --noprofile --norc -e -o pipefail /tmp/step.sh' <<'EOF' || fail "preinstalled Rust"
sudo -n install -d -o runner -g runner /workspace
. /usr/local/bin/runner-job
share_paths
[[ $HOME == /workspace/home && $(readlink -f ~/.cargo) == "$CARGO_HOME" && $(readlink -f ~/.rustup) == "$RUSTUP_HOME" ]]
[[ $(readlink -f "$(node -p 'require("node:os").homedir()')/.cargo") == "$CARGO_HOME" ]]
t=stable-$(uname -m)-unknown-linux-gnu
out=$({ rustup --version; cargo --version; rustc --version; rustdoc --version; cargo clippy --version; cargo fmt --version; } 2>&1)
[[ $out != *backmesh:* && $out == *"cargo $rust_version "*"rustc $rust_version "* ]] || { echo "$out"; exit 1; }
[[ $(rustup default) == "$t (default)" ]]
# This fails once stable moves past RUST_VERSION: the signal to bump it.
[[ $(rustup toolchain install stable --profile minimal --no-self-update 2>&1) == *"$t unchanged"* ]]
cd "$(mktemp -d)" && cargo new -q --vcs none hello && cd hello
cargo build -q && cargo clippy -q -- -D warnings && cargo fmt --check
[[ $(./target/debug/hello) == "Hello, world!" ]]
echo 'preinstalled Rust: passed'
EOF

# The preinstalled build tools, from a caller that isn't bash, at GitHub's
# image's versions: mvn finds java's first-use install, and bazel, which is
# Bazelisk, runs the Bazel it's asked for.
# shellcheck disable=SC2016 # in the image
docker run --rm --entrypoint sh "$image" -c '
  set -e
  cmake --version | grep -qx "cmake version 3.31.6"
  ctest --version >/dev/null && cpack --version >/dev/null
  [ "$(ninja --version)" = 1.13.2 ]
  mvn --version 2>/dev/null | grep -q "^Apache Maven 3.10.2 "
  kind version | grep -q "^kind v0.33.0 "
  [ "$(kustomize version)" = v5.8.3 ]
  [ "$(USE_BAZEL_VERSION=9.3.3 bazel --version)" = "bazel 9.3.3" ]
  echo "build tools: passed"' || fail "the preinstalled build tools"

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
# the client and runs; OpenStack's swift, Ubuntu's snap stubs, Bazel 4.2.3 and
# Gradle 4.4.1 aren't indexed, so they fail as a typo does; dotnet installs an
# SDK.
# shellcheck disable=SC2016 # in the image
docker run --rm -i --entrypoint sh "$image" \
  -c 'cat >/tmp/step.sh && exec bash --noprofile --norc -e -o pipefail /tmp/step.sh' <<'EOF' || fail "the first-use index's corrections"
psql --version
if swift --version; then echo "swift ran"; exit 1; elif (($? != 127)); then echo "swift: not 127"; exit 1; fi
index() { awk -v c="$1" '$1 == c { print $2 }' /usr/share/backmesh/commands; }
[[ $(index dotnet) == dotnet-sdk-* ]] || { echo "dotnet: $(index dotnet)"; exit 1; }
for c in swift chromium-browser chromedriver firefox thunderbird lxc lxd bazel gradle; do
  [[ -z $(index "$c") ]] || { echo "$c: $(index "$c")"; exit 1; }
done
echo 'first-use index: passed'
EOF

"$here/../parity/gaps.sh" "$image"
