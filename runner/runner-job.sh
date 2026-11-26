#!/usr/bin/env bash
# backmesh's runner: one ephemeral GitHub Actions runner as one anycloud VM
# Job, registered with the JIT config the listener minted.
# Each container runs one job on its own VM, so there's nothing to reset. Its
# `docker` is the VM's, through the host's socket that anycloud mounts.
set -Eeuo pipefail

# The tests source this file and point these into a scratch directory.
root=
cgroup=/sys/fs/cgroup
proc=/proc
sample_every=5
hook=/usr/local/bin/runner-job-completed.sh
started_hook=/usr/local/bin/runner-job-started.sh
auto_cache=/usr/local/lib/backmesh/auto-cache.mjs
watch_grace=5
kill_grace=3
# The real CLI, under the image's `docker` (docker.sh), for the stop path: its
# calls must be quick, and its container lists must hold this container.
real_docker=/usr/local/libexec/backmesh/docker

log() { printf '[runner-job] %s\n' "$*"; }

# awk program $1 over the cgroup file $2, or $3 when it can't be read.
cg() { awk "$1" "$cgroup/$2" 2>/dev/null || echo "$3"; }
# One sample of the container's cgroup into $1: the stats
# line, then the state. $2: the work directory in KiB; $3: the runner name. The
# memory peak is anon + kernel: memory.peak counts page cache too.
# Kernels before 5.18 have no kernel key: kernel_stack + slab is most of it.
# Best effort: a file it can't read counts 0; a value it can't read for a delta
# is "-" in the state and null in the line.
# Callers run it in a subshell, as bash exits on some expansion errors even
# where errexit is off.
# shellcheck disable=SC2016 # cg's arguments are awk programs
sample_job() {
  local name t0 u0 t1 u1 oom0 mem cpu disk t u oom w psi
  local cs0 cf0 csp cfp ms0 mf0 msp mfp cs ct cf cft ms mt mf mft
  # PSI: avg10 in hundredths of a percent, and the total.
  psi='{ for (i = 2; i <= NF; i++) { split($i, kv, "="); v[$1 kv[1]] = kv[2] } }
    function f(k) { return k in v ? (k ~ /avg/ ? int(v[k] * 100 + 0.5) : v[k]) : "-" }
    END { print f("someavg10"), f("sometotal"), f("fullavg10"), f("fulltotal") }'
  {
    flock 9
    t=${EPOCHREALTIME/./}
    u=$(cg '$1 == "usage_usec" { v = $2 } END { print v + 0 }' cpu.stat 0)
    oom=$(cg '$1 == "oom_kill" { v = $2 } END { print v + 0 }' memory.events 0)
    read -r cs ct cf cft < <(cg "$psi" cpu.pressure '- - - -')
    read -r ms mt mf mft < <(cg "$psi" memory.pressure '- - - -')
    { read -r _ && read -r name t0 u0 t1 u1 oom0 mem cpu disk cs0 cf0 csp cfp ms0 mf0 msp mfp; } 2>/dev/null <"$1" \
      || { name=$3 t0=$t u0=$u t1=$t u1=$u oom0=$oom mem=0 cpu=0 disk=0
        cs0=$ct cf0=$cft csp=- cfp=- ms0=$mt mf0=$mft msp=- mfp=-; }
    w=$(cg '{ v[$1] = $2 } END { print v["anon"] + ("kernel" in v ? v["kernel"] : v["kernel_stack"] + v["slab"]) }' memory.stat 0)
    if ((w > mem)); then mem=$w; fi
    printf -v w '%.0f' "${sample_every}e6" # shorter intervals, as summary's, are noise
    if ((t - t1 >= w && (u - u1) * 1000 / (t - t1) > cpu)); then cpu=$(((u - u1) * 1000 / (t - t1))); fi
    if ((${2:-0} * 1024 > disk)); then disk=$(($2 * 1024)); fi
    csp=$(hi "$csp" "$cs") cfp=$(hi "$cfp" "$cf") msp=$(hi "$msp" "$ms") mfp=$(hi "$mfp" "$mf")
    printf 'backmesh-job-stats runner=%s seconds=%d memory_peak_bytes=%d memory_cgroup_peak_bytes=%s oom_kills=%d cpu_avg_millicores=%d cpu_peak_millicores=%d disk_peak_bytes=%d' \
      "$name" $(((t - t0) / 1000000)) "$mem" "$(cg '{ print $1 }' memory.peak 0)" \
      $((oom - oom0)) $((t > t0 ? (u - u0) * 1000 / (t - t0) : 0)) "$cpu" "$disk" >"$1.new"
    printf ' cpu_pressure_some_usec=%s cpu_pressure_full_usec=%s cpu_pressure_some_avg10_peak=%s cpu_pressure_full_avg10_peak=%s memory_pressure_some_usec=%s memory_pressure_full_usec=%s memory_pressure_some_avg10_peak=%s memory_pressure_full_avg10_peak=%s\n%s\n' \
      "$(delta "$cs0" "$ct")" "$(delta "$cf0" "$cft")" "$(pct "$csp")" "$(pct "$cfp")" \
      "$(delta "$ms0" "$mt")" "$(delta "$mf0" "$mft")" "$(pct "$msp")" "$(pct "$mfp")" \
      "$name $t0 $u0 $t $u $oom0 $mem $cpu $disk $cs0 $cf0 $csp $cfp $ms0 $mf0 $msp $mfp" >>"$1.new"
    mv "$1.new" "$1"
  } 9>>"$1.lock"
}

