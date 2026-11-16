#!/usr/bin/env bash
# Tests for docker.sh, the image's `docker`. Each case sources it into a
# subshell, points the real CLI at a stub that records its calls and answers
# as the VM's Docker would, and points /proc's files into a scratch directory.
# Run: bash runner/test/docker.test.sh
# Checks are single-quoted for check's eval.
# shellcheck source-path=SCRIPTDIR disable=SC2016,SC2034
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script=$here/../docker.sh
failures=0

# The runner's container, starting with a digit, so a -t value can look like
# its prefix; two of the job's; and one named like a prefix of the runner's.
runner=1ab2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00
job1=aaaa000000000000000000000000000000000000000000000000000000000001
job2=bbbb000000000000000000000000000000000000000000000000000000000002
job3=cccc000000000000000000000000000000000000000000000000000000000003

setup() {
  scratch=$(mktemp -d)
  # The runner's mounts, as Docker makes them, with a data root of its own.
  printf '%s\n' \
    "575 528 259:1 /docker/containers/$runner/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/nvme1n1 rw" \
    "577 528 259:1 /docker/containers/$runner/hostname /etc/hostname rw,relatime - ext4 /dev/nvme1n1 rw" \
    "600 528 259:1 /workspace /workspace rw,relatime - ext4 /dev/root rw" >"$scratch/mountinfo"
  echo '0::/' >"$scratch/cgroup"
  # Newest first, as Docker lists them: job3 exited, the runner is the oldest.
  printf '%s\n' "$job1" "$job2" "$runner" >"$scratch/running"
  printf '%s\n' "$job3" "$job1" "$job2" "$runner" >"$scratch/all"
  # The real CLI: records its arguments, one call a line, each argument
  # followed by a |. `ps -q --no-trunc` lists running or (with -a or -n) all
  # containers, -n taking the newest; `inspect` resolves as Docker does: an
  # ID, then a name, then a unique prefix. Anything else exits $STATUS.
  cat >"$scratch/real" <<'EOF'
#!/usr/bin/env bash
printf '%s|' "$@" >>"$SCRATCH/calls"; echo >>"$SCRATCH/calls"
while [[ ${1:-} == -* ]]; do shift 2; done
args=" $* "
if [[ $1 == inspect ]]; then
  arg=${*: -1}
  case $arg in
    runner-job | /runner-job) id=$SELF ;;
    1ab) id=$JOB3 ;; # job3 is named 1ab
    *) id=$(grep -h "^$arg" "$SCRATCH/all" | head -n2) ;;
  esac
  [[ -n $id && $id != *$'\n'* ]] || { echo "Error: No such container: $arg" >&2; exit 1; }
  if [[ $args == *'{{.Name}}'* ]]; then
    case $id in "$SELF") echo /runner-job ;; "$JOB3") echo /1ab ;; *) echo "/job-${id:0:4}" ;; esac
  else echo "$id"; fi
  exit 0
fi
if [[ $args == *' -q --no-trunc '* ]]; then
  if [[ -e $SCRATCH/ps-fails ]]; then exit 1; fi
  list=running
  [[ $args =~ \ (-a|--all|--all=true|-n)\  ]] && list=all
  n=$(sed -n 's/.* -n \([0-9]*\) .*/\1/p' <<<"$args")
  head -n "${n:-100}" "$SCRATCH/$list"
  exit 0
fi
exit "${STATUS:-0}"
EOF
  chmod +x "$scratch/real"
  : >"$scratch/calls"
  export SCRATCH=$scratch SELF=$runner JOB3=$job3
  unset STATUS
}

# Runs docker.sh's main with $@; sets $status and $err, and $last, the
# last call to the real CLI.
run() {
  (
    # shellcheck source=../docker.sh
    source "$script"
    real=$scratch/real mountinfo=$scratch/mountinfo cgroup=$scratch/cgroup
    main "$@"
  ) >"$scratch/out" 2>"$scratch/err"
  status=$?
  err=$(cat "$scratch/err")
  last=$(tail -n1 "$scratch/calls")
  : >"$scratch/calls"
}

# The call the real CLI got, from the given arguments.
call() { printf '%s|' "$@"; }

check() {
  if eval "$2"; then return; fi
  printf 'FAIL %s: %s\n' "$current" "$1"
  printf '    last call: %s\n    stderr: %s\n' "$last" "$err"
  failures=$((failures + 1))
}

