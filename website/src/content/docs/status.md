---
title: Status
description: What backmesh status shows about runners, the queue, cost and health.
---

```sh
backmesh status [--org <org>] [--json]
```

It shows the shared control plane once, then one section for each org on it.
`--org` shows only that org's. It shows:

- **Runners**: that each job gets its own VM and controls that VM's Docker,
  each org's listener VM, and its runner VMs: their cloud,
  regions, number of labels and vCPU quotas summed over the regions, read by
  the control plane with that cloud's connection, so no cloud CLI is needed;
  a quota it can't read shows as unread, with why.
- **Queue**, per label: GitHub's assigned and running jobs, backmesh's runners
  queued, starting and running, the oldest queued runner's age, and the reasons
  runners are short, such as no spot capacity or a quota limit; the regions
  skipped because their quota can't fit one runner, with the quota to raise; and
  a warning when a label's quota fits no region, or its spot runners' regions
  are avoided for slow starts, so its jobs wait at GitHub. A label with
  [on-demand fallback](/labels/#on-demand-fallback) shows "falls back on
  demand", its slow-start line counts the runners replaced on demand, and while
  every spot region of it is avoided, a warning says its runners start on demand
  until when. A label that install or upgrade removed shows as draining until
  its scale set is deleted.
- **Planner**, as counts only: per label, the runners started ahead of
  predicted jobs; per org, the workflows learned and how many of them scale
  only reactively because too few predictions were right; and whether the
  planner is off after an error.
- **Jobs**, per label, over the last 24 hours: how many completed and how long
  they took to start, typical (p50) and slowest (p95); how many were reclaimed
  or failed to start, and how many fell back on demand
  ([on-demand fallback](/labels/#on-demand-fallback)), when any were; and a warning when runners waited for
  cloud quota, with the quota to raise. It warns at 3 or more runners refused
  for quota with the slowest waits (p95) at 2 minutes or more. `--json` has
  both 24 hours and 7 days, with every percentile and start stage.
- **Cost**: each org's month-to-date runner cost, by cloud.
- **Telemetry**: a line when the listener's events can't reach backmesh.com,
  and how many wait to be sent. Jobs aren't affected. See
  [Telemetry](/telemetry/).
- **Checks**: whether a listener's VM is gone, which `backmesh upgrade`
  creates again; whether the control plane refuses a listener's token, such
  as after a restore from an older backup, which `backmesh upgrade` replaces;
  whether each listener can get GitHub tokens from backmesh.com; and other
  warnings.

```text
  backmesh-ubuntu-2404-4vcpu: 5 assigned, 2 running; runners 2 queued, 0 starting, 1 running
    16 jobs today · start 2.7 min typical, 18.0 min slowest
    ⚠ 9 runners waited for GCP quota in us-east4, up to 16.7 min.
      Raise CPUS_ALL_REGIONS above its default 32 to start them right away.
```

The figures are illustrative. The listener keeps the job rows in memory, so a restart or upgrade empties them.
Each completed job also writes one `job completed` JSON line to the listener's
log.

## In each job's log

When a job finishes, the last lines of its log give the resources it used: peak
memory (page cache excluded), OOM kills, average and peak CPU, and the work
directory's peak disk. Use them to pick a [size](/labels/).

## Spot reclaims

When a cloud reclaims a spot VM, the job on it fails. When reclaims were the
run's only failures, backmesh reruns its failed jobs on an on-demand runner once
the run finishes, at most twice, unless a job sets `backmesh-noretry`. Each label's reclaim line
counts the runs rerun, `--json` adds where their retries started, and a
`Retry:` line shows the runs waiting to be rerun.

Either way, the listener logs one note per workflow run (`backmesh logs`),
named `reclaims in run <id>`. It lists every reclaimed job with
its VM type and capacity. Titled "Spot reclaim", it says backmesh will rerun
them; titled "Rerun needed", it says why backmesh won't and to rerun the failed
jobs from the Actions tab once the run finishes.

After 2 reclaims within 15 minutes on a cloud's spot VMs, backmesh starts that
cloud's spot jobs on demand for 30 minutes, and the `Retry:` line shows until
when. KVM labels count their reclaims apart from the others.