# The higher of $1 and $2, either "-" when unknown.
hi() { if [[ $2 != - && ($1 == - || $2 -gt $1) ]]; then echo "$2"; else echo "$1"; fi; }
# $2 - $1, or null when either is unknown.
delta() { if [[ $1 == - || $2 == - ]]; then echo null; else echo $(($2 - $1)); fi; }
# Hundredths $1 as a decimal, or null when unknown.
pct() { if [[ $1 == - ]]; then echo null; else printf '%d.%02d' $(($1 / 100)) $(($1 % 100)); fi; }

# Samples until TERM, then once more; du walks the whole tree, so every sixth time.
# The trap only stops the loop: a sample inside it would flock the lock the
# interrupted sample holds, and wait forever. Each sample runs in a subshell, and
# this loop has no command substitution: bash 5.2 can run a TERM trap inside one,
# where the trap fails to parse and errexit exits.
# shellcheck disable=SC2024 # the runner user writes du's output
sampler() {
  local n=0 child='' d stop=''
  trap 'stop=1; kill "$child" 2>/dev/null || true' TERM
  while [[ -z $stop ]]; do
    sleep "$sample_every" & child=$!
    [[ -n $stop ]] || wait "$child" || true
    child=''
    [[ -z $stop ]] || break
    d=0
    if ((n++ % 6 == 0)); then
      sudo -n ionice -c3 nice du -sxk "$root/workspace/actions-runner/_work" >"$1.du" 2>/dev/null & child=$!
      if [[ -z $stop ]] && wait "$child"; then read -r d _ <"$1.du"; fi
      child=''
    fi
    (sample_job "$1" "$d")
  done
  (sample_job "$1")
}

# Takes a last sample and prints the line as a short block. The runner runs this as
# its job-completed hook, so it lands in the job's own log, under Complete runner.
summary() {
  [[ -s ${BACKMESH_JOB_STATS:-} ]] || return 0
  (sample_job "$BACKMESH_JOB_STATS") || true
  awk -v every="$sample_every" '
    function gib(b) { return sprintf("%.1f GiB", b / 2^30) }
    NR == 1 { for (i = 2; i <= NF; i++) { split($i, kv, "="); s[kv[1]] = kv[2] } }
    END {
      printf "backmesh: resources over %d s, sampled every %d s; Docker containers not counted\n", s["seconds"], every
      printf "  Memory  peak %s, page cache excluded; %d OOM kills\n", gib(s["memory_peak_bytes"]), s["oom_kills"]
      printf "  CPU     average %.2f cores, peak %.2f\n", s["cpu_avg_millicores"] / 1000, s["cpu_peak_millicores"] / 1000
      if (s["cpu_pressure_some_usec"] != "null")
        printf "          waiting for CPU %.1f s, avg10 peak %s %%\n", s["cpu_pressure_some_usec"] / 1e6, s["cpu_pressure_some_avg10_peak"]
      printf "  Disk    work directory peak %s, every %d s; Docker storage not counted\n",
        gib(s["disk_peak_bytes"]), every * 6
    }' "$BACKMESH_JOB_STATS" || true
}

