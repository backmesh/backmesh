#!/usr/bin/env bash
# Tests for runner-job.sh. Each case sources it into a subshell, points its
# paths into a scratch root, and stubs the root-only commands on PATH.
# Run: bash runner/test/runner-job.test.sh
# Checks are single-quoted for check's eval, and run_job's subshell sets the
# sourced script's variables on purpose.
# shellcheck source-path=SCRIPTDIR disable=SC2016,SC2030,SC2031,SC2034
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script=$here/../runner-job.sh
failures=0

# A PSI file: some's avg10 and total, then full's.
psi() { printf 'some avg10=%s avg60=0.00 avg300=0.00 total=%s\nfull avg10=%s avg60=0.00 avg300=0.00 total=%s\n' "$@"; }
export -f psi

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"$stubs/$1" && chmod +x "$stubs/$1"; }

setup() {
  scratch=$(mktemp -d)
  root=$scratch/root
  calls=$scratch/calls
  stubs=$scratch/stubs
  mkdir -p "$root"/home/runner "$root"/workspace "$root"/opt/actions-runner-dist "$stubs" \
    "$scratch/cgroup" "$scratch/proc"
  # The container's cgroup, its counters already started: memory.peak counts
  # page cache, and memory.events has an OOM kill from before the first sample.
  echo 'usage_usec 1000000' >"$scratch/cgroup/cpu.stat"
  psi 1.00 1000000 0.50 400000 >"$scratch/cgroup/cpu.pressure"
  psi 0.00 100 0.00 50 >"$scratch/cgroup/memory.pressure"
  echo 'anon 1073741824' >"$scratch/cgroup/memory.stat"
  echo 'oom_kill 1' >"$scratch/cgroup/memory.events"
  echo 10737418240 >"$scratch/cgroup/memory.peak"
  printf 'source %q && cgroup=%q proc=%q sample_every=${SAMPLE_EVERY:-0.1} && main summary\n' \
    "$script" "$scratch/cgroup" "$scratch/proc" >"$scratch/hook.sh"
  printf 'source %q && main timings\n' "$script" >"$scratch/started-hook.sh"
  touch "$calls"
  echo 2.338.2 >"$root"/opt/actions-runner-dist/.runner-version
  # A fake runner as actions/runner lays it out: run.sh, which with
  # RUNNER_MANUALLY_TRAP_SIG runs the listener in its own process group and
  # turns a TERM or INT into an INT to that group, and otherwise runs it in
  # the foreground with no trap (upstream `run.sh`, without run-helper.sh's
  # mapping of the listener's exit codes); and the listener, which
  # records its environment, signals and the entrypoint, runs
  # $FAKE_RUNNER_HOOK, then exits with $FAKE_RUNNER_STATUS, or waits for a
  # signal with $FAKE_RUNNER_WAIT, running $FAKE_RUNNER_ON_INT on an INT.
  printf '%s\n' '#!/usr/bin/env bash' \
    'echo "$PPID" >"$SCRATCH/runner-parent"' \
    'listener=$(dirname "$0")/listener' \
    'if [[ -z ${RUNNER_MANUALLY_TRAP_SIG:-} ]]; then "$listener"; exit 0; fi' \
    'set -m' \
    "trap 'kill -INT -\$PID' INT TERM" \
    '"$listener" & PID=$!' \
    'wait $PID; status=$?' \
    'trap - INT TERM' \
    'wait $PID' \
    'exit $status' >"$root"/opt/actions-runner-dist/run.sh
  printf '%s\n' '#!/usr/bin/env bash' \
    'env >"$SCRATCH/runner-env"' \
    'eval "${FAKE_RUNNER_HOOK:-}"' \
    'trap '\''eval "${FAKE_RUNNER_ON_INT:-}"; echo INT >>"$SCRATCH/runner-signals"; exit 130'\'' INT' \
    'trap '\''echo TERM >>"$SCRATCH/runner-signals"; exit 143'\'' TERM' \
    'if [[ -n ${FAKE_RUNNER_WAIT:-} ]]; then touch "$SCRATCH/runner-started"; sleep 30 & wait; fi' \
    'exit "${FAKE_RUNNER_STATUS:-0}"' >"$root"/opt/actions-runner-dist/listener
  chmod +x "$root"/opt/actions-runner-dist/run.sh "$root"/opt/actions-runner-dist/listener
  stub sudo 'while [[ $1 == -* ]]; do shift; done; exec "$@"'
  # The VM's Docker: down while $SCRATCH/docker-down exists. Its running
  # containers are $SCRATCH/docker-running's lines; `kill` records its IDs
  # in docker-killed and stops them.
  stub docker 'if [[ -e $SCRATCH/docker-down ]]; then seq 30 | sed "s/^/docker line /"; exit 1; fi
    case $1 in
      ps) if [[ -e $SCRATCH/docker-ps-fails ]]; then rm "$SCRATCH/docker-ps-fails"; exit 1; fi
        cat "$SCRATCH/docker-running" 2>/dev/null ;;
      kill) shift; printf "%s\n" "$@" >>"$SCRATCH/docker-killed"
        grep -vxF -f <(printf "%s\n" "$@") "$SCRATCH/docker-running" >"$SCRATCH/docker-left" || true
        mv "$SCRATCH/docker-left" "$SCRATCH/docker-running" ;;
    esac'
  # Never the host's pkill: these tests share it.
  stub pkill 'echo "pkill $*" >>"$CALLS"'
  # A JIT config as GitHub encodes it: the runner's files, each in base64,
  # .NET's indented JSON with CRLF line ends. The runner's name is the
  # listener's BACKMESH_RUNNER_NAME, never read from it.
  jit=$(printf '{".runner":"%s"}' "$(printf '{\r\n  "AgentId": 7,\r\n  "AgentName": "bmabcde-04-x"\r\n}' | base64 -w0)" | base64 -w0)
  export SCRATCH=$scratch CALLS=$calls PATH=$stubs:$PATH RUNNER_JITCONFIG=$jit BACKMESH_RUNNER_NAME=bmabcde-04-x
  # Also the job files a backmesh runner sets for the job running these tests.
  unset FAKE_RUNNER_STATUS FAKE_RUNNER_WAIT FAKE_RUNNER_HOOK FAKE_RUNNER_ON_INT SAMPLE_EVERY BACKMESH_SUBMITTED_AT \
    BACKMESH_JOB_STATS BACKMESH_JOB_MARKS BACKMESH_AUTO_STATE UPLOAD_LIMIT RUNNER_NAME
}

