#!/usr/bin/env bash
# Runs inside the built runner image through the host's Docker socket, as
# docker-check.sh does (image.yml's docker check): this container stands for
# the runner's, and the image's `docker` (runner/docker.sh) must leave it out
# of `ps` and skip it in `kill`, `rm`, `stop` and `rename`, by ID, prefix and
# name, while it acts on the job's containers. It touches only its own
# containers: the VM's others are the real runner's.
# Run: docker run -i --rm --group-add <socket gid> -v /var/run/docker.sock:/var/run/docker.sock --entrypoint bash <image> -s <runner/test/docker-wrapper-check.sh
set -euo pipefail

real=/usr/local/libexec/backmesh/docker
fail() { echo "docker wrapper: $1" >&2; exit 1; }
image=mirror.gcr.io/library/busybox:1.37
label=sh.anycloud.backmesh.wrapper-check=$$-$RANDOM
jobs=()
trap '[[ ${#jobs[@]} == 0 ]] || "$real" rm -f "${jobs[@]}" >/dev/null 2>&1 || true' EXIT
start() { jobs+=("$("$real" run -d --label "$label" "$image" sleep 300)"); }

# This container, as the real CLI sees it. Docker sets no hostname here, so
# HOSTNAME is its short ID.
self=$("$real" ps -q --no-trunc --filter "id=${HOSTNAME:?}")
[[ $self =~ ^[0-9a-f]{64}$ ]] || fail "the real CLI didn't find this container from HOSTNAME $HOSTNAME"
name=$("$real" inspect --format '{{.Name}}' "$self")
name=${name#/}
"$real" pull -q "$image" >/dev/null

start
start
mine() { docker ps "$@" --no-trunc --filter "label=$label" --format '{{.ID}}' | sort; }
selfs() { docker ps "$@" --no-trunc --filter "id=$self" --format '{{.ID}}'; }
for flags in '' -a -q -aq '-n 5' -l "--format {{.Names}}"; do
  # shellcheck disable=SC2086 # one flag a word
  ! docker ps $flags --no-trunc | grep -qwF -e "$self" -e "$name" || fail "docker ps $flags lists this container"
done
[[ -z $(selfs) && -z $(selfs -a) ]] || fail 'docker ps --filter id=<this container> lists it'
[[ $(docker ps -q --filter "id=$self" | wc -l) == 0 ]] || fail 'docker ps -q lists it'
[[ $(mine | wc -l) == 2 ]] || fail "docker ps doesn't list the job's two containers"
[[ $(docker ps --filter "label=$label" | wc -l) == 3 ]] || fail 'docker ps lost its header or a row'
[[ $(docker ps --filter "id=$self" | wc -l) == 1 ]] || fail 'docker ps of this container alone printed more than the header'
# -n counts the newest containers but this one, as the real CLI lists them.
want=$("$real" ps -a -q --no-trunc | grep -vxF "$self" | head -n 3)
[[ $(docker ps -n 3 -q --no-trunc) == "$want" ]] || fail 'docker ps -n 3 differs from the real three newest but this one'
echo 'docker ps lists the job'"'"'s containers, never this one'

err=$(docker kill "$self" "${jobs[0]}" 2>&1 >/dev/null)
[[ $err == "backmesh: skipped the runner's own container" ]] || fail "docker kill printed: $err"
[[ $("$real" inspect --format '{{.State.Running}}' "${jobs[0]}") == false ]] || fail "docker kill skipped the job's container"
docker rm -f "${self:0:12}" "${jobs[0]}" >/dev/null 2>&1
! "$real" inspect "${jobs[0]}" >/dev/null 2>&1 || fail "docker rm -f didn't remove the job's container"
docker stop -t 1 "$name" "/$name" "${jobs[1]}" >/dev/null 2>&1
[[ $(mine) == "" ]] || fail "docker stop didn't stop the job's container"
docker rename "$name" renamed 2>/dev/null
start
docker update --cpus 1 "$name" "${jobs[-1]}" >/dev/null 2>&1
docker restart -t 1 "$self" "${jobs[-1]}" >/dev/null 2>&1
docker container kill "${self:0:12}" "${jobs[-1]}" >/dev/null 2>&1
[[ $(mine) == "" ]] || fail "docker container kill didn't kill the job's container"
[[ $("$real" inspect --format '{{.Name}}' "$self") == "/$name" ]] || fail 'docker rename renamed this container'
start
# shellcheck disable=SC2046 # one ID a word
docker rm -f $(docker ps -aq --filter "label=$label") >/dev/null
[[ $(mine -a) == "" ]] || fail "docker rm -f \$(docker ps -aq) left the job's containers"
[[ $("$real" inspect --format '{{.State.Running}}' "$self") == true ]] || fail 'this container stopped'
echo 'docker kill, rm, stop, rename, update, restart and container kill skip this container by ID, prefix and name, and act on the rest'

# Everything else is the real CLI's: input, output and exit status.
[[ $(echo backmesh | docker run --rm -i "$image" cat) == backmesh ]] || fail "docker run -i didn't pass its input"
status=0
docker run --rm "$image" sh -c 'exit 7' || status=$?
((status == 7)) || fail "docker run exited $status, not 7"
echo 'Other commands keep their input, output and exit status'