# Start-up timing marks, one `<name> <epoch µs>` per line
# in $marks. The listener passes the submit time; the VM's boot and the
# container's start come from /proc, whose stat is the VM's, and whose PID 1 is
# the container's first process. $1: this Job's start. Best effort: a mark it
# can't write is missing.
marks=
mark() { printf '%s %s\n' "$1" "${2:-${EPOCHREALTIME/./}}" 2>/dev/null >>"$marks" || true; }
start_marks() {
  local boot tick
  if [[ ${BACKMESH_SUBMITTED_AT:-} =~ ^[0-9]+$ ]]; then mark submitted $((BACKMESH_SUBMITTED_AT * 1000)); fi
  boot=$(awk '$1 == "btime" { print $2 }' "$proc/stat" 2>/dev/null) || boot=
  if [[ $boot =~ ^[0-9]+$ ]]; then
    mark vm_booted $((boot * 1000000))
    # starttime, field 22, in clock ticks since boot; comm can hold spaces.
    tick=$(sed 's/.*) //' "$proc/1/stat" 2>/dev/null | awk '{ print $20 }') || tick=
    if [[ $tick =~ ^[0-9]+$ ]]; then mark container_started $((boot * 1000000 + tick * 1000000 / $(getconf CLK_TCK))); fi
  fi
  mark job_started "$1"
}

# The VM's running containers, by full ID, sorted; fails when Docker does.
containers() {
  local ids
  ids=$(timeout "${1:-10}" "$real_docker" ps -q --no-trunc 2>/dev/null) || return 1
  grep -v '^$' <<<"$ids" | sort || true
}

# Ends what holds a stopping runner's job: the containers the job started,
# and the docker clients its steps run here. One job runs per VM, so the
# containers running now that didn't when the runner started ($1, empty when
# that listing failed) are exactly the job's: its `container:` and services,
# and any a step ran through the host's socket, whatever made them. The
# runner's own container, and any of anycloud's, are in $1. Labels would miss
# a step's plain `docker run`, and those containers are the daemon's
# children, not this cgroup's. A VM's shutdown may close Docker's API before
# it stops this container, so the steps' `docker` and `docker-compose`
# clients, in this container's own PID namespace, are killed first: the step
# then ends whatever its container does. Both fit in `docker stop`'s 10 s.
kill_job_containers() {
  local now new
  # A step's `sudo docker` client is root's.
  sudo -n pkill -KILL -x 'docker|docker-compose' 2>/dev/null || pkill -KILL -x 'docker|docker-compose' 2>/dev/null || true
  if [[ ! -s $1 ]]; then
    log "No container list from the runner's start, so no container is killed"
  elif ! now=$(containers 3); then
    log "Docker didn't list its containers, so none is killed"
  else
    new=$(comm -13 "$1" <(printf '%s\n' "$now" | grep -v '^$')) || new=
    if [[ -n $new ]]; then
      log "Killing the job's containers so the runner can report: $(tr '\n' ' ' <<<"$new")"
      # shellcheck disable=SC2086 # one ID a word
      timeout 3 "$real_docker" kill $new >/dev/null 2>&1 || log "docker kill failed"
    fi
  fi
}

# Copies the runner's output through, marking when it's listening for a job.
# A TERM is the runner's to handle: this must outlive it, or the runner's
# writes would fail.
watch_runner() {
  trap '' TERM INT
  local line seen=
  while IFS= read -r line; do
    printf '%s\n' "$line"
    if [[ -z $seen && $line == *'Listening for Jobs'* ]]; then mark runner_listening; seen=1; fi
  done
}

