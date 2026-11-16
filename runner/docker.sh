#!/bin/bash -p
# backmesh's `docker`, first on every PATH in the image
# ahead of the real CLI. The runner is a container on the VM's Docker, which
# the job's steps use too, so `docker kill $(docker ps -q)` would kill it, and
# GitHub would fail the job with a lost runner; on GitHub's runners it can't.
# So `docker ps` never lists this container, and `kill`, `stop`, `rm`,
# `restart`, `pause`, `update` and `rename` skip it, with one line on stderr.
# Every other command, and these when this container isn't involved, runs the
# real CLI unchanged by `exec`. Clients of Docker's API, and steps in a job's
# `container:` or a container action, don't come through here. bash -p reads
# no BASH_ENV and no exported functions of the caller's, and the process is
# named docker, as runner-job.sh's pkill -x expects.
set -uo pipefail

# The tests source this file and point these elsewhere.
real=/usr/local/libexec/backmesh/docker
mountinfo=/proc/self/mountinfo
cgroup=/proc/self/cgroup

# This container's full ID: Docker bind-mounts its
# `<data-root>/containers/<id>/` hostname, hosts and resolv.conf files into
# every container, whatever the cgroup driver or namespace and the hostname
# (test/e2e/own-image.ts). The cgroup path holds it only with the host's
# cgroup namespace. Empty outside a Docker container.
self_id() {
  local id
  id=$(awk '$5 ~ /^\/etc\/(hostname|hosts|resolv\.conf)$/ && match($4, /\/containers\/[0-9a-f]{64}\//) {
      print substr($4, RSTART + 12, 64); exit }' "$mountinfo" 2>/dev/null)
  if [[ -z $id ]]; then
    id=$(grep -oE -m1 '(docker-|/docker/)[0-9a-f]{64}' "$cgroup" 2>/dev/null | grep -oE '[0-9a-f]{64}')
  fi
  printf '%s' "$id"
}

skipped() { printf "backmesh: skipped the runner's own container\n" >&2; }

# The real CLI with the global options, its input left to the caller's command.
query() { "$real" "${globals[@]}" "$@" </dev/null; }

