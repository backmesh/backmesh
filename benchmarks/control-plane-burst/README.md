# Control-plane burst

Whether a control plane keeps serving through a burst of queued jobs, and how
fast its runners start through it: for the control plane VM's size
([#179](https://github.com/backmesh/backmesh/pull/179)).

[`e2e.yml`](../../.github/workflows/e2e.yml) runs [`run.ts`](run.ts) with
`burst=<jobs>` (at most 99) in each test-org leg, after the label member, on
the installation it just made. It pushes the
[cue benchmark's target](../cue/target/) to a `burst/<nonce>` branch of the
test org's `e2e` repository as one workflow of that many jobs on the leg's
first label. That repository's own workflows aren't on the branch, so they
don't run. Each job checks out, sets up Node 22, installs a 246-package
lockfile and runs `Marker`, the first real step. The target's `report.mjs`
writes the jobs' times to the `results` branch, where `run.ts` reads them.

Figures, in the leg's summary and its `burst-<cloud>` artifact:

- **Queued to assigned** and **queued to first step** (`Marker`'s start),
  p50, p90 and max over the burst's jobs, nearest rank, in whole seconds.
  **Failed**: jobs whose `Marker` didn't succeed.
- **anycloud api status**, read every 15 s through the burst: a read that
  fails or takes over 5 s is the API not serving.
- **The control plane VM**, from its cloud's metrics: on AWS, CPU and CPU
  credit balance; on GCP, memory (`balloon/ram_used` of `ram_size`) and CPU.
  anycloud's API has no figure for its pods' memory or restarts.

On a timeout or a cancel, `run.ts` pushes `burst-cancel/<nonce>`, whose
workflow cancels the burst's run. Otherwise its queued jobs would wait for
the next leg's runners on the same label.

## Running it

```sh
gh workflow run e2e.yml -f org=backmesh-dryrun -f version=v0.7.2 -f burst=60
```

Dispatch a second run, at the other release, only after the first has
started: a pending run in the same concurrency group replaces the one
pending before it.

## Results

None yet.
