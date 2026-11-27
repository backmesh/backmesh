#!/usr/bin/env bash
# One probe job on a fresh runner VM: pulls TODAY and RUST (images by digest)
# in a random order, each into its own empty dockerd (docker:dind at the host
# daemon's version, its store a volume on the host's disk, the host's
# daemon.json), then times Rust's first use on this job's own image. Writes
# one JSON object to $OUT.
set -euo pipefail

host=$(docker version -f '{{.Server.Version}}')
config=$(docker run --rm -v /etc/docker:/h:ro mirror.gcr.io/library/busybox:1.37 cat /h/daemon.json 2>/dev/null || echo '{}')
echo "host docker $host, driver $(docker info -f '{{.Driver}}'), daemon.json: $config"
docker pull -q "mirror.gcr.io/library/docker:$host-dind" >/dev/null
printf '%s\n' "$config" >"$RUNNER_TEMP/daemon.json"

now() { echo "${EPOCHREALTIME/./}"; }
pull() {
  local name=bench-dind-$1 image=$2 start end
  docker run -d --privileged --name "$name" -e DOCKER_TLS_CERTDIR= \
    -v "$name:/var/lib/docker" -v "$RUNNER_TEMP/daemon.json:/etc/docker/daemon.json:ro" \
    "mirror.gcr.io/library/docker:$host-dind" >/dev/null
  until docker exec "$name" docker info >/dev/null 2>&1; do sleep 0.2; done
  echo "$GHCR_TOKEN" | docker exec -i "$name" docker login ghcr.io -u x --password-stdin >/dev/null 2>&1
  echo "dind $1: driver $(docker exec "$name" docker info -f '{{.Driver}}')" >&2
  start=$(now)
  docker exec "$name" docker pull -q "$image" >/dev/null
  end=$(now)
  docker rm -fv "$name" >/dev/null
  docker volume rm "$name" >/dev/null
  echo $(((end - start) / 1000))
}

if ((RANDOM % 2)); then
  order=rust today_ms=0 rust_ms=$(pull rust "$RUST")
  today_ms=$(pull today "$TODAY")
else
  order=today today_ms=$(pull today "$TODAY")
  rust_ms=$(pull rust "$RUST")
fi

# What #160 saves a Rust job: the first call's pinned rustup install.
start=$(now)
cargo --version
rust_first_use_ms=$((($(now) - start) / 1000))

printf '{"cloud":"%s","index":%s,"order":"%s","today_ms":%s,"rust_ms":%s,"rust_first_use_ms":%s,"docker":"%s","marks":"%s"}\n' \
  "$CLOUD" "$INDEX" "$order" "$today_ms" "$rust_ms" "$rust_first_use_ms" "$host" \
  "$(tr '\n' ';' <"${BACKMESH_JOB_MARKS:-/dev/null}")" | tee "$OUT"