# `ps` and `container ls`: when the containers it selects include this one,
# lists them again without it, by ID, with the caller's display options.
# -n and -l count the containers after this one is left out, and take every
# state, as Docker's do. Unknown options go to the real CLI to report.
ps_cmd() {
  local sel=() disp=() limit='' latest='' arg flag rest ids
  while (($#)); do
    arg=$1
    shift
    case $arg in
      -a | --all | --all=*) sel+=("$arg") ;;
      -q | --quiet | --quiet=* | -s | --size | --size=* | --no-trunc | --no-trunc=* | --format=*) disp+=("$arg") ;;
      --format) (($#)) || return 1; disp+=("$arg" "$1"); shift ;;
      --filter=*) sel+=("$arg") ;;
      --filter) (($#)) || return 1; sel+=("$arg" "$1"); shift ;;
      --last=*) limit=${arg#*=} ;;
      --last) (($#)) || return 1; limit=$1; shift ;;
      --latest | --latest=true) latest=1 ;;
      --latest=false) ;;
      --* | -) return 1 ;;
      -?*)
        # A shorthand chain, as pflag reads one: -aq, -qf status=exited, -n3.
        rest=${arg#-}
        while [[ -n $rest ]]; do
          flag=${rest:0:1} rest=${rest:1}
          case $flag in
            a) sel+=(-a) ;;
            q | s) disp+=("-$flag") ;;
            l) latest=1 ;;
            f | n)
              if [[ -z $rest ]]; then (($#)) || return 1; rest=$1; shift; fi
              rest=${rest#=}
              if [[ $flag == f ]]; then sel+=(--filter "$rest"); else limit=$rest; fi
              rest=
              ;;
            *) return 1 ;;
          esac
        done
        ;;
      *) return 1 ;;
    esac
  done
  [[ -z $limit || $limit =~ ^-?[0-9]+$ ]] || return 1
  if [[ -n $limit && $limit -le 0 ]]; then limit=; fi
  if [[ -z $limit && -n $latest ]]; then limit=1; fi
  if [[ -n $limit ]]; then sel+=(-a); fi

  ids=$(query "${cmd[@]}" "${sel[@]}" -q --no-trunc 2>/dev/null) || return 1
  grep -qxF "$self" < <(head -n "${limit:-${#ids}}" <<<"$ids") || return 1
  local filters=()
  while IFS= read -r arg; do
    if [[ -n $arg ]]; then filters+=(--filter "id=$arg"); fi
  done < <(grep -vxF "$self" <<<"$ids" | head -n "${limit:-${#ids}}")
  # For the header alone, a filter no ID matches: Docker matches an id filter
  # as an ID prefix.
  ((${#filters[@]})) || filters=(--filter 'id=^$')
  exec "$real" "${globals[@]}" "${cmd[@]}" -a "${filters[@]}" "${disp[@]}"
}

# The commands that act on containers named as arguments: drops the ones that
# are this container, by ID, ID prefix or name, as Docker resolves them. Each
# command's options that take a value, so a value isn't read as a container.
# For rename only the first argument is a container.
declare -A takes_value=(
  [kill]='-s --signal'
  [stop]='-s --signal -t --time --timeout'
  [restart]='-s --signal -t --time --timeout'
  [update]='--blkio-weight --cpu-period --cpu-quota --cpu-rt-period --cpu-rt-runtime -c --cpu-shares --cpus --cpuset-cpus --cpuset-mems --kernel-memory -m --memory --memory-reservation --memory-swap --pids-limit --restart'
)
targets_cmd() {
  local values=" ${takes_value[$1]:-} " opts=() names=() kept=() arg name='' dropped=''
  shift
  while (($#)); do
    arg=$1
    shift
    if [[ $arg == -- ]]; then names+=("$@"); break; fi
    if [[ $arg == --* ]]; then
      opts+=("$arg")
      # --time 5; --time=5 carries its own.
      if [[ $values == *" $arg "* ]] && (($#)); then opts+=("$1") && shift; fi
    elif [[ $arg == -?* ]]; then
      opts+=("$arg")
      # A shorthand chain, as pflag reads one: -fv, -s KILL, -sKILL, -ft5.
      local rest=${arg#-}
      while [[ -n $rest ]]; do
        if [[ $values == *" -${rest:0:1} "* ]]; then
          if [[ ${#rest} == 1 ]] && (($#)); then opts+=("$1") && shift; fi
          break
        fi
        rest=${rest:1}
      done
    else
      names+=("$arg")
    fi
  done
  local n=0
  for arg in "${names[@]}"; do
    n=$((n + 1))
    if [[ ${cmd[*]: -1} == rename && $n -gt 1 ]]; then kept+=("$arg"); continue; fi
    if [[ -z $name ]]; then name=$(query inspect --type container --format '{{.Name}}' "$self" 2>/dev/null) || return 1; fi
    if [[ $arg == "$self" || /${arg#/} == "$name" ]] \
      || [[ $arg =~ ^[0-9a-f]+$ && $self == "$arg"* \
        && $(query inspect --type container --format '{{.Id}}' "$arg" 2>/dev/null) == "$self" ]]; then
      dropped=1
      [[ ${cmd[*]: -1} == rename ]] && { skipped; exit 0; }
    else
      kept+=("$arg")
    fi
  done
  [[ -n $dropped ]] || return 1
  skipped
  ((${#kept[@]})) || exit 0
  exec "$real" "${globals[@]}" "${cmd[@]}" "${opts[@]}" -- "${kept[@]}"
}

main() {
  globals=() cmd=()
  local args=("$@") i=0 arg
  # Docker's global options, before the command.
  while ((i < ${#args[@]})); do
    arg=${args[i]}
    case $arg in
      --config | -c | --context | -H | --host | -l | --log-level | --tlscacert | --tlscert | --tlskey)
        globals+=("$arg" "${args[i + 1]:-}")
        i=$((i + 2))
        ;;
      -?*) globals+=("$arg") i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  local first=${args[i]:-} second=${args[i + 1]:-} rest=()
  self=$(self_id)
  if [[ -n $self ]]; then
    case $first in
      ps) cmd=(ps) rest=("${args[@]:i+1}") ;;
      kill | stop | rm | restart | pause | update | rename) cmd=("$first") rest=("${args[@]:i+1}") ;;
      container)
        case $second in
          ls | list | ps) cmd=(container "$second") rest=("${args[@]:i+2}") ;;
          kill | stop | rm | remove | restart | pause | update | rename) cmd=(container "$second") rest=("${args[@]:i+2}") ;;
        esac
        ;;
    esac
  fi
  case ${cmd[*]: -1} in
    ps | ls | list) ps_cmd "${rest[@]}" ;;
    kill | stop | rm | remove | restart | pause | update | rename) targets_cmd "${cmd[@]: -1}" "${rest[@]}" ;;
  esac
  exec "$real" "$@"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
