---
title: GitHub Actions runner cost on backmesh
description: How backmesh's cost figures are computed. 150,000 minutes a month of 4-vCPU Linux jobs cost $1,800 on GitHub-hosted runners and from about $191–$365 on backmesh at spot prices, with every input and its date.
sidebar:
  label: Cost
---

150,000 minutes a month of 4-vCPU Linux jobs cost $1,800 on GitHub-hosted
runners at list price, and about $191–$365 on backmesh at spot prices on
2026-11-13, depending on the cloud and the VM type a job gets. backmesh's
figure includes one org's always-on VMs and leaves out disks and VM boots, so it's a
floor. backmesh's core features are free; your clouds bill you for the VMs.

## The inputs

- **GitHub-hosted:** `linux_4_core`, $0.012 a minute, GitHub's list price
  before included minutes
  ([docs.github.com](https://docs.github.com/en/billing/reference/actions-runner-pricing),
  read 2026-11-05).
- **backmesh:** each job runs on its own 4-vCPU, 16 GiB `backmesh-ubuntu-2404-4vcpu` VM, which
  bills from its boot until the job ends. The prices are spot prices in the
  lowest zone of one region per cloud, from the catalog on 2026-11-13
  (refreshed with the 2026-11-13 VM type reorder; `m8a` from the catalog on
  2026-11-23):

| Cloud | Region        | `backmesh-ubuntu-2404-4vcpu` types and spot $/h                                                                   |
| ----- | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| AWS   | `us-east-2`   | `m8a.xlarge` 0.065 (2026-11-23), `m8i.xlarge` 0.0583, `m7a.xlarge` 0.07, `m7i.xlarge` 0.0497, `m6a.xlarge` 0.0547 |
| Azure | `westus2`     | `Standard_D4ads_v5` 0.0381, `Standard_D4as_v5` 0.0318, `Standard_D4s_v5` 0.0355                                   |
| GCP   | `us-central1` | `n2-standard-4` 0.1165, `n2d-standard-4` 0.0899                                                                   |

GCP's `backmesh-4` tries `c4d-standard-4` first (from v0.6.2), which isn't
priced here: in `us-east4` a spot job on it cost about 1.05 times one on `n2`,
for about 0.6 of its VM time
([anycloud#43](https://github.com/anycloud-sh/anycloud/pull/43)).

- **The always-on VMs:** the control plane's VM and one listener VM for each
  org, with their disks and public addresses. For one org that's about $86 a
  month on AWS ($69 + $17), $111 on Azure ($79 + $32) and $74 on GCP ($59 +
  $15); each further org adds its listener VM. On Azure, a region that doesn't
  offer your subscription the first sizes takes others, from $101 to $151 for
  one org ([Azure](/azure/)). An idle installation pays only this, since
  runners have no VM while idle.

## How it's computed

GitHub-hosted: 150,000 minutes × $0.012 = $1,800.

backmesh, for each cloud: one org's always-on VMs plus 150,000 minutes at the
cheapest and at the most expensive type's spot price, $/h ÷ 60 a minute.

| Cloud | Spot $/h      | Per 1,000 minutes | 150,000 minutes | Always-on VMs | Month     |
| ----- | ------------- | ----------------- | --------------- | ------------- | --------- |
| AWS   | 0.0497–0.07   | $0.83–$1.17       | $124–$175       | $86           | $210–$261 |
| Azure | 0.0318–0.0381 | $0.53–$0.64       | $80–$95         | $111          | $191–$206 |
| GCP   | 0.0899–0.1165 | $1.50–$1.94       | $225–$291       | $74           | $299–$365 |

The headline range runs from the lowest month, Azure's $191, to the highest,
GCP's $365 — unchanged by the 2026-11-13 reorder, since neither Azure's cheapest type
(`as_v5`) nor GCP's priciest (`n2`) moved. For example, Azure's low end is
$111 + 150,000 × $0.0318 ÷ 60 = $190.50. The [landing page's chart](/#cost)
shows the same figures.

## What's left out

- **Boots.** Each job's VM bills from its boot. Each cloud's boot is its
  measured median from the kernel's start to the runner's container start
  ([vm-boot-marks](https://github.com/anycloud-sh/anycloud/tree/main/experiments/vm-boot-marks#result));
  the [benchmarks](/benchmarks/) have the whole wait for a VM on AWS. Per
  1,000 jobs, the boots add $0.25–$0.36 on AWS, $0.27–$0.32 on Azure and
  $0.90–$1.17 on GCP.
- **Disks.** Each runner has a 100 GB disk while its job runs. On AWS it's gp3
  at 4,000 IOPS and 500 MiB/s, about $0.038 an hour: $0.011 for storage and
  $0.027 for IOPS and throughput above gp3's baseline
  ([EBS pricing](https://aws.amazon.com/ebs/pricing/)). On GCP it's pd-ssd,
  $0.17 a GB-month in `us-central1`, about $0.023 an hour
  ([disk pricing](https://cloud.google.com/compute/disks-image-pricing)). A
  job on `c4d` has Hyperdisk Balanced instead: on demand with 8,000 IOPS and
  1,000 MB/s provisioned, about $0.092 an hour
  ([anycloud#38](https://github.com/anycloud-sh/anycloud/pull/38)), and on
  spot with 3,000 and 750, about $0.044
  ([anycloud#43](https://github.com/anycloud-sh/anycloud/pull/43)).
- **Runners started ahead** of predicted or cued jobs that no job takes. Each
  bills for its boot and a short idle time.
- **Buckets.** The checkpoint bucket and the [cache](/cache/) buckets bill for
  what they store.
- **On-demand retries** after a spot reclaim, and spot jobs that
  [fell back on demand](/labels/#on-demand-fallback) when no runner region had
  spot capacity. `backmesh status` counts them per label.

Spot prices change by the hour and by zone, and other regions differ. On
demand cost about 1.7 to 5.4 times spot on 2026-11-13, depending on the type.

## High memory

The [high-memory labels](/labels/#high-memory) by the same method: the
catalog's prices on 2026-11-25, spot in the lowest zone, at 16 vCPUs, against
the same size's general label. Arithmetic, not measured.

| Cloud | Region         | `backmesh-ubuntu-2404-highmem-16vcpu` (128 GiB), spot $/h | `backmesh-ubuntu-2404-16vcpu` (64 GiB), spot $/h | On demand $/h, high memory against general |
| ----- | -------------- | --------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| AWS   | `us-east-1`    | `r8a.4xlarge` 0.3228, `r8i.4xlarge` 0.3197                | `m8a.4xlarge` 0.3913                             | 1.2781 against 0.9738 (`r8a`, `m8a`)       |
| GCP   | `us-east4`     | `n2-highmem-16` 0.3222, `n2d-highmem-16` 0.6163           | `n2-standard-16` 0.2389                          | 1.1804 against 0.8750 (`n2`)               |
| GCP   | `europe-west4` | `n2-highmem-16` 0.4065, `n2d-highmem-16` 0.4627           | `n2-standard-16` 0.3013                          | 1.1538 against 0.8553 (`n2`)               |
| Azure | `eastus`       | `Standard_E16ads_v5` 0.2207, `Standard_E16as_v5` 0.1904   | `Standard_D16ads_v5` 0.1739                      | 1.048 against 0.824 (`ads_v5`)             |

So a high-memory job costs about 1.3 times the same size's general one on
demand, for twice the memory. On spot it's 1.27 to 1.35 times on GCP and
Azure at each cloud's first type, and on AWS, where `r8a`'s spot price was
under `m8a`'s that day, 0.82 times. GitHub-hosted has no high-memory Linux
runner to compare against: its 16-core runner has 64 GB.

## GPU

The [GPU labels](/labels/#gpu) by the same method, at list prices: arithmetic,
not measured.

- **GitHub-hosted:** the Linux GPU runner, `linux_4_core_gpu` (4 vCPUs, one
  Tesla T4), $0.052 a minute
  ([docs.github.com](https://docs.github.com/en/billing/reference/actions-runner-pricing),
  read 2026-11-18).
- **backmesh:** the catalog's prices on 2026-11-18, spot in the lowest zone,
  in the same regions as above. GCP has no GPU labels.

| Cloud | Type                                     | Spot $/h | On-demand $/h | Spot per minute | On demand per minute |
| ----- | ---------------------------------------- | -------- | ------------- | --------------- | -------------------- |
| AWS   | `g4dn.xlarge`                            | 0.2732   | 0.526         | $0.0046         | $0.0088              |
| AWS   | `g4dn.2xlarge`, when no `xlarge` is free | 0.3696   | 0.752         | $0.0062         | $0.0125              |
| Azure | `Standard_NC4as_T4_v3`                   | 0.1766   | 0.526         | $0.0029         | $0.0088              |

10,000 GPU minutes a month cost $520 on GitHub (10,000 × $0.052), and on
backmesh $46 on AWS spot (10,000 × $0.2732 ÷ 60), $29 on Azure spot and $88 on
demand on either, at each cloud's first type. The control plane is the same one the other labels use, so
it adds nothing. Left out, as above: disks, on-demand retries, and boots,
which are longer than the other labels': a GPU VM boots a larger image and
pulls the runner's image after it
([GPU benchmark](https://github.com/backmesh/backmesh/tree/main/benchmarks/gpu-t4)).

## arm64

The [arm64 labels](/labels/#arm64) by the same method, at list prices:
arithmetic, not measured.

- **GitHub-hosted:** `ubuntu-24.04-arm` in a private repository, 2 vCPUs,
  $0.005 a minute
  ([docs.github.com](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
  read 2026-11-24). It's free in a public repository.
- **backmesh:** the catalog's prices on 2026-11-24 in AWS's `us-east-2`, and
  on 2026-11-25 in GCP's `us-central1`, spot in the lowest zone. Azure has no
  arm64 labels.
- **GCP's `c4a` disk:** `c4a` takes no pd-ssd, so its runner's 100 GB disk is
  Hyperdisk Balanced
  ([anycloud#50](https://github.com/anycloud-sh/anycloud/pull/50)), which
  bills its provisioned IOPS and throughput too: at an on-demand `c4d` job's
  8,000 IOPS and 1,000 MB/s, about $0.092 an hour, or $0.0015 a minute, to
  `t2a`'s pd-ssd at about $0.0004.

| Label                                | Type             | Spot $/h | On-demand $/h | Spot per minute | On demand per minute |
| ------------------------------------ | ---------------- | -------- | ------------- | --------------- | -------------------- |
| `backmesh-ubuntu-2404-arm-2vcpu`     | `m8g.large`      | 0.0424   | 0.0898        | $0.0007         | $0.0015              |
| `backmesh-ubuntu-2404-arm-2vcpu`     | `m7g.large`      | 0.0495   | 0.0816        | $0.0008         | $0.0014              |
| `backmesh-ubuntu-2404-arm-4vcpu`     | `m8g.xlarge`     | 0.0534   | 0.1795        | $0.0009         | $0.0030              |
| `backmesh-ubuntu-2404-arm-4vcpu`     | `m7g.xlarge`     | 0.0608   | 0.1632        | $0.0010         | $0.0027              |
| `backmesh-gcp-ubuntu-2404-arm-2vcpu` | `c4a-standard-2` | 0.0536   | 0.0898        | $0.0009         | $0.0015              |
| `backmesh-gcp-ubuntu-2404-arm-2vcpu` | `t2a-standard-2` | 0.0414   | 0.077         | $0.0007         | $0.0013              |
| `backmesh-gcp-ubuntu-2404-arm-4vcpu` | `c4a-standard-4` | 0.1071   | 0.1796        | $0.0018         | $0.0030              |
| `backmesh-gcp-ubuntu-2404-arm-4vcpu` | `t2a-standard-4` | 0.0828   | 0.154         | $0.0014         | $0.0026              |

10,000 minutes a month of 2-vCPU arm64 jobs cost $50 on GitHub (10,000 ×
$0.005), and on backmesh about $7 on `m8g.large` spot (10,000 × $0.0424 ÷ 60)
and $15 on demand. The control plane is the same one the other labels use, so
it adds nothing. Left out, as above: disks, boots and on-demand retries.

## Estimate your own

1. Count your jobs' minutes a month at each size.
2. Run `backmesh install --org <org> --plan`, with `--runners <cloud>` for each
   cloud to compare. It prints each of those clouds' `backmesh-ubuntu-2404-4vcpu` spot and
   on-demand prices and the always-on VMs' monthly cost, without changing
   anything. Other sizes scale with their vCPUs:
   `backmesh-ubuntu-2404-8vcpu` costs about twice `backmesh-ubuntu-2404-4vcpu`.
3. Multiply each size's minutes by its price ÷ 60, add the always-on VMs once
   (each org's listener VM once per org), and add a boot per job if you run
   many short jobs.

Once jobs run, [`backmesh status`](/status/) shows each org's month-to-date
runner cost by cloud.
