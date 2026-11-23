#!/usr/bin/env bash
# az, gcloud, gsutil and aws on first use: the image links each
# name in /usr/local/bin to this script, which installs the real CLI from a
# pinned vendor release on the first call and then runs it. A shim on PATH,
# not bash's command_not_found_handle, so a JavaScript action such as
# azure/login gets it too. The real CLI lives outside /usr/local/bin, so the
# shim never runs itself. Each release is a fixed URL checked against its
# pinned SHA-256 or, for aws, AWS's key in runner/keys: no apt index, whose
# mirrors fail mid-sync or with 5xx, is on the path.
# shellcheck disable=SC2154 # cloud-cli.env, below, assigns the versions
set -Eeuo pipefail

name=${0##*/}
keys=/usr/share/keyrings/backmesh
# The versions and checksums, x86-64 only as the image is: the Dockerfile's
# ARGs, the versions GitHub's Ubuntu 24.04 image has.
# shellcheck source=/dev/null # the image writes it
. /usr/share/backmesh/cloud-cli.env

# Each install is one && chain: it runs left of ||, where errexit
# is off, so a failed step, the checksum or signature check above all, must
# stop it. It downloads into $dir, unpacks beside its destination, and moves
# the real CLI into place last, so one that stops partway leaves no $real and
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

# Microsoft's package, unpacked without dpkg: it has no maintainer scripts,
# and its dependencies are base Ubuntu libraries.
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
    log=$(mktemp) dir=$(mktemp -d)
    status=0
    "${install[@]}" >"$log" 2>&1 && [[ -x $real ]] || status=1
    rm -rf "$dir"
    if ((status)); then
      echo "backmesh: couldn't install the $name CLI; the end of its output:" >&2
      tail -n 20 "$log" >&2
      exit 1
    fi
    rm -f "$log"
  fi
  exec 9>&-
fi
exec "$real" "$@"
