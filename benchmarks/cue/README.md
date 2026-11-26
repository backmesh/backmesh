# Cue benchmark

A performance probe for `backmesh cue`: how many of a push's first-wave
jobs start on a runner already waiting, and how much sooner they reach their
first real step and finish, when a cue warned the listener ahead of the
push, against the same push without one and on GitHub's `ubuntu-latest`.

[`cue-benchmark.yml`](../../.github/workflows/cue-benchmark.yml) runs
[`run.ts`](run.ts) on a GitHub-hosted runner. It pushes to the `bench` branch
of the `target` repo, one in an org with a backmesh installation. Each round
has three pushes: one after `backmesh cue --in <lead>`, sent `lead` seconds
before the push through the CLI built from the dispatched commit, one without
a cue, and one to the `bench-hosted` branch, whose copy of the workflow runs
the same jobs on `ubuntu-latest`; the label's workflow never runs for it. A
warm-up push comes first, so the planner has
learned the workflow's first wave before the first cue.

The target is [`target/`](target/): `bench.yml`, written as `bench-<label>-w<width>.yml` with
the `label` input for `runs-on` and as `bench-ubuntu-latest-w<width>.yml`, runs a matrix of `width` `bench` jobs, the
run's first wave. Each runs checkout, setup-node with Node 22, `yarn install
--frozen-lockfile` of a 2,500-line lockfile (246 packages), and a `Marker`
step. A `report` job on `ubuntu-latest` needs them all: its `report.mjs`
reads their times from the API and writes them to the target's `results`
branch. `run.ts` fetches them over git, as its deploy key can't read the API.

## Figures

For each push, in seconds, from GitHub's job and step times (whole
seconds) and the driver's clock at `git push`, each the median over the
push's jobs:

- **Queued to done**: the job's `created_at` to its `completed_at`.
- **Queued to first real step**: the job's `created_at` to the `Marker`
  step's start.
- **Push to first real step**: `git push` to the `Marker` step's start.
- **Queued to assigned**: the job's `created_at` to its `started_at`, when a
  runner took it.
- **Push to queued**: `git push` to the job's `created_at`.
- **Job setup**: the job's `started_at` to the `Marker` step's start: the
  runner's setup, checkout, setup-node and the install, which a cue can't
  hide today. **Of which yarn install** is the `Install` step alone.

A job is **served** when a runner took it within 10 s of its queueing. The
job summary has, for cued pushes, pushes without a cue and hosted pushes,
the share of their jobs served and the median and range over pushes of each
figure, then each push's served count, queued to first real step and queued
to done. The CLI's `sent`
only means the relay took the cue. An offline listener or the cue guard
starts nothing for it, and another job on the label may take the cue's
runners. An uncued push's jobs can also be served by another job's early
runner. The artifact has every push's figures and the cue CLI's outcome,
written after each round.

The label is shared with real CI: a cue's runner may take a real job, and a
benchmark job may take a runner started for a real one. The default,
`backmesh-ubuntu-2404-16vcpu`, is a label no other workflow in anycloud or backmesh uses, so
the figures aren't skewed by real jobs taking the cue's runners (our CI uses
`backmesh-ubuntu-2404-4vcpu` and `backmesh-ubuntu-2404-2vcpu` heavily). Give `label` a different value, keep
it one nothing else uses. The listener's planner keeps a label's
workflow history until it restarts, so after a dispatch on another label, a
cue also starts a runner on the earlier label, which idles; the cued
**Jobs served** share shows any effect.

## Running it

Dispatch **Cue benchmark** with `target`, `rounds` (cued, uncued and hosted pushes
each, default 5), `lead` (default 75 s), `width` (default 8 jobs a push) and
`label` (default `backmesh-ubuntu-2404-16vcpu`). It
takes about 12 minutes a round: a cued push at its default 75 s lead and one
not, each about a minute plus a 200 s gap after, then a hosted push of about
a minute. It needs, in the `e2e` environment:

- `E2E_SIGN_IN_TOKEN`: a backmesh sign-in (`read:org`) of an active member of
  the target's org with write access to the target. The cues are sent as that
  user.
- `CUE_BENCH_DEPLOY_KEY`: the target repo's write deploy key. A push with it
  starts the target's workflow, where a push with this workflow's own token
  wouldn't.

Cost: the target's `width` jobs a push run for about a minute each on the
label's spot VMs or, for the hosted arm, on GitHub's,
and a cued round's runners idle at most 180 s before its push; the driver's
hosted runner is billed per minute.

## Results

Runs before backmesh v0.7.0 name the labels as they were then: `backmesh-4`
is today's `backmesh-ubuntu-2404-4vcpu`, and `backmesh-gpu-t4` today's
`backmesh-ubuntu-2404-gpu-t4`.

### 2026-11-25, p75 against p95 boot plus 5 s (#117), backmesh 0.7.1

The A/B for [#117](https://github.com/backmesh/backmesh/pull/117), which
times a cue's runners by the label's p95 boot plus 5 s instead of its p75.
Both arms ran on backmesh's own CI installation (AWS, anycloud 0.1.83):
target `backmesh/benchmarks`, `backmesh-ubuntu-2404-16vcpu`, width 8, 10
rounds, lead 75 s. They ran back to back:
[run 45662154783](https://github.com/backmesh/backmesh/actions/runs/45662154783)
with the installation on v0.7.2-rc.1 (#117), then ci-install back to v0.7.1
and
[run 45688492534](https://github.com/backmesh/backmesh/actions/runs/45688492534).
Each upgrade restarted the listener, so each arm's first cue had no boot
history and used the 71 s default. The per-job figures are the cued pushes'
80 jobs, and p90 is the nearest rank. The p-values are exact two-sided
Mann–Whitney tests on the 10 push medians, and Fisher's exact test for the
share taken within 5 s.
[`results/2026-11-25-0.7.1-vs-0.7.2-rc.1.json`](results/2026-11-25-0.7.1-vs-0.7.2-rc.1.json)
has every push and each cued job's wait.

| Cued pushes                            | p75 (v0.7.1)    | p95 + 5 s (#117) | p     |
| -------------------------------------- | --------------- | ---------------- | ----- |
| Jobs taken within 5 s                  | 80 of 80 (100%) | 75 of 80 (94%)   | 0.059 |
| Pushes with a partial miss             | 0 of 10         | 2 of 10          |       |
| Queued to first real step, push        | 10.25 s (10–11) | 11 s (10–15)     | 0.16  |
| Queued to first real step, job p50/p90 | 10 / 11 s       | 11 / 12 s        |       |
| Queued to assigned, job p50/p90        | 2 / 2 s         | 2 / 3 s          |       |
| Queued to done, push                   | 14 s (14–14)    | 14 s (14–18.5)   | 0.087 |

Uncued pushes took 53.25 s and 53 s to the first real step, and hosted ones
13 s and 14 s, so the two arms ran in about the same conditions.

On v0.7.1, p75 timing already put a runner on every cued job within 2 s.
The partial misses #117 aimed at, where a few jobs wait 8 to 52 s, didn't
happen once in 80 jobs. #117's two misses were slow launches, not late
timing. Round 0 was a fresh listener's first cue, where one job waited
41 s. In round 12, four jobs waited over 5 s: 8, 32, 46 and 55 s. The 0.5.7 run's misses
(below) came before AWS's spot fail-fast (anycloud#35, in v0.6.1), which
fits slow spot launches as their cause. No figure favours #117, and it idles
each cued runner longer.

### 2026-11-23, backmesh 0.5.7, against GitHub-hosted

[Run 45245714397](https://github.com/backmesh/backmesh/actions/runs/45245714397)
of this workflow from main, on backmesh's own CI installation (backmesh 0.5.7):
target `backmesh/benchmarks`, `backmesh-16`, width 8, 10 rounds, lead 75 s,
125 minutes. A push is the unit: each figure is the median over an arm's 10
pushes of the push's median over its 8 jobs, with the range over pushes. The
p-values are exact two-sided Mann–Whitney tests on the push medians,
Bonferroni-corrected over the 3 pairs of arms.

| Figure                                  | Cued               | Not cued            | GitHub-hosted    |
| --------------------------------------- | ------------------ | ------------------- | ---------------- |
| Jobs served                             | 52 of 80 (65%)     | 0 of 80 (0%)        | 80 of 80 (100%)  |
| Queued to done                          | 15.25 s (10.5–130) | 52 s (47.5–106.5)   | 16 s (15–20)     |
| Queued to first real step               | 13.25 s (8–128)    | 49.5 s (45.5–104.5) | 13.5 s (12.5–18) |
| Queued to assigned                      | 3.25 s (1–108.5)   | 40 s (35.5–95.5)    | 3 s (2–3)        |
| Job setup (assigned to first real step) | 9.5 s (7–16.5)     | 10 s (9–10)         | 10.75 s (10–15)  |
| of which yarn install                   | 4 s (1–8)          | 4.5 s (4–5)         | 7 s (6.5–8)      |

| Queued to done, pair    | p (corrected) |
| ----------------------- | ------------- |
| Cued against hosted     | 1 (0.81 raw)  |
| Cued against not cued   | 0.051         |
| Not cued against hosted | 0.00003       |

For queued to first real step they're 1 (0.96 raw), 0.052 and 0.00003.

The job is short (about 2 s after its first real step), so queued to done
is mostly the time to start. With a cue, a job is done no sooner than on
`ubuntu-latest`: the medians are 15.25 and 16 s, and the test finds no
difference. Without a cue it takes about 36 s longer, and that difference
holds. Cued against not cued just misses 0.05 after the correction.

In the 6 cued pushes where a cue's runners took 7 or 8 of the 8 jobs, the
jobs were done in 10.5 to 16.5 s, against the hosted pushes' 15 to 20 s,
mostly through a quicker install (a median of 2.75 s against 7 s). The other
cued pushes missed for two reasons:

- **Slow launches, in both arms.** In cued pushes 0 and 9, jobs waited 21
  to 167 s and 72 to 227 s for a runner. Uncued pushes 10 and 19 waited up
  to 263 and 244 s, while an uncued job usually waits 35 to 46 s. That fits
  the cloud refusing spot capacity while the launch retries, but the run
  kept no listener or launch logs, so it isn't confirmed.
- **Partial misses.** In cued pushes 15, 18 and 24, a cue's runners took 7,
  3 and 2 jobs within 2 to 5 s, and the rest waited 8 to 52 s, well under a
  cold start. The cue aims each runner to be ready at the push (lead after
  the cue) and starts it at that minus the label's p75 boot time, so about
  1 in 4 runners comes up after its job queues, and with 8 runners one late
  is likely.

Even so, cued pushes 18 and 24 (31.5 and 36.5 s) beat every uncued push
(47.5 s at least). The runners also differ in size: `ubuntu-latest` on a
public repo has 4 vCPUs, `backmesh-16` 16.

### 2026-11-23, backmesh 0.5.7, 3 rounds

[Run 45237380381](https://github.com/backmesh/backmesh/actions/runs/45237380381)
of this workflow from main, on backmesh's own CI installation (backmesh 0.5.7):
target `backmesh/benchmarks`, `backmesh-16`, width 8, 3 rounds, lead 75 s.
Each figure is the median over pushes of the push's median over its jobs,
with the range over pushes. **Queued to done** was read from the target's
job times after the run, as the job summary didn't have it then. With 3
pushes an arm, the figures show a direction only.

| Figure                                  | Cued           | Not cued       |
| --------------------------------------- | -------------- | -------------- |
| Jobs served                             | 17 of 24 (71%) | 0 of 24 (0%)   |
| Queued to first real step               | 17 s (11–34)   | 52 s (46–80.5) |
| Queued to assigned                      | 7 s (1–24.5)   | 43.5 s (36–71) |
| Job setup (assigned to first real step) | 10 s (10–10)   | 10 s (9–10)    |
| Queued to done                          | 19 s (13–36.5) | 54.5 s (48–83) |

Served per cued push: 5, 4 and 8 of 8; the jobs a cue's runner didn't take
waited for a runner of their own, like an uncued push's. The slowest job of
a push, the wave's end, was done 40, 99 and 14 s after queueing cued, and
181, 99 and 53 s uncued. This run had no GitHub-hosted arm.

### 2026-11-10, a one-off workflow

Measured on 2026-11-10 on backmesh's own CI installation, on `backmesh-4`.
This run used a one-off workflow of 8 parallel `sleep 60` jobs per push
rather than `run.ts`. Three warm-up pushes came first. Then three pushes each
sent 120 s after `backmesh cue --in 120` alternated with three uncued pushes.
A job's queue wait is its `started_at` minus its `created_at`; the median and
p90 use the nearest rank.

|        | Jobs | Median wait | p90 wait | On a pre-started runner |
| ------ | ---- | ----------- | -------- | ----------------------- |
| Uncued | 24   | 100.5 s     | 121 s    | 0 of 24                 |
| Cued   | 24   | 17 s        | 70 s     | 20 of 24                |

A job counts as on a pre-started runner when it waited under 30 s; every
wait seen was either at most 28 s or at least 43 s. In one cued push only 4
of 8 jobs were, and the other 4 waited 43 to 84 s, while other CI work was
using the same installation.
