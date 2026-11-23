#!/usr/bin/env bash
# az, gcloud, gsutil and aws on first use: the image links each
# name in /usr/local/bin to this script, which installs the real CLI from a
# pinned vendor release on the first call and then runs it. A shim on PATH,
# not bash's command_not_found_handle, so a JavaScript action such as
# azure/login gets it too. The real CLI lives outside /usr/local/bin, so the
# shim never runs itself. Each release is a fixed URL checked against its
# pinned SHA-256 or, for aws, AWS's key in runner/keys: no apt index, whose
# mirrors fail mid-sync or with 5xx, is on the path.
set -Eeuo pipefail

name=${0##*/}
keys=/usr/share/keyrings/backmesh

# Each install is one && chain: it runs as an if's condition, where errexit
# is off, so a failed step, the checksum or signature check above all, must
# stop it. curl as anycloud fetches a VM host's pinned downloads: a stall
# counts as a failure, and every failure is retried.
fetch() {
  curl -fsSL --connect-timeout 5 --speed-limit 65536 --speed-time 15 \
    --retry 5 --retry-delay 1 --retry-all-errors -o "$2" "$1"
}
# A release at $1, checked against SHA-256 $2, into $dir.
pinned() {
  dir=$(mktemp -d) && fetch "$1" "$dir/${1##*/}" \
    && echo "$2  $dir/${1##*/}" | sha256sum --check --strict --quiet
}

# Microsoft's package; its dependencies are base Ubuntu libraries.
az_install() {
  pinned https://packages.microsoft.com/repos/azure-cli/pool/main/a/azure-cli/azure-cli_2.75.0-1~noble_amd64.deb \
    12f3a6f2366c7ec87c85d7c40d8e207ca6b2ab56c22bf968b5a6fe93c9e8ac8a \
    && sudo -n dpkg -i "$dir"/*.deb >/dev/null \
    && rm -rf "$dir"
}

# Google's archive, with its own Python, unpacked where its package puts it.
gcloud_install() {
  pinned https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-594.0.1-linux-x86_64.tar.gz \
    8fc798fd0638428551f80277a568112d08afcf9cafd967d1cf39ae0918df2a1d \
    && sudo -n tar -xzf "$dir"/*.tar.gz -C /usr/lib \
    && rm -rf "$dir"
}

# AWS's v2 installer, checked against AWS's signature with only its pinned key.
aws_install() {
  local url=https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.42.2.zip
  dir=$(mktemp -d) \
    && fetch "$url" "$dir/aws.zip" \
    && fetch "$url.sig" "$dir/aws.zip.sig" \
    && mkdir -m 0700 "$dir/gnupg" \
    && GNUPGHOME=$dir/gnupg gpg --batch --quiet --import "$keys/aws-cli.asc" \
    && GNUPGHOME=$dir/gnupg gpg --batch --verify "$dir/aws.zip.sig" "$dir/aws.zip" \
    && unzip -q "$dir/aws.zip" -d "$dir" \
    && sudo -n "$dir/aws/install" --install-dir /usr/local/aws-cli --bin-dir /usr/local/aws-cli/bin \
    && rm -rf "$dir"
}

case $name in
  az) real=/usr/bin/az install=(az_install) ;;
  gcloud | gsutil) real=/usr/lib/google-cloud-sdk/bin/$name install=(gcloud_install) ;;
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
