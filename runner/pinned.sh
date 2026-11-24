#!/usr/bin/env bash
# The CLIs and toolchains GitHub's image has that install on first use: the
# cloud CLIs, Rust, PowerShell, Go, Java and Chrome. The image links each
# name in /usr/local/bin to this script, which installs the real one from a
# pinned vendor release on the first call and then runs it. A shim on PATH,
# not bash's command_not_found_handle, so a JavaScript action such as
# azure/login, or a `sh` script such as ./gradlew, gets it too. The real one
# lives outside /usr/local/bin, so the shim never runs itself. Each release is
# a fixed URL checked against its pinned SHA-256 or, for aws, AWS's key in
# runner/keys: no apt index, whose mirrors fail mid-sync or with 5xx, is on
# the path, except for Chrome's libraries.
# shellcheck disable=SC2154 # pinned.env, below, assigns the versions
set -Eeuo pipefail

name=${0##*/} args=()
keys=/usr/share/keyrings/backmesh
# The versions and checksums, x86-64 only as the image is: the Dockerfile's
# ARGs, the versions GitHub's Ubuntu 24.04 image has.
# shellcheck source=/dev/null # the image writes it
. /usr/share/backmesh/pinned.env
# Rust's homes: the runner user's, as on GitHub's image, whoever calls.
export CARGO_HOME=${CARGO_HOME:-/home/runner/.cargo} RUSTUP_HOME=${RUSTUP_HOME:-/home/runner/.rustup}

# Each install is one && chain: it runs left of ||, where errexit
# is off, so a failed step, the checksum or signature check above all, must
# stop it. It downloads into $dir, unpacks beside its destination, and moves
# the real one into place last, so one that stops partway leaves no $real and
# the next call installs again. curl as anycloud fetches a VM host's pinned
# downloads: a stall counts as a failure, and every failure is retried.
fetch() {
  curl -fsSL --connect-timeout 5 --speed-limit 65536 --speed-time 15 \
    --retry 5 --retry-delay 1 --retry-all-errors -o "$2" "$1"
}
# The release at $1 into $dir, checked against SHA-256 $2.
pinned() {
  fetch "$1" "$dir/${1##*/}" && echo "$2  $dir/${1##*/}" | sha256sum --check --strict --quiet
}
# The tarball at $1, checked against $2, unpacked into directory $3 with its
# top directory stripped, then renamed into place.
tarball() {
  pinned "$1" "$2" \
    && sudo -n rm -rf "$3.new" "$3" \
    && sudo -n mkdir -p "$3.new" \
    && sudo -n tar -xzf "$dir/${1##*/}" -C "$3.new" --strip-components 1 \
    && sudo -n mv "$3.new" "$3"
}

# Microsoft's package, unpacked without dpkg: it has no maintainer scripts,
# and its dependencies are base Ubuntu libraries. So dpkg keeps no record of
# azure-cli (dpkg -l doesn't list it), and its bash completion isn't installed.
az_install() {
  pinned "https://packages.microsoft.com/repos/azure-cli/pool/main/a/azure-cli/azure-cli_${az_version}-1~noble_amd64.deb" "$az_sha256" \
    && sudo -n rm -rf /opt/az.new /opt/az \
    && sudo -n dpkg-deb -x "$dir"/*.deb /opt/az.new \
    && sudo -n mv /opt/az.new/opt/az /opt/az \
    && sudo -n mv /opt/az.new/usr/bin/az /usr/bin/az \
    && sudo -n rm -rf /opt/az.new
}

# Google's archive, with its own Python, where its package puts it.
gcloud_install() {
  pinned "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${gcloud_version}-linux-x86_64.tar.gz" "$gcloud_sha256" \
    && sudo -n rm -rf /usr/lib/google-cloud-sdk.new /usr/lib/google-cloud-sdk \
    && sudo -n mkdir /usr/lib/google-cloud-sdk.new \
    && sudo -n tar -xzf "$dir"/*.tar.gz -C /usr/lib/google-cloud-sdk.new \
    && sudo -n mv /usr/lib/google-cloud-sdk.new/google-cloud-sdk /usr/lib/google-cloud-sdk \
    && sudo -n rmdir /usr/lib/google-cloud-sdk.new
}

# AWS's v2 installer, checked against AWS's signature with only its pinned key.
aws_install() {
  local url=https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${aws_version}.zip
  fetch "$url" "$dir/aws.zip" \
    && fetch "$url.sig" "$dir/aws.zip.sig" \
    && mkdir -m 0700 "$dir/gnupg" \
    && GNUPGHOME=$dir/gnupg gpg --batch --quiet --import "$keys/aws-cli.asc" \
    && GNUPGHOME=$dir/gnupg gpg --batch --verify "$dir/aws.zip.sig" "$dir/aws.zip" \
    && unzip -q "$dir/aws.zip" -d "$dir" \
    && sudo -n "$dir/aws/install" --update --install-dir /usr/local/aws-cli --bin-dir /usr/local/aws-cli/bin
}

# rustup and the pinned stable toolchain with clippy and rustfmt, as GitHub's
# image has them, owned by the runner user. rustup checks the toolchain
# against its release's manifest, under stable's name, so `rustup toolchain
# install stable` (dtolnay/rust-toolchain@stable) finds it unchanged while
# stable is that release, and updates it once stable moves on, as on GitHub's
# image. It installs into a stage of the runner's, then into the homes, which
# a cache restore may have made already, with the proxies last.
rust_install() {
  local stage=/home/runner/.rust.new t=x86_64-unknown-linux-gnu
  pinned "https://static.rust-lang.org/rustup/archive/${rustup_version}/x86_64-unknown-linux-gnu/rustup-init" "$rustup_sha256" \
    && sudo -n rm -rf "$stage" \
    && sudo -n install -d -o runner -g runner "$stage" "$RUSTUP_HOME" "$CARGO_HOME" "$CARGO_HOME/bin" \
    && sudo -n install -o runner -m 0755 "$dir/rustup-init" "$stage/" \
    && sudo -n -u runner env CARGO_HOME="$stage/cargo" RUSTUP_HOME="$stage/rustup" "$stage/rustup-init" -y --no-modify-path \
      --profile minimal --default-toolchain "$rust_version" --component clippy,rustfmt \
    && sudo -n -u runner mv "$stage/rustup/toolchains/$rust_version-$t" "$stage/rustup/toolchains/stable-$t" \
    && sudo -n -u runner mv "$stage/rustup/update-hashes/$rust_version-$t" "$stage/rustup/update-hashes/stable-$t" \
    && sudo -n -u runner env CARGO_HOME="$stage/cargo" RUSTUP_HOME="$stage/rustup" "$stage/cargo/bin/rustup" default stable \
    && sudo -n -u runner cp -a "$stage/rustup/." "$RUSTUP_HOME/" \
    && sed "s#$stage/cargo#$CARGO_HOME#g" "$stage/cargo/env" | sudo -n -u runner tee "$CARGO_HOME/env" >/dev/null \
    && sudo -n -u runner mv "$stage"/cargo/bin/* "$CARGO_HOME/bin/" \
    && sudo -n rm -rf "$stage"
}

# PowerShell's release, where Microsoft's package puts it.
pwsh_install() {
  local url=https://github.com/PowerShell/PowerShell/releases/download/v${pwsh_version}/powershell-${pwsh_version}-linux-x64.tar.gz
  pinned "$url" "$pwsh_sha256" \
    && sudo -n rm -rf /opt/microsoft/powershell/7.new /opt/microsoft/powershell/7 \
    && sudo -n mkdir -p /opt/microsoft/powershell/7.new \
    && sudo -n tar -xzf "$dir/${url##*/}" -C /opt/microsoft/powershell/7.new \
    && sudo -n chmod 0755 /opt/microsoft/powershell/7.new/pwsh \
    && sudo -n mv /opt/microsoft/powershell/7.new /opt/microsoft/powershell/7
}

