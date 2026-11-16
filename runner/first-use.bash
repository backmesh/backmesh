# backmesh's first-use install. The image's BASH_ENV,
# which bash reads even as the runner's `bash --noprofile --norc` for a `run:`
# step. A command bash can't find, and that a package in Ubuntu's archive
# provides, is installed through apt, which checks the archive's signature,
# then run again. A typo isn't in the index, so it fails as usual.
#
# The index, `<command> <package>` per line, is built at image build from the
# archive's command metadata (the Commands files Ubuntu's command-not-found uses).
backmesh_commands=${backmesh_commands:-/usr/share/backmesh/commands}
backmesh_apt=${backmesh_apt:-apt-get}

command_not_found_handle() {
  local cmd=$1 pkg log
  # A command the handler itself can't find would call it again.
  if [[ -z ${backmesh_installing:-} ]]; then
    local backmesh_installing=1
    pkg=$(awk -v cmd="$cmd" '$1 == cmd { print $2; exit }' "$backmesh_commands" 2>/dev/null) || pkg=
  fi
  if [[ -z ${pkg:-} ]]; then
    printf 'bash: %s: command not found\n' "$cmd" >&2
    return 127
  fi
  printf 'backmesh: installing %s for %s\n' "$pkg" "$cmd" >&2
  log=$(mktemp)
  # The image's apt-get (apt.sh) fetches apt's lists on the first install.
  # The log is the caller's.
  # shellcheck disable=SC2024
  if ! sudo -n env DEBIAN_FRONTEND=noninteractive "$backmesh_apt" -o DPkg::Lock::Timeout=120 install -yq --no-install-recommends "$pkg" >"$log" 2>&1; then
    printf "backmesh: couldn't install %s; apt's output:\n" "$pkg" >&2
    tail -n 20 "$log" >&2
    rm -f "$log"
    return 127
  fi
  rm -f "$log"
  hash -r
  # A package that doesn't put the command on PATH ends here, not in a loop.
  if ! command -v -- "$cmd" >/dev/null; then
    printf "backmesh: %s doesn't provide %s on PATH\n" "$pkg" "$cmd" >&2
    return 127
  fi
  "$@"
}
