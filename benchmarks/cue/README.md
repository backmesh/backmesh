# Cue benchmark

A performance probe for `backmesh cue`: how much sooner a
push's job reaches its first real step when a cue warned the listener ahead
of the push, against the same push without one.

[`cue-benchmark.yml`](../../.github/workflows/cue-benchmark.yml) runs
[`run.ts`](run.ts) on a GitHub-hosted runner. It pushes to the `bench` branch
of the `target` repo, one in an org with a backmesh installation. The pushes
alternate: one after `backmesh cue --in <lead>`, sent `lead` seconds before
the push through the CLI built from the dispatched commit, then one without a
cue. A warm-up push comes first, so the planner has
learned the workflow's first wave before the first cue.

The target is [`target/`](target/): `bench.yml`, written as `bench-<label>.yml` with
the `label` input for `runs-on`, runs checkout, setup-node with Node 22, `yarn install
--frozen-lockfile` of a 2,500-line lockfile (246 packages), and a `Marker`
step. Its last step, `report.mjs`, reads its job's times from the
API and writes them to the target's `results` branch. `run.ts` fetches them
over git, as its deploy key can't read the API.

## Figures

For each round, in seconds, from GitHub's job and step times (whole
seconds) and the driver's clock at `git push`:

- **Push to first real step**: `git push` to the `Marker` step's start.
- **Queued to assigned**: the job's `created_at` to its `started_at`, when a
  runner took it.
- **Push to queued**: `git push` to the job's `created_at`.
- **Job setup**: the job's `started_at` to the `Marker` step's start: the
  runner's setup, checkout, setup-node and the install, which a cue can't
  hide today. **Of which yarn install** is the `Install` step alone.

The job summary has the median and range of each, for cued rounds, for cued
rounds a runner served, and for rounds without a cue. A round is **served**
when a runner took its job within 10 s of its queueing. The CLI's `sent` only
means the relay took the cue. An offline listener or the cue guard starts
nothing for it, and another job on the label may take the cue's runner. An
uncued round can also be served by another job's early runner. The artifact has
every round's figures and the cue CLI's outcome, written after each round.

The label is shared with real CI: a cue's runner may take a real job, and a
benchmark job may take a runner started for a real one. The default,
`backmesh-16`, is a label no other workflow in anycloud or backmesh uses, so
the figures aren't skewed by real jobs taking the cue's runners (our CI uses
`backmesh-4` and `backmesh-2` heavily). Give `label` a different value, keep
it one nothing else uses. The listener's planner keeps a label's
workflow history until it restarts, so after a dispatch on another label, a
cue also starts a runner on the earlier label, which idles; the **Cued,
served** count shows any effect.

## Running it

Dispatch **Cue benchmark** with `target`, `rounds` (cued and uncued pushes each,
default 5), `lead` (default 75 s) and `label` (default `backmesh-16`). It
takes about 12 minutes a round (one cued push at its default 75 s lead, one not, each a ~2-minute job plus a 200 s gap after). It needs, in the `e2e` environment:

- `E2E_SIGN_IN_TOKEN`: a backmesh sign-in (`read:org`) of an active member of
  the target's org with write access to the target. The cues are sent as that
  user.
- `CUE_BENCH_DEPLOY_KEY`: the target repo's write deploy key. A push with it
  starts the target's workflow, where a push with this workflow's own token
  wouldn't.

Cost: the target's jobs run for about 2 minutes each on the label's spot VMs,
and a cued round's runner idles at most 180 s before its push; the driver's
hosted runner is billed per minute.