# The VM booted $1 s ago and the container's PID 1 started $2 s after that, as
# /proc shows them; $3 its name. The VM's clock ticks 100 times a second.
vm_and_container() {
  mkdir -p "$scratch/proc/1"
  printf 'cpu  1 2 3 4\nbtime %d\nprocesses 4242\n' $((now - $1)) >"$scratch/proc/stat"
  printf '1 (%s) S 0 1 1 0 -1 4194560 2510 0 0 0 12 5 0 0 20 0 9 0 %d 1245184 2048 18446744073709551615\n' \
    "$3" $(($2 * 100)) >"$scratch/proc/1/stat"
}

# A runner that connects, waits $1 s for a job, then runs the job-started hook.
runner_takes_a_job_after() {
  export FAKE_RUNNER_HOOK="echo '√ Connected to GitHub'; echo '2026-11-05 12:00:00Z: Listening for Jobs'
    sleep $1; bash \"\$ACTIONS_RUNNER_HOOK_JOB_STARTED\" >\"\$SCRATCH/job-log\""
}

# The table's seconds add up to its total.
adds_up() {
  awk 'NR == 1 { total = $5 } NR > 1 && $3 == "s" { sum += $2 } END { exit !(total > 0 && sum - total < 0.15 && total - sum < 0.15) }' "$scratch/job-log"
}

# Runs runner-job's main in a subshell with the scratch paths; sets $status.
run_job() {
  (
    # shellcheck source=../runner-job.sh
    source "$script"
    root=$scratch/root
    cgroup=$scratch/cgroup sample_every=${SAMPLE_EVERY:-0.1} hook=$scratch/hook.sh
    proc=$scratch/proc started_hook=$scratch/started-hook.sh watch_grace=1 kill_grace=1 real_docker=docker cache_copy_every=0.1
    auto_cache=$scratch/auto-cache.mjs cache_upload_limit=${UPLOAD_LIMIT:-480}
    main "$@"
  ) >"$scratch/out" 2>&1
  status=$?
  echo "$status" >"$scratch/status"
}

