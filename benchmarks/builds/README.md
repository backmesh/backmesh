# Build benchmarks

How long three open-source builds take on `backmesh-2` and `backmesh-4`
runners and on GitHub's `ubuntu-latest`, and what each build costs.
[backmesh.com/benchmarks](https://backmesh.com/benchmarks/) has the results,
the method and every run.

[`bench.yml`](bench.yml) has three jobs, each checking out a pinned release of
a public project and building it:

- **Docker**: `docker build` of [grafana/k6](https://github.com/grafana/k6)
  v0.54.0's image.
- **Rust**: `cargo build --release --locked` of
  [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) 14.1.1.
- **TypeScript**: `npm ci` and `npx hereby local` of
  [microsoft/TypeScript](https://github.com/microsoft/TypeScript) v5.6.3.

The repository variable `BENCH_RUNNER` picks the runner: `backmesh-2`,
`backmesh-4` or `ubuntu-latest`. A push to the `bench` branch starts a round.

## Results

Measured on 2026-11-18 in [backmesh/benchmarks](https://github.com/backmesh/benchmarks),
then private, 5 rounds on each runner. The figures are medians: the job's
runtime, its cost a build, and its cold start, its queueing to its start.

| Build      | ubuntu-latest, 2 vCPUs | backmesh-2, 2 vCPUs  | backmesh-4, 4 vCPUs |
| ---------- | ---------------------- | -------------------- | ------------------- |
| Docker     | 148 s, $0.018, 2 s     | 102 s, $0.0026, 40 s | 71 s, $0.0032, 48 s |
| Rust       | 70 s, $0.012, 2 s      | 83 s, $0.0024, 46 s  | 49 s, $0.0027, 50 s |
| TypeScript | 56 s, $0.006, 2 s      | 44 s, $0.0016, 42 s  | 35 s, $0.0021, 43 s |

`backmesh-4` ran the builds 1.4 to 2.1× faster than `ubuntu-latest`, at 2.9
to 5.6× less per build. At the same 2 vCPUs, `backmesh-2` was faster for
Docker (1.5×) and TypeScript (1.3×) but slower for Rust (0.8×), partly the
`cargo` install on first use
([backmesh#22](https://github.com/backmesh/backmesh/issues/22)), and 3.8 to
6.9× cheaper on all three.

The runs, one a round:

- `ubuntu-latest`: [44364487787](https://github.com/backmesh/benchmarks/actions/runs/44364487787), [44365905066](https://github.com/backmesh/benchmarks/actions/runs/44365905066), [44367215179](https://github.com/backmesh/benchmarks/actions/runs/44367215179), [44368389022](https://github.com/backmesh/benchmarks/actions/runs/44368389022), [44369659562](https://github.com/backmesh/benchmarks/actions/runs/44369659562)
- `backmesh-2`: [44379996886](https://github.com/backmesh/benchmarks/actions/runs/44379996886), [44380630467](https://github.com/backmesh/benchmarks/actions/runs/44380630467), [44381256875](https://github.com/backmesh/benchmarks/actions/runs/44381256875), [44381793669](https://github.com/backmesh/benchmarks/actions/runs/44381793669), [44382248237](https://github.com/backmesh/benchmarks/actions/runs/44382248237)
- `backmesh-4`: [44365142077](https://github.com/backmesh/benchmarks/actions/runs/44365142077), [44366607804](https://github.com/backmesh/benchmarks/actions/runs/44366607804), [44367828921](https://github.com/backmesh/benchmarks/actions/runs/44367828921), [44369100505](https://github.com/backmesh/benchmarks/actions/runs/44369100505), [44370343686](https://github.com/backmesh/benchmarks/actions/runs/44370343686)

## Method

- **Runtime** is a job's start to its finish. The cold start isn't in it:
  backmesh's runners started without a cue, so each job waited for its VM to
  boot. With `backmesh cue` the median wait was 17 s
  ([cue results](../cue/README.md#results)).
- **Size.** `ubuntu-latest` in a private repository has 2 vCPUs; `backmesh-2`
  has 2 vCPUs and 8 GiB, `backmesh-4` 4 vCPUs and 16 GiB.
- **GitHub's cost** is each job's runtime in whole minutes at $0.006 a minute.
- **backmesh's cost** is the median runtime plus the median cold start, at its
  spot VM's price in us-east-2 and its disk's. The VM boots during the cold
  start, so this slightly overstates it. The spot price is the middle of the
  label's types' range in the anycloud catalog on 2026-11-13: $0.024 to
  $0.0308 an hour for `backmesh-2`, $0.0497 to $0.07 for `backmesh-4`. The
  100 GB gp3 disk at 4,000 IOPS and 500 MiB/s adds about $0.0384 an hour. It
  leaves out backmesh's control plane, about $86 a month on AWS.
- **Caches.** Neither side used a build cache, except setup-node's default npm
  cache, on both.
- **Toolchains.** `ubuntu-latest` has Rust preinstalled. backmesh's image
  doesn't: its first-use handler (`runner/first-use.bash`) installs Ubuntu's
  `cargo` package when the job first calls it, inside the measured time.
