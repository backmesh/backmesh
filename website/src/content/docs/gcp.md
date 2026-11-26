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

| Label                         | vCPU | Memory | Types, in order                     |
| ----------------------------- | ---- | ------ | ----------------------------------- |
| `backmesh-ubuntu-2404-2vcpu`  | 2    | 8 GiB  | `n2-standard-2`, `n2d-standard-2`   |
| `backmesh-ubuntu-2404-4vcpu`  | 4    | 16 GiB | `n2-standard-4`, `n2d-standard-4`   |
| `backmesh-ubuntu-2404-8vcpu`  | 8    | 32 GiB | `n2-standard-8`, `n2d-standard-8`   |
| `backmesh-ubuntu-2404-16vcpu` | 16   | 64 GiB | `n2-standard-16`, `n2d-standard-16` |

[On-demand labels](/labels/#on-demand) from 4 vCPUs try AMD's `c4d` (Zen 5)
and `c3d` (Zen 4) first, then the same types; `backmesh-ubuntu-2404-od-2vcpu` keeps `n2` and
`n2d`:

| Label                            | vCPU | Memory       | Types, in order                                                           |
| -------------------------------- | ---- | ------------ | ------------------------------------------------------------------------- |
| `backmesh-ubuntu-2404-od-4vcpu`  | 4    | 15 or 16 GiB | `c4d-standard-4`, `c3d-standard-4`, `n2-standard-4`, `n2d-standard-4`     |
| `backmesh-ubuntu-2404-od-8vcpu`  | 8    | 31 or 32 GiB | `c4d-standard-8`, `c3d-standard-8`, `n2-standard-8`, `n2d-standard-8`     |
| `backmesh-ubuntu-2404-od-16vcpu` | 16   | 62 or 64 GiB | `c4d-standard-16`, `c3d-standard-16`, `n2-standard-16`, `n2d-standard-16` |

A `c4d` VM has 3.875 GiB a vCPU, the smaller memory figure; the others have 4.
At 4 vCPUs on demand, `c4d` builds in half of `n2`'s time and `c3d` in 0.71 of
it, for 0.78 and 0.76 of its cost per job, disk included
([anycloud#38](https://github.com/anycloud-sh/anycloud/pull/38)); at 16
vCPUs, a few runs gave 0.52 and 0.75 of its time, and 8 vCPUs wasn't
measured. `us-south1` offers neither, and `us-west2` and `us-west3` no
`c3d`, so jobs there start on the next type in the list. Spot labels stay on
`n2` and `n2d` for now.

The [KVM labels](/labels/#kvm) use `n2` only, since `n2d`, `c4d` and `c3d`
don't support nested virtualization. GCP has no [GPU labels](/labels/#gpu) yet: anycloud
can't launch a T4 VM there. When GCP is the control plane's cloud, its labels are
plain, as above; otherwise they name it, such as `backmesh-gcp-ubuntu-2404-4vcpu`.

The [high-memory labels](/labels/#high-memory) use `n2-highmem-<n>` then
`n2d-highmem-<n>`, 8 GiB a vCPU, on spot and on demand alike:
`backmesh-ubuntu-2404-highmem-16vcpu` is 16 vCPUs and 128 GiB. They count
against the same `N2_CPUS`, `N2D_CPUS` and `PREEMPTIBLE_CPUS` quotas.

The [arm64 labels](/labels/#arm64) use Google's Axion, `c4a-standard-<n>`,
then Ampere's `t2a-standard-<n>`, at the same sizes, and the arm64
high-memory ones `c4a-highmem-<n>`; `t2a` has no high-memory shape. Only
`us-central1` and `europe-west4` among the runner regions offer `t2a`, and an
arm64 label's jobs launch only in the regions that offer one of its types.

## Regions

Runners use a fixed list of US regions, or with `--runner-geo eu` of EU ones
anchored on `europe-west4`, not discovered through your cloud CLI or chosen on
the command line: every one whose catalog offers every spot type above, which
leaves out `us-central2` (almost no general-purpose types) and `europe-north2`
(no `n2` or `n2d`), narrowed to the ones your account allows. Each job tries the cheapest region
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
- **The control plane**, when GCP is its cloud: an `e2-standard-2` VM, with its
  disk and public address, and a checkpoint bucket for its backups; and each
  org's listener on its own `e2-small` VM, with its disk and public address.

[Uninstall](/uninstall/) deletes the VMs and buckets. It asks before deleting
the checkpoint bucket, and leaves the role connection's setup for you to
delete in the console.

## Quotas

Install can't read GCP's quotas, so it names the ones to raise instead. The one
that bites first is `CPUS_ALL_REGIONS`, 32 vCPUs by default across all regions:
8 `backmesh-ubuntu-2404-4vcpu` jobs at once. Raise it before big bursts. Each runner region
also has `N2D_CPUS` and `N2_CPUS`, and `PREEMPTIBLE_CPUS` for spot or `CPUS`,
`C4D_CPUS` and `C3D_CPUS` for on demand, and the arm64 labels' `C4A_CPUS`
and `T2A_CPUS` on demand. Each on-demand `c4d` runner's disk
also counts 100 GB, 8,000 IOPS and 1,000 MB/s against the region's
[Hyperdisk Balanced quotas](https://cloud.google.com/compute/docs/disks/hyperdisks)
for capacity, IOPS and throughput, which install doesn't name. Runners past a quota wait, and [`backmesh status`](/status/) warns
when they do, as in this example with illustrative numbers:

```text
⚠ 9 runners waited for GCP quota in us-east4, up to 16.7 min.
  Raise CPUS_ALL_REGIONS above its default 32 to start them right away.
```

## Cost

These are catalog prices in `us-central1`, spot in the lowest zone, for a
`backmesh-ubuntu-2404-4vcpu` VM while its job runs:

| Type             | Spot $/h | On demand $/h |
| ---------------- | -------- | ------------- |
| `n2-standard-4`  | 0.1165   | 0.1942        |
| `n2d-standard-4` | 0.0899   | 0.169         |
| `c4d-standard-4` | —        | 0.1833        |
| `c3d-standard-4` | —        | 0.1816        |

Other sizes scale with their vCPUs. Each job also pays for its VM's boot and its
100 GB disk: pd-ssd, about $0.023 an hour, or on `c4d`, which can't take
pd-ssd, Hyperdisk Balanced with 8,000 IOPS and 1,000 MB/s provisioned, about
$0.092 an hour. The control plane and one org's listener VM cost about $74 a
month. At those prices, 150,000 minutes a month of `backmesh-ubuntu-2404-4vcpu` jobs cost at
least $299–$365 with one org's always-on VMs, before disks, boots and runners started ahead of jobs; see [the
costs](/#cost). Spot prices change by the hour.
