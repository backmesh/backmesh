# Docker layer cache spike

Whether `docker build` can keep its layer cache in the runner region's cache
bucket on the per-job cache token, without a workflow change, and how much
faster that makes builds (CI speed #97, row C20, owner-approved 2026-11-26).
This is a spike: the setup runs as a job step here, not in the runner image's
automatic caches.

[`setup.sh`](setup.sh) starts the loopback registry and puts the
[`docker`](docker) shim first on the job's PATH. The shim runs a
`docker build` or `docker buildx build` with BuildKit's registry cache,
`mode=max` and `ignore-error=true`, on
`127.0.0.1:4231/backmesh-cache:<tag>`, one tag for each job, directory,
Dockerfile and target. It steps aside, running the command unchanged, when
the build names its own `--builder`, `--cache-from` or `--cache-to`, when
`BUILDX_BUILDER` is set, with `DOCKER_BUILDKIT=0`, with
`BACKMESH_AUTO_CACHE=false`, or when the setup didn't finish.

The runners' Docker (29.9.3 on AWS) has the containerd image store, so its
own builder (buildx's `docker` driver) exports the cache, and the build is
otherwise the job's own: the same builder, image store and local images. A
Docker with the classic store fails any `--cache-to` (`Cache export is not
supported for the docker driver`), so there, or with
`BACKMESH_DOCKER_CACHE=container`, setup.sh makes a `docker-container`
builder, `backmesh-cache`, on the VM's network and loading its results into
the VM's Docker (`default-load`), and the shim builds there.

[`proxy.ts`](proxy.ts), bundled to [`dist/proxy.mjs`](dist/proxy.mjs) with

```sh
bun build experiments/docker-cache/proxy.ts --target node --format esm --minify-syntax --outfile experiments/docker-cache/dist/proxy.mjs
```

is that registry, over `openStore` (`src/cache/store.ts`). CI doesn't check
the committed bundle against `proxy.ts`, so rebuild it after a change. Each
request reads the token file again. A read looks under the own, then the
base, then the default ref's `docker/` prefix, and a write goes to own only.
Before the token is ready, or on a ref with no own prefix, a read misses and
a write is accepted and dropped. The import reads the build's manifest once,
first, so that read waits up to 30 s for a pending token. On SIGTERM it
writes its counts to a file.

What the proxy has to get right, as BuildKit (v0.26.3, buildx 0.19) behaved
in local tests:

| Proxy                                       | The build                                                |
| ------------------------------------------- | -------------------------------------------------------- |
| No token, or a manifest that isn't there    | Passes, without the cache                                |
| Not listening, with `ignore-error=true`     | Passes, without the cache                                |
| Not listening, without `ignore-error`       | Fails: `error writing layer blob ... connection refused` |
| Accepts connections but never answers       | Hangs: killed after 300 s                                |
| Serves a manifest whose layer blob is gone  | Fails: `failed to copy: ... not found`                   |
| Serves a manifest whose config blob is gone | Passes, without the cache                                |

So the proxy answers a lookup within 20 s or as a miss. It serves a manifest
only when every blob it names is listed under the same ref's prefix, as a
blob can be swept before its manifest. An export's existence check (`HEAD`)
counts own's blobs only, so own's manifest never relies on another ref's.
For a local try without a cloud, `DOCKER_CACHE_LOCAL_STORE=<dir>` stores the
objects in a directory, with any ready token file.

[`clouds.ts`](clouds.ts) runs [`target/docker-cache.yml`](target/docker-cache.yml)
on each of e2e.yml's test-org legs when it's dispatched with
`dockercache=true`:

```sh
gh workflow run e2e.yml -f org=backmesh-dryrun -f version=v0.7.2 -f dockercache=true
```

The job builds healthchecks' image three rounds, each in a random order of
`off` (the VM's Docker, its build cache and images cleared first) and,
through the cache on a new tag and a new builder each, cold, warm and after a
small source change. The check passes when every build did, the proxy wrote
without errors and each warm build had `CACHED` steps.

## A/B

[`bench-docker.yml`](../../benchmarks/builds/bench-docker.yml) has two builds:
grafana/k6 v0.54.0's image, whose Dockerfile copies the whole checkout,
`.git` included, before its `go build`, and healthchecks v5.0.3's
`docker/Dockerfile`, which installs its apt packages and builds its Python
wheels before it copies the source. run.ts runs them on three arms,
`<label>/docker-off`, `docker-on` and `docker-container`, each round on a new
branch: cold, warm (an empty commit), and changed (a comment appended to one
source file). The arms' runs of a state are pushed together, in a random
order.

```sh
GITHUB_TOKEN=$(gh auth token) TARGET_REPO=backmesh/benchmarks EXPERIMENT=docker-cache \
LABELS='backmesh-ubuntu-2404-4vcpu/docker-off backmesh-ubuntu-2404-4vcpu/docker-on backmesh-ubuntu-2404-4vcpu/docker-container' \
ROUNDS=8 BACKMESH_VERSION=0.7.2 ANYCLOUD_VERSION=0.1.84 INSTALLATION='backmesh org CI, AWS' \
node benchmarks/builds/run.ts
node experiments/docker-cache/analyze.ts benchmarks/builds/results/experiments/<date>-<version>-docker-cache.json
```

[`results/`](results/) has the 2026-11-27 run, 8 rounds on our CI installation
(backmesh 0.7.2, every job on an `m8a.xlarge` in us-east-1 with Docker
29.9.3's containerd image store), and a 1-round sanity run before it, whose
`docker-builder` arm is the docker-container builder without a cache. Its
`docker-on` arm is the later `docker-container`. In the 8-round run, every
`docker-on` job failed its Report step, which read a builder log that arm
doesn't make, after the build had passed; analyze.ts counts a job whose image
was built. The pull request has the tables and the go/no-go.