# The runner's job-started hook: marks the job's arrival and prints the
# start-up as segments into the job's own log, under Set up runner, as RunsOn
# does. Each segment runs from the mark before; a clock behind counts 0.
timings() {
  [[ -s ${BACKMESH_JOB_MARKS:-} ]] || return 0
  marks=$BACKMESH_JOB_MARKS
  mark job_received
  awk '
    function d(us) { s = us / 1e6; return s < 120 ? sprintf("%.1f s", s) : s < 7200 ? sprintf("%.0f min", s / 60) : s < 172800 ? sprintf("%.1f h", s / 3600) : sprintf("%.1f d", s / 86400) }
    function has(k) { return k in m }
    function row(label, k, what) {
      if (!has(k)) return
      t = m[k] < prev ? prev : m[k]; out = out sprintf("  %-10s %8s  %s\n", label, d(t - prev), what); prev = t
    }
    { m[$1] = $2 }
    END {
      first = prev = has("submitted") ? m["submitted"] : m["job_started"]
      if (has("submitted")) {
        row("VM", "vm_booted", "a VM launched and booted, with any quota or capacity retries")
        row("Container", "container_started", "Docker installed, the image pulled and started")
      }
      if (has("runner_listening")) {
        row("Runner", "runner_listening", "the runner connected to GitHub")
        row("Assignment", "job_received", "GitHub assigned this job")
      } else row("Runner", "job_received", "the runner connected, GitHub assigned this job")
      printf "backmesh: this job started %s after its runner was %s\n%s", d(prev - first), has("submitted") ? "submitted" : "started", out
    }' "$marks" || true
}

# A job's containers are the VM's, so a path a job hands to `docker run -v`
# must be the same on the VM. The runner Job binds /tmp, /var/tmp and /mnt
# at the same paths (src/listener/runner-jobs.ts), and anycloud /workspace,
# so HOME moves under /workspace: `~/.ssh`, `~/.kube` or a `docker login`'s
# `~/.docker` resolve there too. The VM may leave those directories to root,
# so the bound ones are made writable to every user with the sticky bit, as
# /tmp is; an image run without the binds leaves its own alone. image.yml's
# check runs this too.
share_paths() {
  local dir
  for dir in /tmp /var/tmp /mnt; do
    if mountpoint -q "$root$dir" 2>/dev/null; then
      sudo -n chmod 1777 "$root$dir" || true
    fi
  done
  export HOME=$root/workspace/home
  # The tool cache, which /opt/hostedtoolcache links to, the runner user's.
  mkdir -p "$HOME" "$root/workspace/hostedtoolcache"
  if [[ ! -e $HOME/.profile ]]; then cp -a "$root/etc/skel/." "$HOME/" 2>/dev/null || true; fi
  # The image's Rust, CARGO_HOME and RUSTUP_HOME, as ~/.cargo and ~/.rustup,
  # where GitHub's image has them, so a step's or a cache's `~/.cargo` is
  # cargo's. The image makes both, so the links never dangle. They're the
  # exception to the rule above: they live in the container, not on the VM, so
  # a `docker run -v` of a path under them doesn't read as that path.
  local home
  for home in .cargo .rustup; do
    [[ -e $HOME/$home || -L $HOME/$home ]] || ln -s "$root/home/runner/$home" "$HOME/$home"
  done
  # OpenSSH reads `~` from the passwd entry, not HOME: point it there too,
  # so a key a step writes to ~/.ssh is the one ssh, git and scp read.
  sudo -n usermod -d "$HOME" "$(id -un)" 2>/dev/null || true
}

# The cache. The uploads stop before
# the listener's 10-minute grace for a completed runner's Job.
cache_upload_limit=480
cache_copy_every=2
# The automatic caches' least time left for the save.
auto_save_min=60

# The job-started hook: notes the job's start (`started`, epoch ms) in
# $BACKMESH_AUTO_STATE, from which the restorer counts its limit and times
# its lines. The job doesn't wait for the restores: GitHub tells the listener
# of a job's start, which mints its token, a median 12 s into the job, so
# they run in the background as its steps do.
auto_started() {
  local dir=${BACKMESH_AUTO_STATE:-}
  [[ -n $dir && -d $dir ]] || return 0
  # Whole, through a rename, for the restorer's reads.
  { printf %s $((${EPOCHREALTIME/./} / 1000)) >"$dir/started.new" && mv -f "$dir/started.new" "$dir/started"; } || true
}

# The job-completed hook: when the cache token came, from the restorer's
# `ready`, then the restorer's lines.
auto_lines() {
  local dir=${BACKMESH_AUTO_STATE:-} started ready ms
  [[ -n $dir && -d $dir ]] || return 0
  # Both written with no newline, at which `read` fails.
  started=$(cat "$dir/started" 2>/dev/null) || started=
  ready=$(cat "$dir/ready" 2>/dev/null) || ready=
  if [[ $started =~ ^[0-9]+$ && $ready =~ ^[0-9]+$ ]]; then
    ms=$((ready - started)) && ((ms > 0)) || ms=0
    printf 'backmesh cache: auto the cache token came at +%d.%d s\n' $((ms / 1000)) $((ms % 1000 / 100))
  fi
  cat "$dir/lines" 2>/dev/null || true
}

