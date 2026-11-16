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
- **Disks.** Each runner has a 100 GB disk while its job runs, about $0.01 an
  hour on AWS.
- **Runners started ahead** of predicted or cued jobs that no job takes. Each
  bills for its boot and a short idle time.
- **Buckets.** The checkpoint bucket and the [cache](/cache/) buckets bill for
  what they store.
- **On-demand retries** after a spot reclaim.

Spot prices change by the hour and by zone, and other regions differ. On
demand cost about 1.7 to 5.4 times spot on 2026-11-13, depending on the type.

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