check() {
  if eval "$2"; then return; fi
  printf 'FAIL %s: %s\n' "$current" "$1"
  sed 's/^/    /' "$scratch/out"
  failures=$((failures + 1))
}

case_times_a_start_on_its_vm() {
  now=$(date +%s)
  # Submitted 100 s ago; the VM booted 40 s later, the container 38 s after that.
  export BACKMESH_SUBMITTED_AT=$(((now - 100) * 1000 + 250))
  vm_and_container 60 38 'anycloud runner'
  runner_takes_a_job_after 0.3
  run_job run
  check 'exits 0' '((status == 0))'
  check 'passes the runner output through' 'grep -qx "2026-11-05 12:00:00Z: Listening for Jobs" "$scratch/out"'
  check 'heads the table with the time since submit' \
    'grep -Eq "^backmesh: this job started 10[0-9]\.[0-9] s after its runner was submitted$" "$scratch/job-log"'
  check 'times the VM from the submit' 'grep -Eq "^  VM +39\.8 s  a VM launched and booted, with any quota or capacity retries$" "$scratch/job-log"'
  check 'and the container from its boot' 'grep -Eq "^  Container +38\.0 s  Docker installed, the image pulled and started$" "$scratch/job-log"'
  check 'then the runner' 'grep -Eq "^  Runner +[0-9.]+ s  the runner connected to GitHub$" "$scratch/job-log"'
  check 'and the wait for this job' 'grep -Eq "^  Assignment +0\.[3-9] s  GitHub assigned this job$" "$scratch/job-log"'
  check 'which add up' adds_up
  check 'prints the marks in one line' \
    'grep -Eq "^backmesh-job-timings runner=bmabcde-04-x submitted_ms=$(((now - 100) * 1000 + 250)) vm_booted_ms=$(((now - 60) * 1000)) container_started_ms=$(((now - 22) * 1000)) job_started_ms=[0-9]{13} runner_listening_ms=[0-9]{13} job_received_ms=[0-9]{13} hook_done_ms=[0-9]{13}$" "$scratch/out"'
}

case_times_a_start_without_the_submit_time() {
  export FAKE_RUNNER_HOOK='bash "$ACTIONS_RUNNER_HOOK_JOB_STARTED" >"$SCRATCH/job-log"'
  run_job run
  check 'exits 0' '((status == 0))'
  check 'counts from the start' 'grep -Eq "^backmesh: this job started [0-9.]+ s after its runner was started$" "$scratch/job-log"'
  check 'from the start, with the runner and assignment as one' \
    '[[ $(awk "NR > 1 { print \$1 }" "$scratch/job-log" | paste -sd" ") == Runner ]] && grep -q "the runner connected, GitHub assigned this job" "$scratch/job-log"'
  check 'leaves the missing marks empty' \
    'grep -Eq "^backmesh-job-timings runner=bmabcde-04-x submitted_ms= vm_booted_ms= container_started_ms= job_started_ms=[0-9]{13} runner_listening_ms= job_received_ms=[0-9]{13} hook_done_ms=[0-9]{13}$" "$scratch/out"'
  run_job timings
  check 'prints nothing outside a job' '((status == 0)) && [[ ! -s $scratch/out ]]'
}

case_rejects_other_commands() {
  run_job bash
  check 'exits 2' '((status == 2))'
  check 'prints usage' 'grep -q "Usage: runner-job run" "$scratch/out"'
}

case_requires_jit_config() {
  unset RUNNER_JITCONFIG
  run_job run
  check 'exits 1' '((status == 1))'
  check 'names the variable' 'grep -q "RUNNER_JITCONFIG is required" "$scratch/out"'
  check 'starts no runner' '[[ ! -e $scratch/runner-env ]]'
}

case_passes_jit_config_only_to_the_runner() {
  run_job run
  check 'exits 0' '((status == 0))'
  check 'runner gets ACTIONS_RUNNER_INPUT_JITCONFIG' \
    'grep -qx "ACTIONS_RUNNER_INPUT_JITCONFIG=$jit" "$scratch/runner-env"'
  check 'runner has no RUNNER_JITCONFIG' '! grep -q "^RUNNER_JITCONFIG=" "$scratch/runner-env"'
  check 'no command argument carries the config' '! grep -qF "$jit" "$calls"'
  check 'runs from a fresh copy of the dist' \
    'grep -qx "PWD=$root/workspace/actions-runner" "$scratch/runner-env"'
}

