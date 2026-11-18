# Build benchmarks

How long three open-source builds take on a `backmesh-4` runner and on
GitHub's `ubuntu-latest`, and what each build costs.

[`bench.yml`](bench.yml) has three jobs, each checking out a pinned release of
a public project and building it:

- **Docker**: `docker build` of [grafana/k6](https://github.com/grafana/k6)
  v0.54.0's image.
- **Rust**: `cargo build --release --locked` of
  [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) 14.1.1.
- **TypeScript**: `npm ci` and `npx hereby local` of
  [microsoft/TypeScript](https://github.com/microsoft/TypeScript) v5.6.3.

The repository variable `BENCH_RUNNER` picks the runner: `backmesh-4` or
`ubuntu-latest`. A push to the `bench` branch starts a round.

## Results

Measured on 2026-11-18 in a private repository, 5 rounds on each runner. The
figures are medians.

| Build      | backmesh-4 | ubuntu-latest | Faster | Cost a build, backmesh-4 | Cost a build, ubuntu-latest | Cheaper |
| ---------- | ---------- | ------------- | ------ | ------------------------ | --------------------------- | ------- |
| Docker     | 71 s       | 148 s         | 2.1×   | $0.0032                  | $0.018                      | 5.6×    |
| Rust       | 49 s       | 70 s          | 1.4×   | $0.0027                  | $0.012                      | 4.4×    |
| TypeScript | 35 s       | 56 s          | 1.6×   | $0.0021                  | $0.006                      | 2.9×    |

Each job's queue wait, its `created_at` to its `started_at`, on `backmesh-4`
without a cue, in seconds:

| Round | Docker | Rust | TypeScript |
| ----- | ------ | ---- | ---------- |
| 1     | 99     | 51   | 43         |
| 2     | 51     | 50   | 50         |
| 3     | 37     | 36   | 36         |
| 4     | 43     | 50   | 43         |
| 5     | 48     | 50   | 50         |

That's a median of 50 s, from 36 to 99 s. On `ubuntu-latest` every job waited
1 to 3 s, a median of 2 s.

## Method

- **Runtime** is a job's start to its finish. The wait before the job starts,
  from its queueing, isn't in it: a median 2 s on GitHub, 50 s on backmesh without a cue (the table
  above), and about 17 s with `backmesh cue`
  ([cue results](../cue/README.md#results)).
- **Size.** `ubuntu-latest` in a private repository has 2 vCPUs; `backmesh-4`
  has 4 vCPUs and 16 GiB.
- **GitHub's cost** is whole minutes at $0.006 a minute.
- **backmesh's cost** is its spot VM in us-east-2, at the middle of $0.0497 to
  $0.07 an hour, and its 100 GB gp3 disk at 4,000 IOPS and 500 MiB/s, counted
  from the VM's boot. It leaves out backmesh's control plane, about $86 a
  month on AWS.
- **Caches.** Neither side used a build cache, except setup-node's default npm
  cache, on both.
- **Toolchains.** `ubuntu-latest` has Rust preinstalled. backmesh's image
  doesn't: its first-use handler (`runner/first-use.bash`) installs Ubuntu's
  `cargo` package when the job first calls it, inside the measured time.
