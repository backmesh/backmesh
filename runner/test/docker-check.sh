#!/usr/bin/env bash
# Runs inside the built runner image as uid 1001 with the host's Docker
# socket, as a runner VM Job uses its VM's Docker (image.yml's check): a
# container, one with memory and CPU limits, K3s, which anycloud's
# local-cluster suites run, and a `-v` of a file under /tmp,
# /var/tmp, /mnt, HOME and RUNNER_TEMP, which must read as that file on the
# host's Docker. The binds are the listener's runner Job's (image.yml):
# Run: docker run -i --rm --user 1001 --group-add <socket gid> -v /var/run/docker.sock:/var/run/docker.sock -v /tmp:/tmp -v /var/tmp:/var/tmp -v /mnt:/mnt -v /workspace:/workspace -e RUNNER_TEMP --entrypoint bash <image> -s <runner/test/docker-check.sh
set -euo pipefail

docker run --rm mirror.gcr.io/library/hello-world:latest >/dev/null
echo 'A container started through the host Docker as the runner user'

# A path the host doesn't have becomes an empty directory there, and reading
# it fails with EISDIR (anycloud's api-startup reaping check). The runner's
# own share_paths runs first, as the runner does before its job.
# shellcheck source=runner/runner-job.sh
source /usr/local/bin/runner-job
share_paths
# Pulled first and quietly: the read below compares cat's output only.
docker pull -q mirror.gcr.io/library/busybox:1.37 >/dev/null
for base in /tmp /var/tmp /mnt "$HOME" "${RUNNER_TEMP:?}"; do
  dir=$(mktemp -d "$base/mount-check.XXXXXX")
  echo backmesh >"$dir/file"
  chmod -R a+rX "$dir"
  got=$(docker run --rm -v "$dir/file:/check/file:ro" mirror.gcr.io/library/busybox:1.37 cat /check/file 2>&1) || true
  rm -rf "$dir"
  [[ $got == backmesh ]] || { echo "A file under $base, mounted with -v, read as: $got" >&2; exit 1; }
done
echo 'A file under /tmp, /var/tmp, /mnt, HOME and RUNNER_TEMP, mounted with -v, reads as itself'

# ssh reads ~ from the passwd entry: it must be HOME.
[[ $(getent passwd "$(id -un)" | cut -d: -f6) == "$HOME" ]] || { echo "The runner user's passwd home isn't HOME ($HOME)" >&2; exit 1; }
mkdir -p "$HOME/.ssh"
printf 'Host backmesh-check\n  User backmesh-check-user\n' >"$HOME/.ssh/config"
[[ $(ssh -G backmesh-check | awk '$1 == "user" { print $2 }') == backmesh-check-user ]] || { echo "ssh doesn't read $HOME/.ssh/config" >&2; exit 1; }
rm -f "$HOME/.ssh/config"
echo 'ssh reads HOME/.ssh'

limit=$(docker run --rm --memory 64m --cpus 0.5 mirror.gcr.io/library/busybox:1.37 cat /sys/fs/cgroup/memory.max)
[[ $limit == 67108864 ]] || { echo "A container with --memory 64m got memory.max $limit" >&2; exit 1; }
echo 'A container with --memory and --cpus limits started'

# The image the anycloud local-cluster suites run (test/integration/e2e/internal/substrates/local-cluster/constants.ts).
name=k3s-check
trap 'docker rm -fv "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" --privileged \
  mirror.gcr.io/rancher/k3s:v1.35.5-k3s1@sha256:2074403abe1bded11ef3dde09d457e13be8e0b64c218b1c4f8269b4565cfbc65 \
  server --disable=traefik,metrics-server,local-storage >/dev/null
for _ in $(seq 90); do
  if docker exec "$name" kubectl get nodes --no-headers 2>/dev/null | grep -qw Ready; then
    echo 'K3s started and its node is Ready'
    exit 0
  fi
  sleep 2
done
echo "K3s's node isn't Ready after 3 minutes; the end of its log:" >&2
docker logs --tail 40 "$name" >&2
exit 1