# The job-completed hook: the job's facts for the save, which runs as root
# with its own HOME. The hook sees GITHUB_PATH's additions to PATH.
job_facts() {
  [[ -d ${BACKMESH_AUTO_STATE:-} ]] || return 0
  jq -n 'env | {PATH, HOME, GITHUB_JOB, GITHUB_REPOSITORY, GITHUB_WORKSPACE, RUNNER_TOOL_CACHE}' \
    >"$BACKMESH_AUTO_STATE/facts.json" 2>/dev/null || true
}

# Keeps a copy of the runner's cache token file ($1) in the job's RUNNER_TEMP
# under the work directory $2, which a `container:` job's steps see; the
# runner clears RUNNER_TEMP at the job's start, so the copy is made again.
copy_cache_token() {
  local child=''
  trap 'kill "$child" 2>/dev/null; exit 0' TERM
  while :; do
    if [[ -r $1 && -d $2/_temp ]] && ! cmp -s "$1" "$2/_temp/.backmesh-cache"; then
      { cp "$1" "$2/_temp/.backmesh-cache.new" && mv -f "$2/_temp/.backmesh-cache.new" "$2/_temp/.backmesh-cache"; } 2>/dev/null || true
    fi
    sleep "$cache_copy_every" & child=$!
    wait "$child" || true
  done
}

