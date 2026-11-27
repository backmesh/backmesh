#!/usr/bin/env bash
# The spike's setup, as a job step before the job's own (README.md): starts
# the loopback proxy and puts the `docker` shim first on the job's PATH. On
# a VM's Docker with the containerd image store, its own builder exports the
# cache. On one without, or with BACKMESH_DOCKER_CACHE=container, it makes
# the docker-container builder `backmesh-cache` on the VM's network, loading
# into the VM's Docker by default, and the shim builds there. A step that
# fails leaves the job's builds as they were: the shim steps aside without
# its `ready` file.
#
#   setup.sh <work dir>
set -uo pipefail
here=$(dirname "$(readlink -f "$0")")
work=$1
mkdir -p "$work/bin"
cp "$here/docker" "$work/bin/docker"
echo "$work/bin" >>"$GITHUB_PATH"
start=$(date +%s%3N)
nohup node "$here/dist/proxy.mjs" 4231 "$work/proxy.json" >"$work/proxy.log" 2>&1 &
echo $! >"$work/proxy.pid"
for _ in $(seq 50); do curl -sf -o /dev/null http://127.0.0.1:4231/v2/ && break; sleep 0.2; done
if ! curl -sf -o /dev/null http://127.0.0.1:4231/v2/; then
  echo "::warning::the Docker cache proxy isn't listening, so builds run without it"
  cat "$work/proxy.log"
  echo "docker-cache-setup $(($(date +%s%3N) - start)) ms, ready no"
  exit 0
fi
store=$(docker info --format '{{range .DriverStatus}}{{index . 1}} {{end}}' 2>/dev/null)
if [[ ${BACKMESH_DOCKER_CACHE:-} == container || $store != *io.containerd.snapshotter* ]]; then
  cat >"$work/buildkitd.toml" <<'TOML'
[registry."127.0.0.1:4231"]
  http = true
TOML
  docker buildx create --name backmesh-cache --driver docker-container \
    --driver-opt network=host,default-load=true,image=mirror.gcr.io/moby/buildkit:v0.26.3 \
    --buildkitd-config "$work/buildkitd.toml" \
    --buildkitd-flags '--allow-insecure-entitlement network.host' --bootstrap >"$work/builder.log" 2>&1 &&
    echo backmesh-cache >"$work/bin/builder" || rm -f "$work/bin/builder"
  [[ -f $work/bin/builder ]] || { echo "docker-cache-setup $(($(date +%s%3N) - start)) ms, ready no"; exit 0; }
fi
touch "$work/bin/ready"
echo "docker-cache-setup $(($(date +%s%3N) - start)) ms, ready $([[ -f $work/bin/ready ]] && echo yes || echo no)"