passes() { want=$(call "$@") && check "passes \`$*\` through" '[[ $last == "$want" && -z $err ]]'; }
lists() { want=$(call "${@:2}") && check "$1" '[[ $last == "$want" && -z $err ]]'; }
skips() { want=$(call "${@:2}") && check "$1" '[[ $last == "$want" && $err == "backmesh: skipped the runner'\''s own container" ]]'; }

case_passes_other_commands_through() {
  for args in 'version' 'run --rm -it -v /tmp:/tmp busybox sh' 'images -q' "logs $runner" "exec -it $runner sh" \
    'compose down' 'system prune -f' 'container prune -f' 'buildx build .' "-H unix:///x info" "inspect $runner"; do
    # shellcheck disable=SC2086 # one argument a word
    run $args
    # shellcheck disable=SC2086
    passes $args
  done
  STATUS=3 run version
  check 'keeps the exit status' '((status == 3))'
}

case_ps_leaves_the_runner_out() {
  run ps
  lists '`ps`' ps -a --filter "id=$job1" --filter "id=$job2"
  run ps -q
  lists '`ps -q`' ps -a --filter "id=$job1" --filter "id=$job2" -q
  run ps -a
  lists '`ps -a`' ps -a --filter "id=$job3" --filter "id=$job1" --filter "id=$job2"
  for flags in -aq -qa '-a -q' '--all --quiet' '--all=true -q'; do
    # shellcheck disable=SC2086
    run ps $flags
    check "\`ps $flags\` lists every state but the runner, quietly" \
      '[[ $last == "$(call ps -a --filter "id=$job3" --filter "id=$job1" --filter "id=$job2")"* && ($last == *-q\| || $last == *--quiet\|) ]]'
  done
  run ps --format '{{.ID}} {{.Names}}' --no-trunc -s
  lists 'keeps the display options' ps -a --filter "id=$job1" --filter "id=$job2" --format '{{.ID}} {{.Names}}' --no-trunc -s
  run ps --format=json
  lists 'and --format=…' ps -a --filter "id=$job1" --filter "id=$job2" --format=json
  run container ls -q
  lists '`container ls`' container ls -a --filter "id=$job1" --filter "id=$job2" -q
  run container list
  lists '`container list`' container list -a --filter "id=$job1" --filter "id=$job2"
  run container ps -aq
  lists '`container ps -aq`' container ps -a --filter "id=$job3" --filter "id=$job1" --filter "id=$job2" -q
  run -H unix:///var/run/docker.sock --context default ps -q
  lists 'keeps the global options' -H unix:///var/run/docker.sock --context default ps -a --filter "id=$job1" --filter "id=$job2" -q
}

case_ps_applies_the_callers_selection_first() {
  # The stub ignores filters: what it lists is what they selected.
  for flags in '--filter status=running' '-f status=running' '-fstatus=running' '-f=status=running' '--filter=status=running' '-qf status=running'; do
    # shellcheck disable=SC2086
    run ps $flags
    check "\`ps $flags\` lists by ID, the filter applied" \
      '[[ $last == "$(call ps -a --filter "id=$job1" --filter "id=$job2")"* ]]'
  done
  printf '%s\n' "$runner" >"$scratch/running"
  run ps -q
  lists 'the runner alone lists none, with a filter no ID matches' ps -a --filter 'id=^$' -q
  printf '%s\n' "$job1" >"$scratch/running"
  run ps -q
  passes ps -q
  touch "$scratch/ps-fails"
  run ps -q --filter bogus=1
  passes ps -q --filter bogus=1
  for args in '--bogus' '-x' 'extra' '-n x'; do
    # shellcheck disable=SC2086
    run ps $args
    # shellcheck disable=SC2086
    passes ps $args
  done
}

case_ps_counts_last_without_the_runner() {
  # The runner is the newest of all.
  printf '%s\n' "$runner" "$job3" "$job1" "$job2" >"$scratch/all"
  for flags in '-n 2' '-n2' '--last 2' '--last=2' '-qn 2'; do
    # shellcheck disable=SC2086
    run ps $flags
    check "\`ps $flags\` lists the two newest but the runner" \
      '[[ $last == "$(call ps -a --filter "id=$job3" --filter "id=$job1")"* ]]'
  done
  for flags in '-l' '--latest' '-lq'; do
    # shellcheck disable=SC2086
    run ps $flags
    check "\`ps $flags\` lists the newest but the runner" '[[ $last == "$(call ps -a --filter "id=$job3")"* ]]'
  done
  run ps -n -1
  check '-n -1 is no limit' '[[ $last == "$(call ps -a --filter "id=$job1" --filter "id=$job2")"* ]]'
  # When the runner isn't among the newest, the listing is the caller's.
  printf '%s\n' "$job3" "$job1" "$job2" "$runner" >"$scratch/all"
  run ps -n 2 -q
  passes ps -n 2 -q
}

case_targets_skip_the_runner() {
  run kill "$runner"
  check 'kill of the runner alone runs nothing and exits 0' \
    '((status == 0)) && [[ $last == *inspect* && $err == "backmesh: skipped the runner'\''s own container" ]]'
  run kill "$job1" "$runner" "$job2"
  skips 'kill drops the runner by ID' kill -- "$job1" "$job2"
  run rm -f "$job1" "${runner:0:12}"
  skips 'rm drops it by prefix' rm -f -- "$job1"
  run rm -fv "$job1" 1ab2
  skips 'rm -fv drops it by a short prefix' rm -fv -- "$job1"
  run stop runner-job "$job1"
  skips 'stop drops it by name' stop -- "$job1"
  run restart /runner-job "$job1"
  skips 'restart drops it by /name' restart -- "$job1"
  run pause "$job1" runner-job
  skips 'pause' pause -- "$job1"
  run container rm -f "$runner" "$job1"
  skips '`container rm`' container rm -f -- "$job1"
  run container remove "$runner" "$job1"
  skips '`container remove`' container remove -- "$job1"
  run container stop -t 1 "$runner" "$job1"
  skips '`container stop`, its -t value kept though the runner ID starts with it' container stop -t 1 -- "$job1"
  run stop -t1 "$runner" "$job1"
  skips '-t1' stop -t1 -- "$job1"
  run stop --time 1 "$job1" "$runner"
  skips '--time 1' stop --time 1 -- "$job1"
  run kill -s 1 "$runner" "$job1"
  skips 'kill -s 1' kill -s 1 -- "$job1"
  run kill --signal=KILL "$runner" "$job1"
  skips 'kill --signal=KILL' kill --signal=KILL -- "$job1"
  run update --cpus 1 -m 1g "$runner" "$job1"
  skips 'update keeps its values' update --cpus 1 -m 1g -- "$job1"
  run -H unix:///var/run/docker.sock kill -- "$runner" "$job1"
  skips 'keeps the global options and reads after --' -H unix:///var/run/docker.sock kill -- "$job1"
  run rename runner-job other
  check "rename of the runner runs nothing" \
    '((status == 0)) && [[ $last == *inspect* && $err == *skipped* ]]'
}

case_targets_leave_the_rest_alone() {
  run kill "$job1" "$job2"
  passes kill "$job1" "$job2"
  run rm -f 1ab
  passes rm -f 1ab
  run rename "$job1" runner-job
  passes rename "$job1" runner-job
  run stop -t 1 "$job1"
  passes stop -t 1 "$job1"
  STATUS=1 run kill "$job1" "$runner" missing
  check 'keeps the exit status of the rest' '((status == 1)) && [[ $err == *skipped* ]]'
}

case_finds_the_runner_by_its_cgroup() {
  echo "0::/system.slice/docker-$runner.scope" >"$scratch/cgroup"
  : >"$scratch/mountinfo"
  run kill "$runner" "$job1"
  skips 'from a systemd cgroup' kill -- "$job1"
  echo "0::/docker/$runner" >"$scratch/cgroup"
  run ps -q
  lists 'from a cgroupfs cgroup' ps -a --filter "id=$job1" --filter "id=$job2" -q
}

case_passes_everything_outside_a_container() {
  : >"$scratch/mountinfo"
  run kill "$runner"
  passes kill "$runner"
  run ps -q
  passes ps -q
}

for current in $(declare -F | awk '$3 ~ /^case_/ { print $3 }'); do
  setup
  "$current"
  rm -rf "$scratch"
done

if ((failures)); then
  printf '%d checks failed\n' "$failures"
  exit 1
fi
echo 'docker.sh: all checks passed'
