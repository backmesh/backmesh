#!/usr/bin/env bash
# Tests for first-use.bash. Each case runs a step as the runner runs a `run:`
# step, `bash --noprofile --norc -e -o pipefail <file>`, with the handler as
# BASH_ENV, as the image sets it. apt and sudo are stubs on PATH.
# Run: bash runner/test/first-use.test.sh
# Checks are single-quoted for check's eval, which reads status.
# shellcheck disable=SC2016,SC2034
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
failures=0

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"$stubs/$1" && chmod +x "$stubs/$1"; }

setup() {
  scratch=$(mktemp -d)
  stubs=$scratch/stubs
  mkdir -p "$stubs" "$scratch/bin"
  printf '%s\n' 'hello hello' 'nohello broken' 'lost lost' >"$scratch/commands"
  stub sudo '[[ $1 == -n ]] && shift; exec "$@"'
  # apt-get: logs each call; installing hello puts it on PATH, broken fails,
  # and lost installs nothing.
  stub fake-apt 'echo "apt $*" >>"$SCRATCH/calls"
    pkg=${!#}
    case "$*" in
      *install*) case $pkg in
        hello) printf "#!/bin/sh\necho hi \"\$@\"\n" >"$SCRATCH/bin/hello" && chmod +x "$SCRATCH/bin/hello" ;;
        broken) echo "E: Unable to locate package broken"; exit 100 ;;
      esac ;;
    esac'
  touch "$scratch/calls"
  export SCRATCH=$scratch PATH=$stubs:$scratch/bin:$PATH BASH_ENV=$here/../first-use.bash \
    backmesh_commands=$scratch/commands backmesh_apt=fake-apt
}

# The step's script, from stdin, run as the runner runs it.
step() {
  cat >"$scratch/step.sh"
  bash --noprofile --norc -e -o pipefail "$scratch/step.sh" >"$scratch/out" 2>&1
  status=$?
}

check() {
  if eval "$2"; then return; fi
  printf 'FAIL %s: %s\n' "$current" "$1"
  sed 's/^/    /' "$scratch/out"
  failures=$((failures + 1))
}

installs() { grep -c ' install ' "$scratch/calls"; }

case_installs_and_runs_an_indexed_command() {
  step <<<'hello one; hello two; echo done'
  check 'succeeds' '((status == 0))'
  check 'logs one line' '[[ $(grep -c "^backmesh:" "$scratch/out") == 1 ]] && grep -qx "backmesh: installing hello for hello" "$scratch/out"'
  check 'runs it with its arguments, then again from PATH' 'grep -qx "hi one" "$scratch/out" && grep -qx "hi two" "$scratch/out" && grep -qx done "$scratch/out"'
  check 'installs once' '[[ $(installs) == 1 ]]'
}

case_leaves_a_typo_alone() {
  step <<<'helo; echo unreachable'
  check 'fails the step with 127' '((status == 127))'
  check 'says command not found' 'grep -qx "bash: helo: command not found" "$scratch/out"'
  check 'stops the step' '! grep -q unreachable "$scratch/out"'
  check 'never runs apt' '[[ ! -s $scratch/calls ]]'
}

case_reports_a_failed_install() {
  step <<<'if nohello; then echo ran; else echo "status $?"; fi'
  check 'returns 127 to the step' 'grep -qx "status 127" "$scratch/out"'
  check "says it couldn't install, with apt's output" 'grep -qx "backmesh: couldn'\''t install broken; apt'\''s output:" "$scratch/out" && grep -q "Unable to locate package broken" "$scratch/out"'
  check 'tries once' '[[ $(installs) == 1 ]]'
}

case_stops_when_the_package_has_no_such_command() {
  step <<<'if lost; then echo ran; else echo "status $?"; fi'
  check 'returns 127 to the step' 'grep -qx "status 127" "$scratch/out"'
  check 'says why' 'grep -qx "backmesh: lost doesn'\''t provide lost on PATH" "$scratch/out"'
  check 'tries once, with no loop' '[[ $(installs) == 1 ]]'
}

case_survives_a_missing_index() {
  rm "$scratch/commands"
  step <<<'hello'
  check 'fails as usual' '((status == 127)) && grep -qx "bash: hello: command not found" "$scratch/out"'
  check 'never runs apt' '[[ ! -s $scratch/calls ]]'
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
echo 'first-use: all checks passed'