# Uploads the job's cache saves after the job: each save step left a plan
# under $1/_backmesh-cache naming its action checkout's uploader, relative to
# the work directory $1, within cache_upload_limit for all. As root, since a
# `container:` job's snapshot is its container user's; the job had sudo too.
# $2: the runner, whose token it reads.
# Then the automatic caches' save, with what's left, given at least
# auto_save_min s: $3 the token file, $4 the restorer's state.
upload_caches() {
  local plan left as=() deadline=$((SECONDS + cache_upload_limit))
  if sudo -n true 2>/dev/null; then as=(sudo -n "--preserve-env=RUNNER_NAME,ImageOS"); fi
  for plan in "$1"/_backmesh-cache/*/plan.json; do
    left=$((deadline - SECONDS))
    if [[ ! -f $plan ]] || ((left <= 0)); then continue; fi
    RUNNER_NAME=$2 "${as[@]}" timeout "$left" node "$1/$(jq -r .uploader "$plan")" "$plan" \
      || log "A cache upload exited with $?"
  done
  left=$((deadline - SECONDS))
  if [[ -r $3 ]] && ((left >= auto_save_min)); then
    "${as[@]}" timeout "$left" node "$auto_cache" save "$3" "$4" "$1" \
      || log "The automatic cache's save exited with $?"
  fi
}

main() {
  local start=${EPOCHREALTIME/./}
  if [[ "$*" == summary ]]; then job_facts; auto_lines; summary; return 0; fi
  # `hook_done`: the job's steps start after the hook.
  if [[ "$*" == timings ]]; then timings; auto_started; mark hook_done; return 0; fi
  if [[ "$*" != run ]]; then
    printf 'Usage: runner-job run | summary | timings\n' >&2
    return 2
  fi
  if [[ -z "${RUNNER_JITCONFIG:-}" ]]; then
    printf '[runner-job] RUNNER_JITCONFIG is required\n' >&2
    return 1
  fi
  # Keep the JIT config out of the job steps' environment.
  local jit=$RUNNER_JITCONFIG
  unset RUNNER_JITCONFIG

  marks=$root/home/runner/.backmesh-job-marks
  start_marks "$start"

  # The VM's Docker, as this user: into the Job's log, which anycloud keeps
  # after the Job ends, when it doesn't answer.
  if ! docker info >/dev/null 2>&1; then
    log "The VM's Docker doesn't answer on its socket:"
    docker info 2>&1 | tail -n 20 || true
    return 1
  fi

  # A job's containers are the VM's, so the paths the runner mounts into them,
  # its work directory and externals, must be the same on the VM: anycloud
  # mounts the VM's /workspace at the same path.
  # The containers before the job, which a stop leaves running; left empty
  # when Docker doesn't list them, so a stop kills none.
  local before=$root/home/runner/.backmesh-containers
  containers >"$before" || { log "Docker didn't list its containers"; : >"$before"; }

  share_paths
  cp -a "$root/opt/actions-runner-dist/." "$root/workspace/actions-runner/"
  cd "$root/workspace/actions-runner"
  log "Running the ephemeral runner $(cat "$root/opt/actions-runner-dist/.runner-version")"
  # The runner's name, its Job's ID, from the listener: GitHub's JIT config
  # names it too, but in a format GitHub doesn't document.
  local stats=$root/home/runner/.backmesh-job-stats name=${BACKMESH_RUNNER_NAME:-unknown}
  (sample_job "$stats" 0 "$name") || true
  sampler "$stats" & local sampler=$!
  local work=$root/workspace/actions-runner/_work copier="" restorer=""
  local token=$root/run/anycloud-secrets/_bm-cache-$name/BACKMESH_CACHE
  local auto=$root/home/runner/.backmesh-auto
  # The hooks write and read it only when a restorer runs.
  rm -rf "$auto"
  if [[ -d ${token%/*} ]]; then
    mkdir -p "$auto"
    copy_cache_token "$token" "$work" & copier=$!
    node "$auto_cache" restore "$token" "$auto" & restorer=$!
  fi
  local out watcher
  exec {out}> >(watch_runner)
  watcher=$!
  # The runner reads its JIT config from this variable and clears it, so it
  # never appears in a process's arguments. RUNNER_MANUALLY_TRAP_SIG makes
  # run.sh pass a TERM on to Runner.Listener as an INT to its process group
  # (actions/runner `run.sh` runWithManualTrap). Without it, the TERM below
  # killed run.sh alone; the listener died with the container, so GitHub
  # failed a lost VM's job only at its ~10-minute runner timeout. With it,
  # the job is cancelled and reported before the listener exits. A background
  # job starts with INT ignored, and .NET keeps an ignored INT ignored; `env`
  # restores it, whatever this shell inherited.
  ACTIONS_RUNNER_INPUT_JITCONFIG=$jit ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$hook \
    ACTIONS_RUNNER_HOOK_JOB_STARTED=$started_hook BACKMESH_JOB_STATS=$stats \
    BACKMESH_JOB_MARKS=$marks BACKMESH_AUTO_STATE=$auto RUNNER_MANUALLY_TRAP_SIG=1 \
    env --default-signal=INT ./run.sh >&"$out" &
  local runner=$!
  exec {out}>&-
  unset jit
  # A terminated Job or a stopping container, such as a VM's shutdown when
  # it's stopped or reclaimed (`docker stop`'s TERM, 10 s before its KILL):
  # the runner cancels its job and reports it first. A step running a
  # container that ignores INT holds the runner past the VM's end, so after
  # kill_grace, if the runner still runs, the steps' docker clients and the
  # job's containers are killed, once.
  local killer=
  trap 'kill -TERM "$runner" 2>/dev/null || true
    if [[ -z $killer ]]; then
      (sleep "$kill_grace"; if kill -0 "$runner" 2>/dev/null; then kill_job_containers "$before"; fi) &
      killer=$!
    fi' TERM INT
  local status=0
  wait "$runner" || status=$?
  while kill -0 "$runner" 2>/dev/null; do wait "$runner" || status=$?; done
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  local child
  for child in $copier $restorer; do kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; done
  # A process the job left can hold the runner's output open: give the watcher
  # a few seconds to copy the runner's last lines, then stop it.
  for _ in $(seq $((watch_grace * 10))); do kill -0 "$watcher" 2>/dev/null || break; sleep 0.1; done
  kill -KILL "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  # One greppable line in the Job's log.
  head -n1 "$stats" 2>/dev/null || true
  # And one of the start-up marks in epoch ms, empty when missing.
  awk -v name="$name" '{ m[$1] = $2 } END {
    printf "backmesh-job-timings runner=%s", name
    n = split("submitted vm_booted container_started job_started runner_listening job_received hook_done", k, " ")
    for (i = 1; i <= n; i++) if (k[i] in m) printf " %s_ms=%.0f", k[i], int(m[k[i]] / 1000); else printf " %s_ms=", k[i]
    print ""
  }' "$marks" 2>/dev/null || true
  log "The runner exited with $status"
  upload_caches "$work" "$name" "$token" "$auto"
  return "$status"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
