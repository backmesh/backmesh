---
title: GitHub Actions runners on GCP
description: How backmesh runs GitHub Actions jobs on spot VMs in your Google Cloud project, what install creates there, the quotas to raise and what it costs.
sidebar:
  label: GCP
---

backmesh runs each GitHub Actions job on its own Compute Engine VM in your
Google Cloud project, spot unless the label says [on demand](/labels/#on-demand)
or the job reruns after a spot reclaim. The VM is deleted when the job ends, and
Google bills you for it.

## VM types

A job's VM is the first type in its [label's](/labels/) list that has capacity:

| Label         | vCPU | Memory | Types, in order                     |
| ------------- | ---- | ------ | ----------------------------------- |
| `backmesh-2`  | 2    | 8 GiB  | `n2-standard-2`, `n2d-standard-2`   |
| `backmesh-4`  | 4    | 16 GiB | `n2-standard-4`, `n2d-standard-4`   |
| `backmesh-8`  | 8    | 32 GiB | `n2-standard-8`, `n2d-standard-8`   |
| `backmesh-16` | 16   | 64 GiB | `n2-standard-16`, `n2d-standard-16` |

The [KVM labels](/labels/#kvm) use `n2` only, since `n2d` doesn't support
nested virtualization. GCP has no [GPU labels](/labels/#gpu) yet: anycloud
can't launch a T4 VM there. When GCP is the control plane's cloud, its labels are
plain, as above; otherwise they name it, such as `backmesh-gcp-4`.

## Regions

Runners use a fixed list of US regions, not discovered through your cloud CLI
or chosen on the command line: every one whose catalog offers every type
above, which leaves out `us-central2` (almost no general-purpose types),
narrowed to the ones your account allows. Each job tries the cheapest region
first, then another when Google refuses for capacity or quota.
[More](/install/#regions).

## What install creates

Install works through your `gcloud` CLI, signed in with a project. It turns on
the Compute, IAM, IAM Credentials and Security Token Service APIs, and creates:

- **A role connection:** a custom role, a service account, and a workload
  identity pool and provider with their IAM bindings. They trust only your
  control plane, so no service account keys are stored.
- **Cache buckets**, through that connection: one per runner region,
  `bm-cache-<id>-<region>`, for the [cache](/cache/).
- **The control plane**, when GCP is its cloud: an `e2-standard-2` VM and an
  `e2-small` VM for the listener, with their disks and public addresses, and a
  checkpoint bucket for its backups.

[Uninstall](/uninstall/) deletes the VMs and buckets. It asks before deleting
the checkpoint bucket, and leaves the role connection's setup for you to
delete in the console.

## Quotas

Install can't read GCP's quotas, so it names the ones to raise instead. The one
that bites first is `CPUS_ALL_REGIONS`, 32 vCPUs by default across all regions:
8 `backmesh-4` jobs at once. Raise it before big bursts. Each runner region
also has `N2D_CPUS` and `N2_CPUS`, and `PREEMPTIBLE_CPUS` for spot or `CPUS` for
on demand. Runners past a quota wait, and [`backmesh status`](/status/) warns
when they do, as in this example with illustrative numbers:

```text
⚠ 9 runners waited for GCP quota in us-east4, up to 16.7 min.
  Raise CPUS_ALL_REGIONS above its default 32 to start them right away.
```

## Cost

These are catalog prices in `us-central1`, spot in the lowest zone, for a
`backmesh-4` VM while its job runs:

| Type             | Spot $/h | On demand $/h |
| ---------------- | -------- | ------------- |
| `n2-standard-4`  | 0.1165   | 0.1942        |
| `n2d-standard-4` | 0.0899   | 0.169         |

Other sizes scale with their vCPUs. Each job also pays for its VM's boot and its
100 GB disk. The control plane costs about $74 a month. At those prices, 150,000
minutes a month of `backmesh-4` jobs cost at least $299–$365 with the control
plane, before disks, boots and runners started ahead of jobs; see [the
costs](/#cost). Spot prices change by the hour.