case_shares_the_mounted_paths_and_a_home_under_workspace() {
  mkdir -p "$root"/tmp "$root"/var/tmp "$root"/mnt "$root"/etc/skel
  chmod 0755 "$root"/tmp "$root"/var/tmp "$root"/mnt
  echo profile >"$root"/etc/skel/.profile
  # The runner Job binds /tmp and /mnt here; /var/tmp isn't a mount.
  stub mountpoint '[[ $2 == "$SCRATCH/root/tmp" || $2 == "$SCRATCH/root/mnt" ]]'
  stub usermod 'echo "usermod $*" >>"$CALLS"'
  run_job run
  check 'exits 0' '((status == 0))'
  check 'a bound /tmp and /mnt are writable to all, sticky' \
    '[[ $(stat -c %a "$root"/tmp) == 1777 && $(stat -c %a "$root"/mnt) == 1777 ]]'
  check "a path that isn't a mount stays as it was" '[[ $(stat -c %a "$root"/var/tmp) == 755 ]]'
  check 'the runner runs with HOME under /workspace' \
    'grep -qx "HOME=$root/workspace/home" "$scratch/runner-env"'
  check 'HOME starts from /etc/skel' '[[ $(cat "$root"/workspace/home/.profile) == profile ]]'
  check "the user's passwd home is HOME, for ssh" \
    'grep -qx "usermod -d $root/workspace/home $(id -un)" "$calls"'
  check 'the marks stay where the hooks read them' '[[ -s $root/home/runner/.backmesh-job-marks ]]'
}

case_exits_with_the_runner_status() {
  export FAKE_RUNNER_STATUS=3
  run_job run
  check 'exits 3' '((status == 3))'
  check 'logs it' 'grep -qx "\[runner-job\] The runner exited with 3" "$scratch/out"'
}

case_stops_copying_output_a_job_holds_open() {
  # A job's leftover process keeps the runner's output open after it exits.
  export FAKE_RUNNER_HOOK='sleep 20 & echo $! >"$SCRATCH/leftover"; echo "The runner is done"'
  local start=$SECONDS
  run_job run
  kill "$(cat "$scratch/leftover")" 2>/dev/null
  check 'exits 0 within the grace' '((status == 0 && SECONDS - start < 5))'
  check 'prints the runner output before the timings' \
    '[[ $(grep -Eo "^(The runner is done|backmesh-job-timings)" "$scratch/out" | paste -sd,) == "The runner is done,backmesh-job-timings" ]]'
}

case_fails_when_docker_does_not_answer() {
  touch "$scratch/docker-down"
  run_job run
  check 'exits 1' '((status == 1))'
  check 'says so' 'grep -q "The VM.s Docker doesn.t answer on its socket" "$scratch/out"'
  check "prints the last 20 lines of docker info's output" \
    'grep -qx "docker line 11" "$scratch/out" && grep -qx "docker line 30" "$scratch/out" && ! grep -qx "docker line 10" "$scratch/out"'
  check 'starts no runner' '[[ ! -e $scratch/runner-env ]]'
}

