#!/usr/bin/env bash
# apt-get and apt: the image ships without apt's
# package lists, so a step's `sudo apt-get install`, which works on GitHub's
# image, would fail here without an `apt-get update` first. The image links
# both names in /usr/local/bin,
# first on PATH and sudo's secure_path, to this script, which fetches the
# lists once, when there are none, then execs the real command with the
# caller's arguments, so its exit status is the command's. Any caller gets it:
# bash, sh, sudo or a JavaScript action.
set -uo pipefail

name=${0##*/}
# The tests point these into a scratch directory.
lists=${backmesh_apt_lists:-/var/lib/apt/lists}
real=${backmesh_apt_bin:-/usr/bin}/$name

has_lists() { compgen -G "$lists/*_Packages*" >/dev/null; }

if [[ " $* " != *' update '* ]] && ! has_lists; then
  # Concurrent first calls fetch once: the rest wait, then find the lists. The
  # lock is this script, which every user can open, whoever called first.
  exec 9<"${BASH_SOURCE[0]}"
  flock 9
  if ! has_lists; then
    sudo=()
    ((EUID == 0)) || sudo=(sudo -n)
    echo "backmesh: fetching apt's package lists" >&2
    "${sudo[@]}" "$real" -o DPkg::Lock::Timeout=120 update -q >&2 \
      || echo "backmesh: apt-get update failed; running $name anyway" >&2
  fi
  exec 9>&-
fi
exec "$real" "$@"
