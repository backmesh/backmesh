#!/usr/bin/env bash
# az, gcloud and aws on first use: the image links each
# name in /usr/local/bin to this script, which installs the real CLI from its
# vendor's signed packages on the first call and then runs it. A shim on PATH,
# not bash's command_not_found_handle, so a JavaScript action such as
# azure/login gets it too. The real CLI lives outside /usr/local/bin, so the
# shim never runs itself. The vendors' keys are pinned in runner/keys.
set -Eeuo pipefail

name=${0##*/}
keys=/usr/share/keyrings/backmesh

# Each install is one && chain: it runs as an if's condition, where errexit
# is off, so a failed step, the signature check above all, must stop it.
# An apt repository's source, then its package from it and Ubuntu's archive.
apt_install() {
  echo "deb [arch=amd64 signed-by=$keys/$1.asc] $2" | sudo -n tee "/etc/apt/sources.list.d/backmesh-$1.list" >/dev/null \
    && sudo -n apt-get -o DPkg::Lock::Timeout=120 update -q \
    && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -yq --no-install-recommends "$3"
}

# AWS's v2 installer, checked against AWS's signature with only its pinned key.
aws_install() {
  local dir url=https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
  dir=$(mktemp -d) \
    && curl -fsSL --retry 5 -o "$dir/aws.zip" "$url" \
    && curl -fsSL --retry 5 -o "$dir/aws.zip.sig" "$url.sig" \
    && mkdir -m 0700 "$dir/gnupg" \
    && GNUPGHOME=$dir/gnupg gpg --batch --quiet --import "$keys/aws-cli.asc" \
    && GNUPGHOME=$dir/gnupg gpg --batch --verify "$dir/aws.zip.sig" "$dir/aws.zip" \
    && unzip -q "$dir/aws.zip" -d "$dir" \
    && sudo -n "$dir/aws/install" --install-dir /usr/local/aws-cli --bin-dir /usr/local/aws-cli/bin \
    && rm -rf "$dir"
}

case $name in
  az) real=/usr/bin/az install=(apt_install microsoft 'https://packages.microsoft.com/repos/azure-cli/ noble main' azure-cli) ;;
  gcloud) real=/usr/lib/google-cloud-sdk/bin/gcloud install=(apt_install google-cloud 'https://packages.cloud.google.com/apt cloud-sdk main' google-cloud-cli) ;;
  aws) real=/usr/local/aws-cli/v2/current/bin/aws install=(aws_install) ;;
  *) echo "backmesh: no first-use install for $name" >&2; exit 127 ;;
esac

if [[ ! -x $real ]]; then
  # Concurrent first calls install once: the rest wait, then find it. The lock
  # is this script, which every user can open, whoever called first.
  exec 9<"${BASH_SOURCE[0]}"
  flock 9
  if [[ ! -x $real ]]; then
    echo "backmesh: installing the $name CLI on first use" >&2
    log=$(mktemp)
    if ! "${install[@]}" >"$log" 2>&1 || [[ ! -x $real ]]; then
      echo "backmesh: couldn't install the $name CLI; the end of its output:" >&2
      tail -n 20 "$log" >&2
      exit 1
    fi
    rm -f "$log"
  fi
  exec 9>&-
fi
exec "$real" "$@"
