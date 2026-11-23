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
`backmesh-16`, is a label no other workflow in anycloud or backmesh uses, so
the figures aren't skewed by real jobs taking the cue's runners (our CI uses
`backmesh-4` and `backmesh-2` heavily). Give `label` a different value, keep
it one nothing else uses. The listener's planner keeps a label's
workflow history until it restarts, so after a dispatch on another label, a
cue also starts a runner on the earlier label, which idles; the cued
**Jobs served** share shows any effect.

## Running it

Dispatch **Cue benchmark** with `target`, `rounds` (cued, uncued and hosted pushes
each, default 5), `lead` (default 75 s), `width` (default 8 jobs a push) and
`label` (default `backmesh-16`). It
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
