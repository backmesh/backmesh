---
title: GitHub Actions runner cost on backmesh
description: How backmesh's cost figures are computed. 150,000 minutes a month of 4-vCPU Linux jobs cost $1,800 on GitHub-hosted runners and from about $191–$365 on backmesh at spot prices, with every input and its date.
sidebar:
  label: Cost
---

150,000 minutes a month of 4-vCPU Linux jobs cost $1,800 on GitHub-hosted
runners at list price, and about $191–$365 on backmesh at spot prices on
2026-11-13, depending on the cloud and the VM type a job gets. backmesh's
figure includes its control plane and leaves out disks and VM boots, so it's a
floor. backmesh's core features are free; your clouds bill you for the VMs.

## The inputs

- **GitHub-hosted:** `linux_4_core`, $0.012 a minute, GitHub's list price
  before included minutes
  ([docs.github.com](https://docs.github.com/en/billing/reference/actions-runner-pricing),
  read 2026-11-05).
- **backmesh:** each job runs on its own 4-vCPU, 16 GiB `backmesh-4` VM, which
  bills from its boot until the job ends. The prices are spot prices in the
  lowest zone of one region per cloud, from the catalog on 2026-11-13
  (refreshed with the 2026-11-13 VM type reorder):

| Cloud | Region        | `backmesh-4` types and spot $/h                                                  |
| ----- | ------------- | -------------------------------------------------------------------------------- |
| AWS   | `us-east-2`   | `m8i.xlarge` 0.0583, `m7a.xlarge` 0.07, `m7i.xlarge` 0.0497, `m6a.xlarge` 0.0547 |
| Azure | `westus2`     | `Standard_D4ads_v5` 0.0381, `Standard_D4as_v5` 0.0318, `Standard_D4s_v5` 0.0355  |
| GCP   | `us-central1` | `n2-standard-4` 0.1165, `n2d-standard-4` 0.0899                                  |

- **The control plane:** two always-on VMs with their disks and public
  addresses, about $86 a month on AWS, $111 on Azure and $74 on GCP. An idle
  installation pays only this, since runners have no VM while idle.

## How it's computed

GitHub-hosted: 150,000 minutes × $0.012 = $1,800.

backmesh, for each cloud: the control plane plus 150,000 minutes at the
cheapest and at the most expensive type's spot price, $/h ÷ 60 a minute.

| Cloud | Spot $/h      | Per 1,000 minutes | 150,000 minutes | Control plane | Month     |
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

- **Boots.** Each job's VM bills from its boot: about 30 seconds on AWS and 60
  to 70 seconds on GCP and Azure. Per 1,000 jobs, that adds $0.41–$0.58 on
  AWS, $0.53–$0.74 on Azure and $1.50–$2.27 on GCP.
- **Disks.** Each runner has a 100 GB disk while its job runs. On AWS it's gp3
  at 4,000 IOPS and 500 MiB/s, about $0.038 an hour: $0.011 for storage and
  $0.027 for IOPS and throughput above gp3's baseline
  ([EBS pricing](https://aws.amazon.com/ebs/pricing/)).
- **Runners started ahead** of predicted or cued jobs that no job takes. Each
  bills for its boot and a short idle time.
- **Buckets.** The checkpoint bucket and the [cache](/cache/) buckets bill for
  what they store.
- **On-demand retries** after a spot reclaim.

Spot prices change by the hour and by zone, and other regions differ. On
demand cost about 1.7 to 5.4 times spot on 2026-11-13, depending on the type.

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
pulls the runner's image after it, about 90 seconds more.

## Estimate your own

1. Count your jobs' minutes a month at each size.
2. Run `backmesh install --org <org> --plan`, with `--runners <cloud>` for each
   cloud to compare. It prints each of those clouds' `backmesh-4` spot and
   on-demand prices and the control plane's monthly cost, without changing
   anything. Other sizes scale with their vCPUs:
   `backmesh-8` costs about twice `backmesh-4`.
3. Multiply each size's minutes by its price ÷ 60, add the control plane once,
   and add a boot per job if you run many short jobs.

Once jobs run, [`backmesh status`](/status/) shows each org's month-to-date
runner cost by cloud.
