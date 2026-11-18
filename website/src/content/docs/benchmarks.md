---
title: Build benchmarks against GitHub's ubuntu-latest
description: Docker, Rust and TypeScript builds on backmesh-2 and backmesh-4 spot VMs on AWS against GitHub-hosted ubuntu-latest, 5 rounds each on 2026-11-18. backmesh-4 ran them 1.4 to 2.1× faster at 2.9 to 5.6× less per build.
sidebar:
  label: Benchmarks
---

We built three pinned open-source projects 5 times each on GitHub's
`ubuntu-latest` and on backmesh's `backmesh-2` and `backmesh-4` spot VMs on
AWS, on 2026-11-18. The figures are medians of the 5 rounds, and every run is
[linked below](#runs).

`backmesh-4` ran the builds 1.4 to 2.1× faster than `ubuntu-latest`, at 2.9 to
5.6× less per build. At the same 2 vCPUs, `backmesh-2` was faster for Docker
(1.5×) and TypeScript (1.3×) but slower for Rust (0.8×), partly because
backmesh's image installs `cargo` on first use, inside the measured time
([backmesh#22](https://github.com/backmesh/backmesh/issues/22)). It was cheaper
on all three, 3.8 to 6.9× less per build. Each backmesh job waited longer to
start, for its VM to boot.

## Results

Each cell gives the job's runtime, its cost a build and its cold start, all
medians. On backmesh, the × after the runtime is how many times faster than
`ubuntu-latest` it was (under 1 is slower), and after the cost how many times
cheaper.

<table>
  <thead>
    <tr>
      <th>Workload</th>
      <th><code>ubuntu-latest</code><br />2 vCPUs</th>
      <th><code>backmesh-2</code><br />2 vCPUs</th>
      <th><code>backmesh-4</code><br />4 vCPUs</th>
    </tr>
  </thead>
  <tbody>
    <tr id="docker">
      <th>Docker<br /><small><a href="https://github.com/grafana/k6">k6 v0.54.0</a></small></th>
      <td><strong>148 s</strong><br />$0.018<br />2 s start</td>
      <td><strong>102 s</strong> · 1.5×<br />$0.0026 · 6.9×<br />40 s start</td>
      <td><strong>71 s</strong> · 2.1×<br />$0.0032 · 5.6×<br />48 s start</td>
    </tr>
    <tr id="rust">
      <th>Rust<br /><small><a href="https://github.com/BurntSushi/ripgrep">ripgrep 14.1.1</a></small></th>
      <td><strong>70 s</strong><br />$0.012<br />2 s start</td>
      <td><strong>83 s</strong> · 0.8×<br />$0.0024 · 5.0×<br />46 s start</td>
      <td><strong>49 s</strong> · 1.4×<br />$0.0027 · 4.4×<br />50 s start</td>
    </tr>
    <tr id="typescript">
      <th>TypeScript<br /><small><a href="https://github.com/microsoft/TypeScript">microsoft/TypeScript v5.6.3</a></small></th>
      <td><strong>56 s</strong><br />$0.006<br />2 s start</td>
      <td><strong>44 s</strong> · 1.3×<br />$0.0016 · 3.8×<br />42 s start</td>
      <td><strong>35 s</strong> · 1.6×<br />$0.0021 · 2.9×<br />43 s start</td>
    </tr>
  </tbody>
</table>

## Method

- **Runtime** is a job's start to its finish, as GitHub records them.
- **Cold start** is a job's queueing to its start. backmesh's runners started
  without a cue, so each job waited for its VM to boot. With
  [`backmesh cue`](/#cue), the runner boots before the push, and the median wait was
  17 s in our
  [cue benchmark](https://github.com/backmesh/backmesh/tree/main/benchmarks/cue#results).
- **Size.** The repository was private when the runs were made, so
  `ubuntu-latest` had 2 vCPUs. `backmesh-2` has 2 vCPUs and 8 GiB, and
  `backmesh-4` 4 vCPUs and 16 GiB.
- **GitHub's cost** is each job's runtime rounded up to whole minutes, at
  $0.006 a minute.
- **backmesh's cost** is the median runtime plus the median cold start, at its
  VM's spot price and its disk's. The VM boots during the cold start, so
  counting all of it slightly overstates the cost. The spot price is the middle
  of the range of the label's AWS types in us-east-2, in the
  [anycloud catalog](https://github.com/anycloud-sh/catalog/blob/fc06c8852d411ca466091911e8d9629bd7e0ca9c/aws/vms.csv)
  on 2026-11-13, as on the [cost page](/cost/): $0.024 to $0.0308 an hour for
  `backmesh-2`, $0.0497 to $0.07 for `backmesh-4`. The disk is 100 GB of gp3 at
  4,000 IOPS and 500 MiB/s, about $0.0384 an hour. It leaves out backmesh's
  control plane, about $86 a month on AWS.
- **Caches.** Neither side used a build cache, except setup-node's default npm
  cache, on both.
- **Toolchains.** `ubuntu-latest` has Rust preinstalled. backmesh's image
  doesn't: its first-use handler installs Ubuntu's `cargo` package when the job
  first calls it, inside the measured time.

## The workflow

[`benchmarks/builds/bench.yml`](https://github.com/backmesh/backmesh/blob/main/benchmarks/builds/bench.yml)
has a job for each workload. The repository variable `BENCH_RUNNER` picks the
runner, and a push to the `bench` branch starts a round.

```yaml
name: bench
on:
  push:
    branches: [bench]
permissions:
  contents: read
jobs:
  typescript:
    runs-on: ${{ vars.BENCH_RUNNER }}
    steps:
      - uses: actions/checkout@v5
        with: { repository: microsoft/TypeScript, ref: v5.6.3 }
      - uses: actions/setup-node@v5
        with: { node-version: 22 }
      - run: npm ci --no-audit --no-fund
      - run: npx hereby local
  rust:
    runs-on: ${{ vars.BENCH_RUNNER }}
    steps:
      - uses: actions/checkout@v5
        with: { repository: BurntSushi/ripgrep, ref: 14.1.1 }
      - run: cargo build --release --locked
  docker:
    runs-on: ${{ vars.BENCH_RUNNER }}
    steps:
      - uses: actions/checkout@v5
        with: { repository: grafana/k6, ref: v0.54.0 }
      - run: docker build -t bench .
```

## Runs

Each round is one run of the workflow, its three jobs in parallel, in
[backmesh/benchmarks](https://github.com/backmesh/benchmarks).

| Runner          | Round 1                                                                        | Round 2                                                                        | Round 3                                                                        | Round 4                                                                        | Round 5                                                                        |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `ubuntu-latest` | [44364487787](https://github.com/backmesh/benchmarks/actions/runs/44364487787) | [44365905066](https://github.com/backmesh/benchmarks/actions/runs/44365905066) | [44367215179](https://github.com/backmesh/benchmarks/actions/runs/44367215179) | [44368389022](https://github.com/backmesh/benchmarks/actions/runs/44368389022) | [44369659562](https://github.com/backmesh/benchmarks/actions/runs/44369659562) |
| `backmesh-2`    | [44379996886](https://github.com/backmesh/benchmarks/actions/runs/44379996886) | [44380630467](https://github.com/backmesh/benchmarks/actions/runs/44380630467) | [44381256875](https://github.com/backmesh/benchmarks/actions/runs/44381256875) | [44381793669](https://github.com/backmesh/benchmarks/actions/runs/44381793669) | [44382248237](https://github.com/backmesh/benchmarks/actions/runs/44382248237) |
| `backmesh-4`    | [44365142077](https://github.com/backmesh/benchmarks/actions/runs/44365142077) | [44366607804](https://github.com/backmesh/benchmarks/actions/runs/44366607804) | [44367828921](https://github.com/backmesh/benchmarks/actions/runs/44367828921) | [44369100505](https://github.com/backmesh/benchmarks/actions/runs/44369100505) | [44370343686](https://github.com/backmesh/benchmarks/actions/runs/44370343686) |