case_summarizes_the_job_resources() {
  export FAKE_RUNNER_HOOK='mkdir _work && head -c 2097152 /dev/zero >_work/blob
    printf "anon 2147483648\nfile 8589934592\nkernel 1073741824\n" >"$SCRATCH/cgroup/memory.stat"
    echo "oom_kill 2" >"$SCRATCH/cgroup/memory.events"
    echo "usage_usec 3000000" >"$SCRATCH/cgroup/cpu.stat"
    psi 12.34 3000000 5.00 1400000 >"$SCRATCH/cgroup/cpu.pressure"
    psi 2.50 1100 0.25 550 >"$SCRATCH/cgroup/memory.pressure"
    sleep 0.8
    bash "$ACTIONS_RUNNER_HOOK_JOB_COMPLETED" >"$SCRATCH/job-log"'
  run_job run
  check 'exits 0' '((status == 0))'
  check 'prints memory with kernel memory, without page cache, and the OOM kills in the job' \
    'grep -qx "  Memory  peak 3.0 GiB, page cache excluded; 1 OOM kills" "$scratch/job-log"'
  check 'prints CPU to the job log' 'grep -Eq "^  CPU     average [0-9.]+ cores, peak [0-9.]+$" "$scratch/job-log"'
  check 'prints CPU pressure to the job log' 'grep -q "waiting for CPU 2.0 s, avg10 peak 12.34 %" "$scratch/job-log"'
  check "says the job's Docker containers aren't counted" \
    'grep -q "^backmesh: resources over [0-9]* s, sampled every 0 s; Docker containers not counted$" "$scratch/job-log"'
  check 'prints disk to the job log' \
    'grep -q "Disk    work directory peak 0.0 GiB, every 0 s; Docker storage not counted" "$scratch/job-log"'
  check 'prints one stable line' \
    'grep -Eq "^backmesh-job-stats runner=bmabcde-04-x seconds=[0-9]+ memory_peak_bytes=3221225472 memory_cgroup_peak_bytes=10737418240 oom_kills=1 cpu_avg_millicores=[1-9][0-9]* cpu_peak_millicores=[1-9][0-9]* disk_peak_bytes=2[0-9]{6} cpu_pressure_some_usec=2000000 cpu_pressure_full_usec=1000000 cpu_pressure_some_avg10_peak=12.34 cpu_pressure_full_avg10_peak=5.00 memory_pressure_some_usec=1000 memory_pressure_full_usec=500 memory_pressure_some_avg10_peak=2.50 memory_pressure_full_avg10_peak=0.25$" "$scratch/out"'
  run_job summary
  check 'prints nothing outside a job' '((status == 0)) && [[ ! -s $scratch/out ]]'
}

case_samples_a_short_job_at_its_end() {
  export SAMPLE_EVERY=60 FAKE_RUNNER_HOOK='printf "anon 2147483648\nkernel_stack 536870912\nslab 536870912\n" >"$SCRATCH/cgroup/memory.stat"
    bash "$ACTIONS_RUNNER_HOOK_JOB_COMPLETED" >"$SCRATCH/job-log"'
  local t0=$SECONDS
  run_job run
  check 'stops the sampler at once' '((SECONDS - t0 < 10))'
  check 'samples in the hook, kernel_stack + slab without a kernel key' 'grep -q "Memory  peak 3.0 GiB," "$scratch/job-log"'
}

case_runs_without_a_cgroup_file_or_runner_name() {
  rm "$scratch/cgroup/memory.stat"
  unset BACKMESH_RUNNER_NAME
  run_job run
  check 'exits 0' '((status == 0))'
  check 'starts the runner' '[[ -e $scratch/runner-env ]]'
  echo 'anon 1' >"$scratch/cgroup/memory.stat"
  run_job run
  check 'names the runner unknown' 'grep -q "^backmesh-job-stats runner=unknown " "$scratch/out"'
}