go_install() {
  tarball "https://go.dev/dl/go${go_version}.linux-amd64.tar.gz" "$go_sha256" /usr/local/go
}

# Temurin's JDK, where GitHub's image has its default one: JAVA_HOME, whose
# bin has the image's shims for java, javac, jar and keytool until it's in.
java_install() {
  local tag=jdk-${java_version} file=OpenJDK17U-jdk_x64_linux_hotspot_${java_version/+/_}.tar.gz
  tarball "https://github.com/adoptium/temurin17-binaries/releases/download/${tag/+/%2B}/$file" "$java_sha256" \
    /usr/lib/jvm/temurin-17-jdk-amd64
}

# Chrome for Testing, Google's versioned build of Chrome: its URLs are fixed,
# unlike the .deb's, which Google drops from its pool at the next release.
# Chrome's libraries come from Ubuntu's archive, through apt, as the .deb's
# would: a package of only its deb.deps as Depends, so apt picks Ubuntu's
# names for them.
chrome_install() {
  local url=https://storage.googleapis.com/chrome-for-testing-public/${chrome_version}/linux64/chrome-linux64.zip
  pinned "$url" "$chrome_sha256" \
    && unzip -q "$dir/chrome-linux64.zip" -d "$dir" \
    && test -s "$dir/chrome-linux64/deb.deps" \
    && mkdir -p "$dir/deps/DEBIAN" \
    && printf 'Package: backmesh-chrome-deps\nVersion: %s\nArchitecture: amd64\nMaintainer: backmesh\nDescription: Chrome for Testing'"'"'s libraries\nDepends: %s\n' \
      "$chrome_version" "$(paste -sd , "$dir/chrome-linux64/deb.deps" | sed 's/,/, /g')" >"$dir/deps/DEBIAN/control" \
    && dpkg-deb --build "$dir/deps" "$dir/chrome-deps.deb" \
    && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -yq --no-install-recommends "$dir/chrome-deps.deb" \
    && sudo -n rm -rf /opt/google/chrome-for-testing \
    && sudo -n chown -R root:root "$dir/chrome-linux64" \
    && sudo -n mv "$dir/chrome-linux64" /opt/google/chrome-for-testing
}

