# Build benchmarks

How long five open-source builds take on backmesh's runners and on GitHub's
`ubuntu-latest`, from the job's queueing to its end, without a cache and with
backmesh's automatic caches, and where a job's cold start goes.
[backmesh.com/benchmarks](https://backmesh.com/benchmarks/) has the published
results.

[`bench.yml`](bench.yml) has five jobs, each checking out a pinned release of
a public project and building it:

- **docker**: `docker build` of [grafana/k6](https://github.com/grafana/k6)
  v0.54.0's image.
- **rust**: `cargo build --release --locked` of
  [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) 14.1.1.
- **typescript**: `npm ci` and `npx hereby local` of
  [microsoft/TypeScript](https://github.com/microsoft/TypeScript) v5.6.3.
- **python**: `uv sync --frozen` and three test files of
  [pydantic/pydantic](https://github.com/pydantic/pydantic) v2.11.7, on
  Python 3.12.
- **go**: `go build ./...` and `go test ./pkg/cmd/pr/...` of
  [cli/cli](https://github.com/cli/cli) v2.62.0.

No step caches anything: `setup-node`'s, `setup-go`'s and `setup-uv`'s own
caches are off, so a warm run gets only what backmesh caches without a
workflow change.

## Running it

[`run.ts`](run.ts) runs rounds in a repository in an org with a backmesh
installation, [backmesh/benchmarks](https://github.com/backmesh/benchmarks) for
ours, on each label at once:

```sh
GITHUB_TOKEN=$(gh auth token) TARGET_REPO=backmesh/benchmarks \
LABELS='backmesh-4 ubuntu-latest' ROUNDS=5 \
BACKMESH_VERSION=0.5.5 ANYCLOUD_VERSION=0.1.80 \
INSTALLATION='backmesh org CI, AWS' node benchmarks/builds/run.ts
node benchmarks/builds/report.ts
```

The token needs write access to the target. Set the versions to the
installation's, as `backmesh status` or its last `backmesh upgrade` reports
them: neither a job nor the token can read them. Each round pushes `bench.yml`,
with the label for `runs-on`, to a new branch `builds/<label>/<time>`: that
run is **cold**, as the new branch has no caches and the default branch none of
this workflow's. A minute after it ends, for its caches' uploads, an empty
commit to the same branch starts the **warm** run, which restores what the cold
run's jobs saved. So the warm run models a second push to the same branch,
which reads its own branch's caches; a new pull request's branch reads the
default branch's instead. The round's figures go to
`results/<date>-<backmesh version>.json` after each round, and its branch is
deleted. [`report.ts`](report.ts) writes the results below from every file in
[`results/`](results/).

**Re-run it before a release that touches the runners' start-up, the cache or
scheduling**, on the release's installation, and commit the results file and
the README.

## Figures

From GitHub's job and step times, in whole seconds, and, on backmesh's runners,
the start-up marks the runner writes (`runner/runner-job.sh`), which the
**Marks** step prints:

- **Queued to done**: the job's `created_at` to its `completed_at`: what a
  user waits for.
- **Queued to first step**: `created_at` to the Marks step's start, split
  into pieces: queued to the listener submitting the runner, the VM's launch
  (to its kernel's start), the OS's boot, Docker's install and the runner
  image's pull and start (to the container's first process), the runner
  connecting to GitHub, GitHub assigning the job (`started_at`), Set up job
  (downloading the actions), the cache hold (Set up runner waiting for the
  automatic restores, before 0.5.7), and the rest of Set up runner. A piece that ended
  before the job queued, as on a runner a cue or the planner started early,
  counts 0. GitHub's runners give only the assignment and the setup.
  The kernel's start (`/proc/stat`'s `btime`) is in whole seconds, and the
  submit time is the listener's clock while the later marks are the VM's, so
  the VM's two pieces can each be off by a second.
- **First step to done**: the checkouts and the build.

Not seen: when the listener heard GitHub's JobStarted message, which can come
seconds after the job started
([backmesh#94](https://github.com/backmesh/backmesh/pull/94)), as it's only in
the listener's log, in the installation's cloud.

The automatic caches hold the tools that `setup-*` actions install and npm's,
Yarn's and pnpm's downloads, so the warm runs restore Node for typescript,
Python for python and Go for go, and npm's cache for typescript; uv's, Go's
module and build caches, Cargo's and Docker's layers aren't kept.
`ubuntu-latest` has no automatic cache, so its warm runs repeat its cold
ones. In a public repository, as backmesh/benchmarks is, `ubuntu-latest` has
4 vCPUs and is free; in a private one it has 2. `backmesh-2` has 2 vCPUs and 8
GiB, `backmesh-4` 4 vCPUs and 16 GiB.

## Results

On v0.5.5 the warm runs restored almost nothing: 1 of the 50 warm jobs on
`backmesh-4` and `backmesh-2` restored an automatic cache. The others waited
the full 10 s for the job's cache token and started without one, so warm is
about the same as cold, and the cache hold below is that timeout.

On v0.5.6 the token still came after the 10 s in every warm job, so every
warm job skipped its tools (Node, Go, Python and uv) and the cache hold is
still that timeout. npm's cache, now restored in the background, came in 9 of
the 10 warm typescript jobs, 13 to 22 s after the job started and before
`npm ci`, but the build wasn't measurably faster. Only cold jobs whose runner was
already up when the job queued got the token within the hold.

On v0.5.7 nothing holds the job, so queued to first step dropped by the hold's
9 to 10 s, to 35 to 38 s, and most builds' totals by about as much; the other
pieces and the builds' own times didn't change. The tools now restore in the
background, but the cache token came a median 18 s into the job on
`backmesh-4` and 15 s on `backmesh-2`, after `setup-node` and `setup-go` had
made their directories, so the tools gave way in 18 of the 20 warm Node and Go
jobs. Only jobs whose runner was already up when they queued, 14 of
`backmesh-2`'s 50 and none of `backmesh-4`'s, got the token at once, and those
restored: Go's and Python's 222 and 308 MB in under 2 s, and that Python build
took 12 s rather than 17. npm's cache came in 2 of the 10 warm typescript jobs
and gave way to `npm ci` in 7. Python jobs end about 15 s in, often before the
token comes, so their Complete runner step prints no cache line.

<!-- results:start -->

Generated by [`report.ts`](report.ts) from [`results/`](results/); don't edit by hand.

### Latest: 2026-11-23, backmesh 0.5.7

backmesh 0.5.7 on anycloud 0.1.80, backmesh org CI, AWS;
5 rounds on each label in [backmesh/benchmarks](https://github.com/backmesh/benchmarks),
from bench.yml at dfe01a3. Medians, in seconds.

**Queued to done** (queued to first step + first step to done):

| Build      | backmesh-4, cold    | backmesh-4, warm    | ubuntu-latest, cold | ubuntu-latest, warm | backmesh-2, cold     | backmesh-2, warm     |
| ---------- | ------------------- | ------------------- | ------------------- | ------------------- | -------------------- | -------------------- |
| docker     | 105 s (35 s + 69 s) | 107 s (35 s + 71 s) | 98 s (4 s + 94 s)   | 101 s (4 s + 98 s)  | 141 s (39 s + 103 s) | 136 s (35 s + 103 s) |
| go         | 84 s (35 s + 48 s)  | 82 s (34 s + 48 s)  | 68 s (5 s + 64 s)   | 56 s (4 s + 51 s)   | 121 s (37 s + 82 s)  | 118 s (35 s + 83 s)  |
| python     | 53 s (36 s + 17 s)  | 53 s (37 s + 16 s)  | 23 s (5 s + 18 s)   | 22 s (5 s + 18 s)   | 55 s (37 s + 17 s)   | 54 s (37 s + 18 s)   |
| rust       | 87 s (35 s + 49 s)  | 86 s (34 s + 49 s)  | 36 s (4 s + 32 s)   | 38 s (4 s + 34 s)   | 149 s (38 s + 111 s) | 121 s (37 s + 85 s)  |
| typescript | 70 s (36 s + 34 s)  | 69 s (35 s + 34 s)  | 47 s (4 s + 43 s)   | 41 s (3 s + 38 s)   | 84 s (40 s + 43 s)   | 80 s (38 s + 42 s)   |

**Queued to the first step, by piece.** Each piece's median, over every
build's jobs; the pieces' medians needn't add up to the total's.

| Piece                                                | backmesh-4, cold | backmesh-4, warm | ubuntu-latest, cold | ubuntu-latest, warm | backmesh-2, cold | backmesh-2, warm |
| ---------------------------------------------------- | ---------------- | ---------------- | ------------------- | ------------------- | ---------------- | ---------------- |
| Queued to runner submitted                           | 2 s              | 2 s              | n/a                 | n/a                 | 2 s              | 2 s              |
| VM launched (submitted to kernel start)              | 10 s             | 9 s              | n/a                 | n/a                 | 9 s              | 8 s              |
| OS boot, Docker install, image pull, container start | 19 s             | 19 s             | n/a                 | n/a                 | 21 s             | 20 s             |
| Runner connected to GitHub                           | 3 s              | 3 s              | n/a                 | n/a                 | 3 s              | 3 s              |
| GitHub assigned the job                              | 0 s              | 1 s              | 3 s                 | 2 s                 | 1 s              | 1 s              |
| Set up job (actions downloaded)                      | 2 s              | 2 s              | n/a                 | n/a                 | 2 s              | 2 s              |
| Cache hold (automatic restores)                      | n/a              | n/a              | n/a                 | n/a                 | n/a              | n/a              |
| Rest of the setup, to the first step                 | 0 s              | 0 s              | 2 s                 | 2 s                 | 0 s              | 0 s              |
| **Queued to first step**                             | **36 s**         | **35 s**         | **5 s**             | **4 s**             | **38 s**         | **36 s**         |

`backmesh-4` ran on m8i.xlarge in aws us-east-2 (50). `backmesh-2` ran on m8i.large in aws us-east-2 (50). Warm jobs on `backmesh-4` that restored an automatic cache: docker 0 of 5, go 0 of 5, python 0 of 5, rust 0 of 5, typescript 0 of 5. Warm jobs on `backmesh-2` that restored an automatic cache: docker 0 of 5, go 1 of 5, python 1 of 5, rust 0 of 5, typescript 2 of 5.

The runs, a cold and a warm one a round:

- `backmesh-4`: [cold](https://github.com/backmesh/benchmarks/actions/runs/45099514365) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45099786483), [cold](https://github.com/backmesh/benchmarks/actions/runs/45099992945) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45100291887), [cold](https://github.com/backmesh/benchmarks/actions/runs/45100490570) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45100798142), [cold](https://github.com/backmesh/benchmarks/actions/runs/45100979655) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45101258377), [cold](https://github.com/backmesh/benchmarks/actions/runs/45101454496) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45101739974)
- `ubuntu-latest`: [cold](https://github.com/backmesh/benchmarks/actions/runs/45099514434) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45099762791), [cold](https://github.com/backmesh/benchmarks/actions/runs/45099943236) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45100195524), [cold](https://github.com/backmesh/benchmarks/actions/runs/45100400369) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45100700071), [cold](https://github.com/backmesh/benchmarks/actions/runs/45100858394) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45101151427), [cold](https://github.com/backmesh/benchmarks/actions/runs/45101357083) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45101612859)
- `backmesh-2`: [cold](https://github.com/backmesh/benchmarks/actions/runs/45099514445) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45099861541), [cold](https://github.com/backmesh/benchmarks/actions/runs/45100062616) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45100360015), [cold](https://github.com/backmesh/benchmarks/actions/runs/45100623535) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45100990921), [cold](https://github.com/backmesh/benchmarks/actions/runs/45101258773) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45101586937), [cold](https://github.com/backmesh/benchmarks/actions/runs/45101833077) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45102164371)

### By version

Medians over every build's jobs, so they mix the builds: compare a label
across versions only while bench.yml's builds are the same.

| Date       | backmesh | anycloud | Label         | Jobs | Wait, cold | Wait, warm | Total, cold | Total, warm |
| ---------- | -------- | -------- | ------------- | ---- | ---------- | ---------- | ----------- | ----------- |
| 2026-11-22 | 0.5.5    | 0.1.80   | backmesh-4    | 50   | 44 s       | 44 s       | 89 s        | 88 s        |
| 2026-11-22 | 0.5.5    | 0.1.80   | ubuntu-latest | 50   | 4 s        | 4 s        | 41 s        | 41 s        |
| 2026-11-22 | 0.5.5    | 0.1.80   | backmesh-2    | 50   | 47 s       | 48 s       | 128 s       | 130 s       |
| 2026-11-22 | 0.5.6    | 0.1.80   | backmesh-4    | 50   | 43 s       | 45 s       | 83 s        | 89 s        |
| 2026-11-22 | 0.5.6    | 0.1.80   | ubuntu-latest | 50   | 4 s        | 4 s        | 44 s        | 46 s        |
| 2026-11-22 | 0.5.6    | 0.1.80   | backmesh-2    | 50   | 47 s       | 48 s       | 129 s       | 99 s        |
| 2026-11-23 | 0.5.7    | 0.1.80   | backmesh-4    | 50   | 36 s       | 35 s       | 82 s        | 81 s        |
| 2026-11-23 | 0.5.7    | 0.1.80   | ubuntu-latest | 50   | 5 s        | 4 s        | 47 s        | 43 s        |
| 2026-11-23 | 0.5.7    | 0.1.80   | backmesh-2    | 50   | 38 s       | 36 s       | 107 s       | 89 s        |

<!-- results:end -->

The 2026-11-18 figures, on backmesh v0.4.x with three builds, from before
this history, are in
[this file's history](https://github.com/backmesh/backmesh/blob/b5119e22/benchmarks/builds/README.md).