case_runs_without_any_cgroup_file() {
  rm "$scratch"/cgroup/*
  export FAKE_RUNNER_STATUS=3 FAKE_RUNNER_HOOK='bash "$ACTIONS_RUNNER_HOOK_JOB_COMPLETED" >"$SCRATCH/job-log"'
  run_job run
  check 'exits with the runner status' '((status == 3))'
  check 'starts the runner' '[[ -e $scratch/runner-env ]]'
  check 'prints zeros' \
    'grep -Eq "^backmesh-job-stats runner=bmabcde-04-x seconds=[0-9]+ memory_peak_bytes=0 memory_cgroup_peak_bytes=0 oom_kills=0 cpu_avg_millicores=0 cpu_peak_millicores=0 disk_peak_bytes=[0-9]+ cpu_pressure_some_usec=null cpu_pressure_full_usec=null cpu_pressure_some_avg10_peak=null cpu_pressure_full_avg10_peak=null memory_pressure_some_usec=null memory_pressure_full_usec=null memory_pressure_some_avg10_peak=null memory_pressure_full_avg10_peak=null$" "$scratch/out"'
  check 'the hook says so' \
    'grep -q "Memory  peak 0.0 GiB, page cache excluded; 0 OOM kills" "$scratch/job-log" && grep -Eq "CPU     average 0.00 cores, peak 0.00$" "$scratch/job-log"'
  check 'and leaves out what it could not read' '! grep -q waiting "$scratch/job-log"'
}

case_sampler_stops_on_term_mid_sample() {
  local stats=$scratch/stats i pid term t hung=0 failed=0
  # A short interval keeps the sampler inside sample_job much of the time.
  for i in $(seq 100); do
    (
      # shellcheck source=../runner-job.sh
      source "$script"
      root=$scratch/root cgroup=$scratch/cgroup sample_every=0.01
      sample_job "$stats" 0 x
      sampler "$stats"
    ) >"$scratch/out" 2>&1 &
    pid=$!
    # The first loop's du output: the TERM trap is set.
    while [[ ! -e $stats.du ]]; do sleep 0.01; done
    rm "$stats.du"
    sleep "0.0$((i % 5))"
    term=${EPOCHREALTIME/./}
    kill -TERM "$pid"
    for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$pid" 2>/dev/null; then
      hung=$((hung + 1))
      command -p pkill -KILL -P "$pid"
      kill -KILL "$pid"
    fi
    wait "$pid" || failed=$((failed + 1))
    # The state line's fourth field: when the last sample read the cgroup.
    { read -r _ && read -r _ _ _ t _; } <"$stats"
    ((t > term)) || failed=$((failed + 1))
  done
  check 'always exits' '((hung == 0))'
  check 'always takes a last sample after the TERM and exits 0' '((failed == 0))'
}

case_forwards_termination_to_the_runner() {
  printf '%s\n' runner-self >"$scratch/docker-running"
  export FAKE_RUNNER_WAIT=1
  run_job run &
  local job=$!
  for _ in $(seq 50); do [[ -e $scratch/runner-started ]] && break; sleep 0.1; done
  # As `docker stop` does: TERM to the entrypoint, the runner's parent.
  kill -TERM "$(cat "$scratch/runner-parent")"
  wait "$job"
  # The listener itself, below run.sh, gets the signal it cancels its job on.
  check 'listener got INT' 'grep -qx INT "$scratch/runner-signals"'
  check 'listener asked for the manual trap' 'grep -qx RUNNER_MANUALLY_TRAP_SIG=1 "$scratch/runner-env"'
  # run.sh exits with its interrupted wait's 143, as upstream's does.
  check 'exits with run.sh status' '[[ $(cat "$scratch/status") == 143 ]]'
  check 'kills no container when the job stops' '[[ ! -e $scratch/docker-killed ]]'
  check 'nor any docker client' '! grep -q pkill "$calls"'
}

case_kills_nothing_after_a_job_that_stops_in_the_grace() {
  # The job's container runs, but its step stops on INT at once.
  printf '%s\n' runner-self >"$scratch/docker-running"
  export FAKE_RUNNER_WAIT=1 FAKE_RUNNER_HOOK='echo job-step >>"$SCRATCH/docker-running"'
  run_job run &
  local job=$!
  for _ in $(seq 50); do [[ -e $scratch/runner-started ]] && break; sleep 0.1; done
  kill -TERM "$(cat "$scratch/runner-parent")"
  wait "$job"
  # Past the grace: a killer left behind would have run by now.
  sleep 1.5
  check 'kills no container' '[[ ! -e $scratch/docker-killed ]]'
  check 'nor any docker client' '! grep -q pkill "$calls"'
}

case_kills_no_container_when_the_start_list_failed() {
  printf '%s\n' runner-self anycloud-agent >"$scratch/docker-running"
  touch "$scratch/docker-ps-fails"
  export FAKE_RUNNER_WAIT=1 FAKE_RUNNER_HOOK='echo job-step >>"$SCRATCH/docker-running"' \
    FAKE_RUNNER_ON_INT='for _ in $(seq 100); do grep -q pkill "$CALLS" && break; sleep 0.1; done'
  run_job run &
  local job=$!
  for _ in $(seq 50); do [[ -e $scratch/runner-started ]] && break; sleep 0.1; done
  kill -TERM "$(cat "$scratch/runner-parent")"
  wait "$job"
  check 'kills no container' '[[ ! -e $scratch/docker-killed ]]'
  check 'still kills the steps docker clients' 'grep -qx "pkill -KILL -x docker|docker-compose" "$calls"'
  check 'says why' 'grep -q "No container list from the runner.s start" "$scratch/out"'
}

case_kills_the_job_containers_a_step_holds_past_the_stop() {
  # The runner's own container and anycloud's run before the job; the job's
  # step runs one that ignores INT, so the listener reports only once it's
  # gone.
  printf '%s\n' runner-self anycloud-agent >"$scratch/docker-running"
  export FAKE_RUNNER_WAIT=1 FAKE_RUNNER_HOOK='echo job-step >>"$SCRATCH/docker-running"' \
    FAKE_RUNNER_ON_INT='for _ in $(seq 100); do [[ -s $SCRATCH/docker-killed ]] && break; sleep 0.1; done'
  run_job run &
  local job=$!
  for _ in $(seq 50); do [[ -e $scratch/runner-started ]] && break; sleep 0.1; done
  local t0=$EPOCHREALTIME
  kill -TERM "$(cat "$scratch/runner-parent")"
  wait "$job"
  local took
  took=$(awk -v a="$t0" -v b="$EPOCHREALTIME" 'BEGIN { printf "%d", b - a }')
  check 'kills only the job step container' '[[ $(cat "$scratch/docker-killed") == job-step ]]'
  check 'leaves the runner and anycloud containers' '[[ $(sort "$scratch/docker-running" | tr "\n" " ") == "anycloud-agent runner-self " ]]'
  check 'the listener then reports' 'grep -qx INT "$scratch/runner-signals"'
  check 'after the grace, well inside a VM stop' '((took >= 1 && took < 5))'
  check 'says so in the log' 'grep -q "Killing the job.s containers so the runner can report: job-step" "$scratch/out"'
  check 'and kills the steps docker clients' 'grep -qx "pkill -KILL -x docker|docker-compose" "$calls"'
}

case_copies_the_cache_token_and_uploads_after_the_job() {
  local token=$root/run/anycloud-secrets/_bm-cache-bmabcde-04-x work=$root/workspace/actions-runner/_work
  mkdir -p "$token" "$work/_backmesh-cache/a"
  echo '{"v":1,"state":"ready"}' >"$token/BACKMESH_CACHE"
  echo '{"uploader":"_actions/o/r/v1/cache/dist/upload.mjs"}' >"$work/_backmesh-cache/a/plan.json"
  stub node 'echo "node $* runner=$RUNNER_NAME" >>"$CALLS"'
  # The runner clears RUNNER_TEMP at the job's start; the copy comes back.
  export FAKE_RUNNER_HOOK="mkdir -p '$work/_temp'; sleep 0.5"
  run_job run
  check 'exits 0' '((status == 0))'
  check "copies the token into RUNNER_TEMP" 'cmp -s "$token/BACKMESH_CACHE" "$work/_temp/.backmesh-cache"'
  check 'runs the plan'"'"'s uploader with the runner'"'"'s name' \
    'grep -qx "node $work/_actions/o/r/v1/cache/dist/upload.mjs $work/_backmesh-cache/a/plan.json runner=bmabcde-04-x" "$calls"'
  local auto=$root/home/runner/.backmesh-auto
  check 'starts the automatic restorer with the runner' \
    'grep -qx "node $scratch/auto-cache.mjs restore $token/BACKMESH_CACHE $auto runner=" "$calls"'
  check 'then the automatic save, after the plan'"'"'s upload' \
    '[[ $(grep -n "upload.mjs\|auto-cache.mjs save" "$calls" | cut -d: -f2-) == "node $work/_actions/o/r/v1/cache/dist/upload.mjs $work/_backmesh-cache/a/plan.json runner=bmabcde-04-x
node $scratch/auto-cache.mjs save $token/BACKMESH_CACHE $auto $work runner=" ]]'
}

case_skips_the_automatic_save_with_under_a_minute_left() {
  local token=$root/run/anycloud-secrets/_bm-cache-bmabcde-04-x
  mkdir -p "$token"
  echo '{"v":1,"state":"ready"}' >"$token/BACKMESH_CACHE"
  stub node 'echo "node $*" >>"$CALLS"'
  export UPLOAD_LIMIT=59
  run_job run
  check 'exits 0' '((status == 0))'
  check 'starts no save' '! grep -q "auto-cache.mjs save" "$calls"'
}

case_holds_the_job_for_no_restore() {
  local dir=$scratch/auto start=${EPOCHREALTIME/./}
  mkdir -p "$dir"
  echo "job_started $start" >"$scratch/marks"
  # A restorer that never finishes, and has said nothing yet.
  BACKMESH_AUTO_STATE=$dir BACKMESH_JOB_MARKS=$scratch/marks bash "$scratch/started-hook.sh" >"$scratch/out" 2>&1
  status=$?
  check 'exits 0' '((status == 0))'
  check 'at once' '(((${EPOCHREALTIME/./} - start) < 500000))'
  check 'notes the job'"'"'s start for the restorer'"'"'s limit and lines' \
    '[[ $(cat "$dir/started") =~ ^[0-9]{13}$ ]]'
  check 'prints no cache line' '! grep -q "^backmesh cache:" "$scratch/out"'
  check 'leaves the restorer no other file' '[[ $(ls "$dir") == started ]]'
  check 'marks the job and the hook'"'"'s end, with no wait between' \
    '[[ $(awk "{ print \$1 }" "$scratch/marks" | paste -sd" ") == "job_started job_received hook_done" ]]'
}

case_prints_the_restores_and_the_token_when_the_job_completes() {
  local dir=$scratch/auto
  mkdir -p "$dir"
  # As the hook and the restorer write them: no newline.
  printf %s 1763800000000 >"$dir/started"
  printf %s 1763800012345 >"$dir/ready"
  printf '%s\n' 'backmesh cache: auto restored node 22.23.5 (own)  40 MB in 1.2 s, at +13.6 s' \
    'backmesh cache: auto restored yarn (own)  812 MB in 9.1 s, at +23.4 s' >"$dir/lines"
  BACKMESH_AUTO_STATE=$dir bash "$scratch/hook.sh" >"$scratch/out" 2>&1
  status=$?
  check 'exits 0' '((status == 0))'
  check 'prints when the token came, then every restore'"'"'s line' \
    '[[ $(cat "$scratch/out") == "backmesh cache: auto the cache token came at +12.3 s
backmesh cache: auto restored node 22.23.5 (own)  40 MB in 1.2 s, at +13.6 s
backmesh cache: auto restored yarn (own)  812 MB in 9.1 s, at +23.4 s" ]]'
}

case_counts_a_token_before_the_job_as_at_its_start() {
  local dir=$scratch/auto
  mkdir -p "$dir"
  printf %s 1763800000000 >"$dir/started"
  printf %s 1763799999000 >"$dir/ready"
  BACKMESH_AUTO_STATE=$dir bash "$scratch/hook.sh" >"$scratch/out" 2>&1
  check 'says +0.0 s' '[[ $(cat "$scratch/out") == "backmesh cache: auto the cache token came at +0.0 s" ]]'
}

case_prints_no_token_line_without_a_token() {
  local dir=$scratch/auto
  mkdir -p "$dir"
  printf %s 1763800000000 >"$dir/started"
  echo 'backmesh cache: auto gave up: no cache token by +120.0 s' >"$dir/lines"
  BACKMESH_AUTO_STATE=$dir bash "$scratch/hook.sh" >"$scratch/out" 2>&1
  check 'prints the restorer'"'"'s line alone' \
    '[[ $(cat "$scratch/out") == "backmesh cache: auto gave up: no cache token by +120.0 s" ]]'
}

case_records_the_job_facts_for_the_save() {
  local dir=$scratch/auto
  mkdir -p "$dir"
  BACKMESH_AUTO_STATE=$dir GITHUB_JOB=build GITHUB_REPOSITORY=acme/app GITHUB_WORKSPACE=/w/app/app \
    RUNNER_TOOL_CACHE=/t PATH="/t/node/22.23.5/x64/bin:$PATH" bash "$scratch/hook.sh" >"$scratch/out" 2>&1
  status=$?
  check 'exits 0' '((status == 0))'
  check 'records PATH as the hook sees it' '[[ $(jq -r .PATH "$dir/facts.json") == /t/node/22.23.5/x64/bin:* ]]'
  check 'and the job'"'"'s name and workspace' \
    '[[ $(jq -r "[.GITHUB_JOB, .GITHUB_REPOSITORY, .GITHUB_WORKSPACE, .RUNNER_TOOL_CACHE, .HOME] | join(\" \")" "$dir/facts.json") == "build acme/app /w/app/app /t $HOME" ]]'
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
echo 'runner-job: all checks passed'
