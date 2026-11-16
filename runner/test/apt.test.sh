#!/usr/bin/env bash
# Tests for apt.sh, the image's apt-get and apt. Each case calls the shim
# through links named as the image's, from sh, bash or sudo; the real apt-get
# and apt and sudo are stubs. The real update writes a list.
# Run: bash runner/test/apt.test.sh
# Checks are single-quoted for check's eval, which reads status.
# shellcheck disable=SC2016,SC2034
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
failures=0

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"$1" && chmod +x "$1"; }

setup() {
  scratch=$(mktemp -d)
  mkdir -p "$scratch/bin" "$scratch/real" "$scratch/lists"
  for name in apt-get apt; do
    ln -s "$here/../apt.sh" "$scratch/bin/$name"
    # Logs each call; update writes a list, slowly, unless told to fail;
    # installing broken fails as apt does.
    stub "$scratch/real/$name" 'echo "'"$name"' $*" >>"$SCRATCH/calls"
      case "$*" in
        *update*) sleep 0.2; [[ -e $SCRATCH/offline ]] && exit 100; touch "$SCRATCH/lists/archive_noble_main_binary-amd64_Packages.lz4" ;;
        *" broken") echo "E: Unable to locate package broken"; exit 100 ;;
      esac
      echo "'"$name"' ran"'
  done
  stub "$scratch/bin/sudo" 'echo "sudo $*" >>"$SCRATCH/calls"; [[ $1 == -n ]] && shift; exec "$@"'
  touch "$scratch/calls"
  export SCRATCH=$scratch PATH=$scratch/bin:$PATH \
    backmesh_apt_lists=$scratch/lists backmesh_apt_bin=$scratch/real
}

# The command line, from sh, as a step with `shell: sh` or an action runs it.
run() {
  sh -c "$1" >"$scratch/out" 2>&1
  status=$?
}

check() {
  if eval "$2"; then return; fi
  printf 'FAIL %s: %s\n' "$current" "$1"
  sed 's/^/    /' "$scratch/out" "$scratch/calls"
  failures=$((failures + 1))
}

updates() { grep -c '^apt[a-z-]* .*update' "$scratch/calls"; }

case_fetches_the_lists_then_runs_the_command() {
  run 'sudo apt-get install -y sl'
  check 'succeeds' '((status == 0))'
  check 'updates, then installs with the same arguments' '[[ $(grep "^apt-get" "$scratch/calls") == $'\''apt-get -o DPkg::Lock::Timeout=120 update -q\napt-get install -y sl'\'' ]]'
  check 'says so once' '[[ $(grep -c "^backmesh:" "$scratch/out") == 1 ]] && grep -qx "apt-get ran" "$scratch/out"'
}

case_runs_at_once_with_lists() {
  touch "$scratch/lists/archive_noble_main_binary-amd64_Packages"
  run 'apt install -y sl'
  check 'runs apt, not apt-get, with no update' '[[ $(cat "$scratch/calls") == "apt install -y sl" ]]'
  check 'prints nothing of its own' '! grep -q "^backmesh:" "$scratch/out"'
}

case_leaves_an_update_alone() {
  run 'sudo apt-get -q update'
  check 'updates once' '((status == 0)) && [[ $(updates) == 1 ]]'
}

case_keeps_the_exit_status() {
  run 'sudo apt-get install -y broken'
  check "exits with apt's status" '((status == 100))'
  check "prints apt's error" 'grep -q "Unable to locate package broken" "$scratch/out"'
}

case_runs_the_command_when_the_update_fails() {
  touch "$scratch/offline"
  run 'apt-get install -y sl'
  check 'says the update failed, then runs it' 'grep -qx "backmesh: apt-get update failed; running apt-get anyway" "$scratch/out" && grep -qx "apt-get ran" "$scratch/out"'
}

case_updates_through_sudo_when_not_root() {
  run 'apt-get install -y sl'
  check 'updates with sudo -n, then runs the command as called' '[[ $(head -1 "$scratch/calls") == "sudo -n $scratch/real/apt-get -o DPkg::Lock::Timeout=120 update -q" && $(tail -1 "$scratch/calls") == "apt-get install -y sl" ]]'
}

case_updates_once_for_concurrent_calls() {
  bash -c 'apt-get install -y a & apt-get install -y b & apt install -y c & wait' >"$scratch/out" 2>&1
  check 'updates once and runs all three' '[[ $(updates) == 1 && $(grep -c " install " "$scratch/calls") == 3 ]]'
}

for current in $(declare -F | awk '$3 ~ /^case_/ { print $3 }'); do
  setup
  "$current"
  rm -rf "$scratch"
done

if ((failures)); then
  printf '%d check(s) failed\n' "$failures"
  exit 1
fi
echo 'apt: all checks passed'