# Chrome for Testing's driver for the same version, where GitHub's image has it
# (CHROMEWEBDRIVER), in place of the image's shim there. Chrome first, whose
# libraries it needs too.
chromedriver_install() {
  { [[ -x /opt/google/chrome-for-testing/chrome ]] || chrome_install; } \
    && pinned "https://storage.googleapis.com/chrome-for-testing-public/${chrome_version}/linux64/chromedriver-linux64.zip" "$chromedriver_sha256" \
    && unzip -q "$dir/chromedriver-linux64.zip" -d "$dir" \
    && sudo -n rm -rf /usr/local/share/chromedriver-linux64 \
    && sudo -n mv "$dir/chromedriver-linux64" /usr/local/share/chromedriver-linux64
}

# $real runs the command once $ready, by default $real, exists.
case $name in
  az) real=/usr/bin/az install=(az_install) ;;
  gcloud | gsutil) real=/usr/lib/google-cloud-sdk/bin/$name install=(gcloud_install) ;;
  aws) real=/usr/local/aws-cli/v2/current/bin/aws install=(aws_install) ;;
  # rustup's proxies, once the toolchain is in: a cache may restore
  # $CARGO_HOME/bin without $RUSTUP_HOME.
  rustup | cargo | rustc | rustdoc | rustfmt | cargo-fmt | cargo-clippy | clippy-driver)
    real=$CARGO_HOME/bin/$name ready=$RUSTUP_HOME/toolchains/stable-x86_64-unknown-linux-gnu/bin/rustc
    install=(rust_install) ;;
  pwsh) real=/opt/microsoft/powershell/7/pwsh install=(pwsh_install) ;;
  go | gofmt) real=/usr/local/go/bin/$name install=(go_install) ;;
  java | javac | jar | keytool)
    real=/usr/lib/jvm/temurin-17-jdk-amd64/bin/$name ready=/usr/lib/jvm/temurin-17-jdk-amd64/release
    install=(java_install) ;;
  # The job's container can't make the namespaces Chrome's sandbox needs, so
  # Chrome runs without it, whether called by name, as /usr/bin/google-chrome,
  # or as /opt/google/chrome/chrome, where Playwright's and Puppeteer's
  # `channel: 'chrome'` and ChromeDriver look.
  google-chrome | google-chrome-stable | chrome)
    real=/opt/google/chrome-for-testing/chrome install=(chrome_install) args=(--no-sandbox) ;;
  chromedriver)
    real=/usr/local/share/chromedriver-linux64/chromedriver ready=/usr/local/share/chromedriver-linux64/LICENSE.chromedriver
    install=(chromedriver_install) ;;
  *) echo "backmesh: no first-use install for $name" >&2; exit 127 ;;
esac

installed() { [[ -x $real && -e ${ready:-$real} ]]; }
if ! installed; then
  # Concurrent first calls install once: the rest wait, then find it. The lock
  # is this script, which every user can open, whoever called first.
  exec 9<"${BASH_SOURCE[0]}"
  flock 9
  if ! installed; then
    echo "backmesh: installing $name on first use" >&2
    log=$(mktemp) dir=$(mktemp -d)
    status=0
    "${install[@]}" >"$log" 2>&1 && installed || status=1
    rm -rf "$dir"
    if ((status)); then
      echo "backmesh: couldn't install $name; the end of its output:" >&2
      tail -n 20 "$log" >&2
      exit 1
    fi
    rm -f "$log"
  fi
  exec 9>&-
fi
exec "$real" "${args[@]}" "$@"
