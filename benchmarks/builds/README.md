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

[`bench-cache.yml`](bench-cache.yml) runs the same builds, each caching what it
downloads and builds, for a `<label>/cache` arm: Cargo's registry and
`target`, npm's, uv's, and Go's module and build caches, and Docker's layers.
On GitHub's runners it uses GitHub's cache, through `actions/cache` (which
`setup-*`'s own `cache:` uses) and Docker's `type=gha`; on backmesh's,
`backmesh/cache`, with Docker's layers in a local cache directory. Its Cache
hits step prints whether each job's cache hit, and the Docker build prints its
`CACHED` steps.

## Running it

[`run.ts`](run.ts) runs rounds in a repository in an org with a backmesh
installation, [backmesh/benchmarks](https://github.com/backmesh/benchmarks) for
ours, on each label at once:

```sh
GITHUB_TOKEN=$(gh auth token) TARGET_REPO=backmesh/benchmarks \
LABELS='backmesh-4 ubuntu-latest backmesh-4/cache ubuntu-latest/cache' ROUNDS=5 \
BACKMESH_VERSION=0.5.5 ANYCLOUD_VERSION=0.1.80 \
INSTALLATION='backmesh org CI, AWS' node benchmarks/builds/run.ts
node benchmarks/builds/report.ts
```

The token needs write access to the target. Set the versions to the
installation's, as `backmesh status` or its last `backmesh upgrade` reports
them: neither a job nor the token can read them. Each round pushes `bench.yml`,
with the label for `runs-on`, to a new branch `builds/<label>/<time>` (`builds/<label>/cache/<time>` for a
cache arm): that
run is **cold**, as the new branch has no caches and the default branch none of
this workflow's. A minute after it ends, for its caches' uploads, an empty
commit to the same branch starts the **warm** run, which restores what the cold
run's jobs saved. So the warm run models a second push to the same branch,
which reads its own branch's caches; a new pull request's branch reads the
default branch's instead. The round's figures go to
`results/<date>-<backmesh version>.json` after each round, and its branch is
deleted. A run that isn't a release's figures, such as one with extra arms,
sets `EXPERIMENT=<name>` and goes to
`results/experiments/<date>-<version>-<name>.json` instead, which
backmesh.com and the trend below leave out. [`report.ts`](report.ts) writes
the results below from every file in [`results/`](results/).

**Re-run it before a release that touches the runners' start-up, the cache or
scheduling**, on the release's installation, and commit the results file and
the README. A release that claims a speedup runs it once on its rc before the
final tag and compares it with the last release's results file, re-running the
last release only if the benchmark changed since; it claims only the gain it
measures.

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
4 vCPUs and is free; in a private one it has 2. `backmesh-<n>` has n vCPUs and 4 GiB
each, on AWS an `m8i` VM first (Intel Xeon 6), then `m7a`, `m7i` and `m6a`. The
Marks step prints each job's CPU model (`lscpu`), so a result shows which CPUs
each label ran on.

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

On 2026-11-23's second v0.5.7 run, an experiment
(`experiments/2026-11-23-0.5.7-cores.json`), `backmesh-8`, `backmesh-16` and
three cache arms ran alongside `backmesh-4` and `ubuntu-latest`, interleaved,
so the seven arms' jobs contended for the installation at once. The figures
below are the cold medians over 5 rounds.

- **More cores speed up the build itself, but not the wait.** From the first step to done,
  `backmesh-16` was 2.8× `ubuntu-latest` on go, 1.8× on docker and 1.6× on
  typescript. On rust and python there was no measurable difference: their
  1.3× medians are within the rounds' spread. Each job still waits 40 to 45 s for
  its VM, against `ubuntu-latest`'s 4 s, so from the queueing to done no label
  beat `ubuntu-latest` by more than 1.3× (go on `backmesh-16`, warm). On most
  builds they took longer.
- **What doesn't scale with cores.** Python's build stayed at 16 to 17 s on 4, 8
  and 16 vCPUs: it's `uv sync`'s downloads and a single-process pytest.
  TypeScript went from 28 s to 25 s: `hereby local` is mostly one `tsc`. Rust
  starts with 5 s installing Ubuntu's `cargo` on first use. Ubuntu's `rustc`
  is older than GitHub's. ripgrep's own crate compiles on one core for about
  17 s, so `backmesh-4` (45 s) is slower than `ubuntu-latest` (31 s), and
  `backmesh-16`'s 23 s isn't measurably faster.
- **The CPU.** `backmesh-4`, `-8` and `-16` ran on `m8i` (Intel Xeon 6975P-C)
  in 143 of 150 jobs; the other 7, on `-8` and `-16`, fell back to `m7a` (AMD EPYC
  9R14). `ubuntu-latest`'s 50 jobs ran on seven different CPUs, from AMD EPYC
  7763 to Intel Xeon 6975P-C. Its build times varied with the CPU, for example
  typescript at 44 s on the EPYC 7763 and 32 to 33 s on the EPYC 9V45 and 9V74,
  but no CPU model has more than a few jobs. AWS's 8th-generation AMD (`m8a`, `c8a`) and
  `c8i` aren't among backmesh's types, and a label can't choose a VM family.
- **Cache.** The arms cache differently, so they compare setups rather than
  caches alone: GitHub's runners use GitHub's cache and Docker's `type=gha`,
  backmesh's `backmesh/cache` and a local Docker cache directory. GitHub's
  cache hit in all 20 warm `ubuntu-latest/cache` jobs whose `cache-hit` output
  shows it; docker's `type=gha` has no such output, though its warm builds had
  5 `CACHED` steps. It brought go to 21 s and rust to 24 s, and made docker's
  `type=gha` build slower (113 s warm, 179 s cold, against 87 to 90 s
  without). `backmesh/cache` hit in 29 of 50 warm jobs, a figure that reflects
  0.5.7's late cache token more than the cache: a restore waits for the
  token, which came a median 14 s and up to 45 s into the job. 12 warm jobs had no token by
  then and fell back to GitHub's cache, which was empty. 9 more followed a cold
  job that had fallen back and so saved to GitHub's cache. When it hit, warm
  `backmesh-16/cache` builds took 19 s for go and rust, 59 s for docker and 29 s
  for typescript.
- **Cost.** At spot prices with the disk, each VM billed for at least a
  minute, a build on `backmesh-4` cost 1/6 to 1/11 of GitHub's 4-core price,
  what a private repository pays for a 4-core larger runner (a public
  repository's `ubuntu-latest`, as here, has 4 vCPUs and is free). It was 1/5
  to 1/9 on `backmesh-8` and 1/3 to 1/5 on `backmesh-16`. The fastest speedup
  per dollar: go, 2.8× faster from the first step at 1/5.3 of the price, on
  `backmesh-16`. A private repository's default `ubuntu-latest` has 2 vCPUs at
  about $0.006 to $0.008 a minute, a half to two thirds of the 4-core price:
  for as many minutes the ratios would shrink by as much, to 1/3 to 1/8 on
  `backmesh-4`, but a build on 2 vCPUs takes longer, and these runs don't
  measure it.

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

**Speed and cost a build.** Each label's medians, and their speed against
ubuntu-latest's (its time over the label's), a `/cache` arm's against
`ubuntu-latest/cache`'s. A backmesh job's cost is its VM's spot
price from the kernel's start to the job's end, at
[`cost.ts`](../../website/src/cost.ts)'s `backmesh-4` price for the VM's
family times its vCPUs over 4, plus its disk's $0.0384 an hour,
for at least a minute, as AWS bills both. ubuntu-latest's is what GitHub charges for
its 4-vCPU runner, $0.012 a minute, each job rounded up to
a whole minute: a private repository pays it for a 4-core larger runner, while
a public one's `ubuntu-latest`, as here, has 4 vCPUs and is free. A private
repository's `ubuntu-latest` has 2 vCPUs at about $0.006 to $0.008 a minute,
which these runs don't measure. Costs are medians over the cold and warm jobs.

| Build      | Label         | First step to done, cold | First step to done, warm | Queued to done, cold | Queued to done, warm | Cost a build | Price against ubuntu-latest |
| ---------- | ------------- | ------------------------ | ------------------------ | -------------------- | -------------------- | ------------ | --------------------------- |
| docker     | backmesh-4    | 69 s, 1.4×               | 71 s, 1.4×               | 105 s, 0.9×          | 107 s, 0.9×          | $0.0025      | 1/9.6                       |
| docker     | ubuntu-latest | 94 s, 1.0×               | 98 s, 1.0×               | 98 s, 1.0×           | 101 s, 1.0×          | $0.0240      | 1/1.0                       |
| docker     | backmesh-2    | 103 s, 0.9×              | 103 s, 1.0×              | 141 s, 0.7×          | 136 s, 0.7×          | $0.0024      | 1/9.8                       |
| go         | backmesh-4    | 48 s, 1.3×               | 48 s, 1.1×               | 84 s, 0.8×           | 82 s, 0.7×           | $0.0019      | 1/12.6                      |
| go         | ubuntu-latest | 64 s, 1.0×               | 51 s, 1.0×               | 68 s, 1.0×           | 56 s, 1.0×           | $0.0240      | 1/1.0                       |
| go         | backmesh-2    | 82 s, 0.8×               | 83 s, 0.6×               | 121 s, 0.6×          | 118 s, 0.5×          | $0.0021      | 1/11.4                      |
| python     | backmesh-4    | 17 s, 1.1×               | 16 s, 1.1×               | 53 s, 0.4×           | 53 s, 0.4×           | $0.0016      | 1/7.4                       |
| python     | ubuntu-latest | 18 s, 1.0×               | 18 s, 1.0×               | 23 s, 1.0×           | 22 s, 1.0×           | $0.0120      | 1/1.0                       |
| python     | backmesh-2    | 17 s, 1.1×               | 18 s, 1.0×               | 55 s, 0.4×           | 54 s, 0.4×           | $0.0011      | 1/10.7                      |
| rust       | backmesh-4    | 49 s, 0.7×               | 49 s, 0.7×               | 87 s, 0.4×           | 86 s, 0.4×           | $0.0019      | 1/6.2                       |
| rust       | ubuntu-latest | 32 s, 1.0×               | 34 s, 1.0×               | 36 s, 1.0×           | 38 s, 1.0×           | $0.0120      | 1/1.0                       |
| rust       | backmesh-2    | 111 s, 0.3×              | 85 s, 0.4×               | 149 s, 0.2×          | 121 s, 0.3×          | $0.0024      | 1/5.0                       |
| typescript | backmesh-4    | 34 s, 1.3×               | 34 s, 1.1×               | 70 s, 0.7×           | 69 s, 0.6×           | $0.0016      | 1/7.4                       |
| typescript | ubuntu-latest | 43 s, 1.0×               | 38 s, 1.0×               | 47 s, 1.0×           | 41 s, 1.0×           | $0.0120      | 1/1.0                       |
| typescript | backmesh-2    | 43 s, 1.0×               | 42 s, 0.9×               | 84 s, 0.6×           | 80 s, 0.5×           | $0.0013      | 1/9.3                       |

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

### Experiment: `experiments/2026-11-23-0.5.7-cores.json`

backmesh 0.5.7 on anycloud 0.1.80, backmesh org CI, AWS;
5 rounds on each label in [backmesh/benchmarks](https://github.com/backmesh/benchmarks),
from bench.yml at ac5e478. Medians, in seconds.

**Queued to done** (queued to first step + first step to done):

| Build      | backmesh-4, cold    | backmesh-4, warm    | backmesh-8, cold   | backmesh-8, warm   | backmesh-16, cold  | backmesh-16, warm  | ubuntu-latest, cold | ubuntu-latest, warm | backmesh-4/cache, cold | backmesh-4/cache, warm | backmesh-16/cache, cold | backmesh-16/cache, warm | ubuntu-latest/cache, cold | ubuntu-latest/cache, warm |
| ---------- | ------------------- | ------------------- | ------------------ | ------------------ | ------------------ | ------------------ | ------------------- | ------------------- | ---------------------- | ---------------------- | ----------------------- | ----------------------- | ------------------------- | ------------------------- |
| docker     | 111 s (43 s + 69 s) | 105 s (37 s + 69 s) | 92 s (36 s + 55 s) | 95 s (37 s + 56 s) | 93 s (43 s + 50 s) | 89 s (39 s + 49 s) | 94 s (4 s + 90 s)   | 91 s (4 s + 87 s)   | 144 s (39 s + 108 s)   | 156 s (47 s + 114 s)   | 124 s (40 s + 86 s)     | 111 s (43 s + 63 s)     | 186 s (5 s + 179 s)       | 118 s (5 s + 113 s)       |
| go         | 90 s (43 s + 49 s)  | 89 s (42 s + 48 s)  | 74 s (43 s + 31 s) | 72 s (41 s + 31 s) | 74 s (51 s + 23 s) | 63 s (41 s + 22 s) | 69 s (4 s + 64 s)   | 79 s (4 s + 74 s)   | 98 s (37 s + 61 s)     | 77 s (45 s + 31 s)     | 77 s (42 s + 33 s)      | 61 s (36 s + 20 s)      | 81 s (5 s + 77 s)         | 25 s (4 s + 21 s)         |
| python     | 56 s (39 s + 17 s)  | 61 s (44 s + 17 s)  | 59 s (43 s + 16 s) | 59 s (42 s + 17 s) | 64 s (47 s + 17 s) | 64 s (47 s + 17 s) | 28 s (6 s + 22 s)   | 22 s (4 s + 18 s)   | 65 s (43 s + 24 s)     | 75 s (43 s + 35 s)     | 65 s (41 s + 24 s)      | 65 s (40 s + 24 s)      | 22 s (5 s + 18 s)         | 24 s (5 s + 19 s)         |
| rust       | 87 s (42 s + 45 s)  | 83 s (39 s + 45 s)  | 68 s (39 s + 29 s) | 71 s (41 s + 29 s) | 62 s (39 s + 23 s) | 63 s (40 s + 23 s) | 34 s (4 s + 31 s)   | 36 s (4 s + 33 s)   | 100 s (41 s + 58 s)    | 103 s (37 s + 67 s)    | 76 s (42 s + 34 s)      | 69 s (42 s + 23 s)      | 37 s (4 s + 33 s)         | 28 s (4 s + 24 s)         |
| typescript | 71 s (43 s + 28 s)  | 71 s (40 s + 32 s)  | 75 s (48 s + 30 s) | 71 s (44 s + 25 s) | 75 s (46 s + 25 s) | 72 s (42 s + 30 s) | 43 s (4 s + 39 s)   | 38 s (4 s + 34 s)   | 80 s (44 s + 36 s)     | 90 s (47 s + 43 s)     | 77 s (42 s + 31 s)      | 71 s (40 s + 31 s)      | 48 s (5 s + 42 s)         | 39 s (4 s + 35 s)         |

**Speed and cost a build.** Each label's medians, and their speed against
ubuntu-latest's (its time over the label's), a `/cache` arm's against
`ubuntu-latest/cache`'s. A backmesh job's cost is its VM's spot
price from the kernel's start to the job's end, at
[`cost.ts`](../../website/src/cost.ts)'s `backmesh-4` price for the VM's
family times its vCPUs over 4, plus its disk's $0.0384 an hour,
for at least a minute, as AWS bills both. ubuntu-latest's is what GitHub charges for
its 4-vCPU runner, $0.012 a minute, each job rounded up to
a whole minute: a private repository pays it for a 4-core larger runner, while
a public one's `ubuntu-latest`, as here, has 4 vCPUs and is free. A private
repository's `ubuntu-latest` has 2 vCPUs at about $0.006 to $0.008 a minute,
which these runs don't measure. Costs are medians over the cold and warm jobs.

| Build      | Label               | First step to done, cold | First step to done, warm | Queued to done, cold | Queued to done, warm | Cost a build | Price against ubuntu-latest |
| ---------- | ------------------- | ------------------------ | ------------------------ | -------------------- | -------------------- | ------------ | --------------------------- |
| docker     | backmesh-4          | 69 s, 1.3×               | 69 s, 1.3×               | 111 s, 0.8×          | 105 s, 0.9×          | $0.0025      | 1/9.5                       |
| docker     | backmesh-8          | 55 s, 1.6×               | 56 s, 1.6×               | 92 s, 1.0×           | 95 s, 1.0×           | $0.0035      | 1/6.9                       |
| docker     | backmesh-16         | 50 s, 1.8×               | 49 s, 1.8×               | 93 s, 1.0×           | 89 s, 1.0×           | $0.0060      | 1/4.0                       |
| docker     | ubuntu-latest       | 90 s, 1.0×               | 87 s, 1.0×               | 94 s, 1.0×           | 91 s, 1.0×           | $0.0240      | 1/1.0                       |
| docker     | backmesh-4/cache    | 108 s, 1.7×              | 114 s, 1.0×              | 144 s, 1.3×          | 156 s, 0.8×          | $0.0036      | 1/9.9                       |
| docker     | backmesh-16/cache   | 86 s, 2.1×               | 63 s, 1.8×               | 124 s, 1.5×          | 111 s, 1.1×          | $0.0082      | 1/4.4                       |
| docker     | ubuntu-latest/cache | 179 s, 1.0×              | 113 s, 1.0×              | 186 s, 1.0×          | 118 s, 1.0×          | $0.0360      | 1/1.0                       |
| go         | backmesh-4          | 49 s, 1.3×               | 48 s, 1.5×               | 90 s, 0.8×           | 89 s, 0.9×           | $0.0021      | 1/11.3                      |
| go         | backmesh-8          | 31 s, 2.1×               | 31 s, 2.4×               | 74 s, 0.9×           | 72 s, 1.1×           | $0.0026      | 1/9.1                       |
| go         | backmesh-16         | 23 s, 2.8×               | 22 s, 3.4×               | 74 s, 0.9×           | 63 s, 1.3×           | $0.0045      | 1/5.3                       |
| go         | ubuntu-latest       | 64 s, 1.0×               | 74 s, 1.0×               | 69 s, 1.0×           | 79 s, 1.0×           | $0.0240      | 1/1.0                       |
| go         | backmesh-4/cache    | 61 s, 1.3×               | 31 s, 0.7×               | 98 s, 0.8×           | 77 s, 0.3×           | $0.0022      | 1/8.0                       |
| go         | backmesh-16/cache   | 33 s, 2.3×               | 20 s, 1.1×               | 77 s, 1.1×           | 61 s, 0.4×           | $0.0045      | 1/4.0                       |
| go         | ubuntu-latest/cache | 77 s, 1.0×               | 21 s, 1.0×               | 81 s, 1.0×           | 25 s, 1.0×           | $0.0180      | 1/1.0                       |
| python     | backmesh-4          | 17 s, 1.3×               | 17 s, 1.1×               | 56 s, 0.5×           | 61 s, 0.4×           | $0.0016      | 1/7.4                       |
| python     | backmesh-8          | 16 s, 1.4×               | 17 s, 1.1×               | 59 s, 0.5×           | 59 s, 0.4×           | $0.0026      | 1/4.6                       |
| python     | backmesh-16         | 17 s, 1.3×               | 17 s, 1.1×               | 64 s, 0.4×           | 64 s, 0.3×           | $0.0045      | 1/2.7                       |
| python     | ubuntu-latest       | 22 s, 1.0×               | 18 s, 1.0×               | 28 s, 1.0×           | 22 s, 1.0×           | $0.0120      | 1/1.0                       |
| python     | backmesh-4/cache    | 24 s, 0.8×               | 35 s, 0.5×               | 65 s, 0.3×           | 75 s, 0.3×           | $0.0016      | 1/7.4                       |
| python     | backmesh-16/cache   | 24 s, 0.8×               | 24 s, 0.8×               | 65 s, 0.3×           | 65 s, 0.4×           | $0.0045      | 1/2.7                       |
| python     | ubuntu-latest/cache | 18 s, 1.0×               | 19 s, 1.0×               | 22 s, 1.0×           | 24 s, 1.0×           | $0.0120      | 1/1.0                       |
| rust       | backmesh-4          | 45 s, 0.7×               | 45 s, 0.7×               | 87 s, 0.4×           | 83 s, 0.4×           | $0.0020      | 1/5.9                       |
| rust       | backmesh-8          | 29 s, 1.1×               | 29 s, 1.1×               | 68 s, 0.5×           | 71 s, 0.5×           | $0.0026      | 1/4.6                       |
| rust       | backmesh-16         | 23 s, 1.3×               | 23 s, 1.4×               | 62 s, 0.5×           | 63 s, 0.6×           | $0.0045      | 1/2.7                       |
| rust       | ubuntu-latest       | 31 s, 1.0×               | 33 s, 1.0×               | 34 s, 1.0×           | 36 s, 1.0×           | $0.0120      | 1/1.0                       |
| rust       | backmesh-4/cache    | 58 s, 0.6×               | 67 s, 0.4×               | 100 s, 0.4×          | 103 s, 0.3×          | $0.0024      | 1/5.0                       |
| rust       | backmesh-16/cache   | 34 s, 1.0×               | 23 s, 1.0×               | 76 s, 0.5×           | 69 s, 0.4×           | $0.0046      | 1/2.6                       |
| rust       | ubuntu-latest/cache | 33 s, 1.0×               | 24 s, 1.0×               | 37 s, 1.0×           | 28 s, 1.0×           | $0.0120      | 1/1.0                       |
| typescript | backmesh-4          | 28 s, 1.4×               | 32 s, 1.1×               | 71 s, 0.6×           | 71 s, 0.5×           | $0.0016      | 1/7.4                       |
| typescript | backmesh-8          | 30 s, 1.3×               | 25 s, 1.4×               | 75 s, 0.6×           | 71 s, 0.5×           | $0.0026      | 1/4.6                       |
| typescript | backmesh-16         | 25 s, 1.6×               | 30 s, 1.1×               | 75 s, 0.6×           | 72 s, 0.5×           | $0.0046      | 1/2.6                       |
| typescript | ubuntu-latest       | 39 s, 1.0×               | 34 s, 1.0×               | 43 s, 1.0×           | 38 s, 1.0×           | $0.0120      | 1/1.0                       |
| typescript | backmesh-4/cache    | 36 s, 1.2×               | 43 s, 0.8×               | 80 s, 0.6×           | 90 s, 0.4×           | $0.0018      | 1/6.6                       |
| typescript | backmesh-16/cache   | 31 s, 1.4×               | 31 s, 1.1×               | 77 s, 0.6×           | 71 s, 0.5×           | $0.0048      | 1/2.5                       |
| typescript | ubuntu-latest/cache | 42 s, 1.0×               | 35 s, 1.0×               | 48 s, 1.0×           | 39 s, 1.0×           | $0.0120      | 1/1.0                       |

**Queued to the first step, by piece.** Each piece's median, over every
build's jobs; the pieces' medians needn't add up to the total's.

| Piece                                                | backmesh-4, cold | backmesh-4, warm | backmesh-8, cold | backmesh-8, warm | backmesh-16, cold | backmesh-16, warm | ubuntu-latest, cold | ubuntu-latest, warm | backmesh-4/cache, cold | backmesh-4/cache, warm | backmesh-16/cache, cold | backmesh-16/cache, warm | ubuntu-latest/cache, cold | ubuntu-latest/cache, warm |
| ---------------------------------------------------- | ---------------- | ---------------- | ---------------- | ---------------- | ----------------- | ----------------- | ------------------- | ------------------- | ---------------------- | ---------------------- | ----------------------- | ----------------------- | ------------------------- | ------------------------- |
| Queued to runner submitted                           | 2 s              | 2 s              | 2 s              | 2 s              | 3 s               | 2 s               | n/a                 | n/a                 | 3 s                    | 2 s                    | 2 s                     | 2 s                     | n/a                       | n/a                       |
| VM launched (submitted to kernel start)              | 10 s             | 10 s             | 10 s             | 11 s             | 10 s              | 9 s               | n/a                 | n/a                 | 8 s                    | 10 s                   | 9 s                     | 7 s                     | n/a                       | n/a                       |
| OS boot, Docker install, image pull, container start | 24 s             | 24 s             | 25 s             | 23 s             | 26 s              | 24 s              | n/a                 | n/a                 | 22 s                   | 23 s                   | 23 s                    | 26 s                    | n/a                       | n/a                       |
| Runner connected to GitHub                           | 3 s              | 3 s              | 2 s              | 2 s              | 3 s               | 3 s               | n/a                 | n/a                 | 3 s                    | 3 s                    | 3 s                     | 3 s                     | n/a                       | n/a                       |
| GitHub assigned the job                              | 1 s              | 1 s              | 1 s              | 1 s              | 1 s               | 1 s               | 3 s                 | 3 s                 | 1 s                    | 1 s                    | 1 s                     | 1 s                     | 3 s                       | 2 s                       |
| Set up job (actions downloaded)                      | 2 s              | 2 s              | 2 s              | 2 s              | 2 s               | 2 s               | n/a                 | n/a                 | 3 s                    | 3 s                    | 3 s                     | 2 s                     | n/a                       | n/a                       |
| Cache hold (automatic restores)                      | n/a              | n/a              | n/a              | n/a              | n/a               | n/a               | n/a                 | n/a                 | n/a                    | n/a                    | n/a                     | n/a                     | n/a                       | n/a                       |
| Rest of the setup, to the first step                 | 0 s              | 0 s              | 0 s              | 0 s              | 0 s               | 0 s               | 1 s                 | 2 s                 | 0 s                    | 0 s                    | 0 s                     | 0 s                     | 2 s                       | 2 s                       |
| **Queued to first step**                             | **42 s**         | **40 s**         | **43 s**         | **41 s**         | **45 s**          | **41 s**          | **4 s**             | **4 s**             | **41 s**               | **44 s**               | **41 s**                | **40 s**                | **5 s**                   | **4 s**                   |

`backmesh-4` ran on m8i.xlarge in aws us-east-2, Intel(R) Xeon(R) 6975P-C, 4 vCPUs (50). `backmesh-8` ran on m8i.2xlarge in aws us-east-2, Intel(R) Xeon(R) 6975P-C, 8 vCPUs (48), m7a.2xlarge in aws us-east-2, AMD EPYC 9R14, 8 vCPUs (2). `backmesh-16` ran on m8i.4xlarge in aws us-east-2, Intel(R) Xeon(R) 6975P-C, 16 vCPUs (45), m7a.4xlarge in aws us-east-2, AMD EPYC 9R14, 16 vCPUs (5). `ubuntu-latest` ran on Intel(R) Xeon(R) 6975P-C, 4 vCPUs (6), AMD EPYC 7763 64-Core Processor, 4 vCPUs (17), AMD EPYC 9V74 80-Core Processor, 4 vCPUs (10), AMD EPYC 9V45 96-Core Processor, 4 vCPUs (10), INTEL(R) XEON(R) PLATINUM 8573C, 4 vCPUs (4), Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz, 4 vCPUs (1), Intel(R) Xeon(R) 6973P-C, 4 vCPUs (2). `backmesh-4/cache` ran on m8i.xlarge in aws us-east-2, Intel(R) Xeon(R) 6975P-C, 4 vCPUs (50). `backmesh-16/cache` ran on m8i.4xlarge in aws us-east-2, Intel(R) Xeon(R) 6975P-C, 16 vCPUs (50). `ubuntu-latest/cache` ran on Intel(R) Xeon(R) 6975P-C, 4 vCPUs (4), AMD EPYC 9V45 96-Core Processor, 4 vCPUs (12), AMD EPYC 9V74 80-Core Processor, 4 vCPUs (12), AMD EPYC 7763 64-Core Processor, 4 vCPUs (13), Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz, 4 vCPUs (4), INTEL(R) XEON(R) PLATINUM 8573C, 4 vCPUs (5). Warm jobs on `backmesh-4` that restored an automatic cache: docker 0 of 5, go 0 of 5, python 0 of 5, rust 0 of 5, typescript 1 of 5. Warm jobs on `backmesh-8` that restored an automatic cache: docker 0 of 5, go 1 of 5, python 1 of 5, rust 0 of 5, typescript 3 of 5. Warm jobs on `backmesh-16` that restored an automatic cache: docker 0 of 5, go 0 of 5, python 0 of 5, rust 0 of 5, typescript 2 of 5. Warm jobs on `backmesh-4/cache` that restored an automatic cache: docker 0 of 5, go 0 of 5, python 0 of 5, rust 0 of 5, typescript 1 of 5. Warm jobs on `backmesh-16/cache` that restored an automatic cache: docker 0 of 5, go 0 of 5, python 1 of 5, rust 0 of 5, typescript 2 of 5. Warm jobs on `backmesh-4/cache` whose cache hit: docker's build 0 CACHED steps cold and 0 warm, go 3 of 5, python 3 of 5, rust 2 of 5, typescript 4 of 5. Warm jobs on `backmesh-16/cache` whose cache hit: docker's build 0 CACHED steps cold and 6 warm, go 4 of 5, python 3 of 5, rust 3 of 5, typescript 3 of 5. Warm jobs on `ubuntu-latest/cache` whose cache hit: docker's build 0 CACHED steps cold and 5 warm, go 5 of 5, python 5 of 5, rust 5 of 5, typescript 5 of 5.

The runs, a cold and a warm one a round:

- `backmesh-4`: [cold](https://github.com/backmesh/benchmarks/actions/runs/45190919790) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45191560556), [cold](https://github.com/backmesh/benchmarks/actions/runs/45191949292) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45192460439), [cold](https://github.com/backmesh/benchmarks/actions/runs/45192806127) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45193314616), [cold](https://github.com/backmesh/benchmarks/actions/runs/45193706147) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45194258107), [cold](https://github.com/backmesh/benchmarks/actions/runs/45194649587) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45195244672)
- `backmesh-8`: [cold](https://github.com/backmesh/benchmarks/actions/runs/45190919412) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45191435456), [cold](https://github.com/backmesh/benchmarks/actions/runs/45191800277) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45192307150), [cold](https://github.com/backmesh/benchmarks/actions/runs/45192700317) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45193260454), [cold](https://github.com/backmesh/benchmarks/actions/runs/45193606700) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45194113100), [cold](https://github.com/backmesh/benchmarks/actions/runs/45194504161) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45195009570)
- `backmesh-16`: [cold](https://github.com/backmesh/benchmarks/actions/runs/45190920313) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45191435372), [cold](https://github.com/backmesh/benchmarks/actions/runs/45191797850) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45192256567), [cold](https://github.com/backmesh/benchmarks/actions/runs/45192603828) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45193205079), [cold](https://github.com/backmesh/benchmarks/actions/runs/45193554321) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45194057898), [cold](https://github.com/backmesh/benchmarks/actions/runs/45194358995) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45194854278)
- `ubuntu-latest`: [cold](https://github.com/backmesh/benchmarks/actions/runs/45190921598) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45191374899), [cold](https://github.com/backmesh/benchmarks/actions/runs/45191995487) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45192593941), [cold](https://github.com/backmesh/benchmarks/actions/runs/45192943406) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45193452567), [cold](https://github.com/backmesh/benchmarks/actions/runs/45193755942) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45194354682), [cold](https://github.com/backmesh/benchmarks/actions/runs/45194700788) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45195205748)
- `backmesh-4/cache`: [cold](https://github.com/backmesh/benchmarks/actions/runs/45190918447) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45191600309), [cold](https://github.com/backmesh/benchmarks/actions/runs/45192070891) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45192721136), [cold](https://github.com/backmesh/benchmarks/actions/runs/45193295872) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45193986358), [cold](https://github.com/backmesh/benchmarks/actions/runs/45194516963) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45195161384), [cold](https://github.com/backmesh/benchmarks/actions/runs/45195688646) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45196336535)
- `backmesh-16/cache`: [cold](https://github.com/backmesh/benchmarks/actions/runs/45190919695) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45191509362), [cold](https://github.com/backmesh/benchmarks/actions/runs/45191854577) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45192410684), [cold](https://github.com/backmesh/benchmarks/actions/runs/45192802909) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45193355061), [cold](https://github.com/backmesh/benchmarks/actions/runs/45193746252) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45194342840), [cold](https://github.com/backmesh/benchmarks/actions/runs/45194780669) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45195423629)
- `ubuntu-latest/cache`: [cold](https://github.com/backmesh/benchmarks/actions/runs/45190919342) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45191694355), [cold](https://github.com/backmesh/benchmarks/actions/runs/45192039458) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45192733735), [cold](https://github.com/backmesh/benchmarks/actions/runs/45193127140) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45193908346), [cold](https://github.com/backmesh/benchmarks/actions/runs/45194304173) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45195079485), [cold](https://github.com/backmesh/benchmarks/actions/runs/45195517135) and [warm](https://github.com/backmesh/benchmarks/actions/runs/45196208992)

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
