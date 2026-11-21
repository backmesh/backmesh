---
title: 'GitHub-hosted vs self-hosted runners: what each costs in 2026'
description: What GitHub-hosted larger runners, ARC, terraform-aws-github-runner, RunsOn, WarpBuild BYOC, backmesh and managed runner services cost per minute and per month in November 2026, with the fixed costs and hidden costs of each and the volume where self-hosting pays off.
date: 2026-11-21
lastUpdated: 2026-11-21
authors: backmesh
tags:
  - Cost
excerpt: GitHub's 4-core Linux runner costs $0.012 a minute. A 4-vCPU spot VM in your own cloud costs about $0.0005 to $0.0019, but every self-hosted setup adds a fixed monthly cost and some hidden ones. Prices for each option, the fixed cost behind each, and the volume where self-hosting pays off.
head:
  - tag: title
    content: 'GitHub-hosted vs self-hosted runner cost (2026): ARC, RunsOn, WarpBuild, backmesh | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"GitHub-hosted vs self-hosted runners: what each costs in 2026","datePublished":"2026-11-21","dateModified":"2026-11-21","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/github-hosted-vs-self-hosted-runner-cost/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Are self-hosted GitHub Actions runners cheaper than GitHub-hosted runners?","acceptedAnswer":{"@type":"Answer","text":"Per minute, yes, for Linux jobs. A 4-vCPU spot VM cost about $0.0005 to $0.0019 a minute on AWS, GCP or Azure on 2026-11-13, against $0.012 for GitHub''s 4-core runner. Every self-hosted setup adds a fixed monthly cost, so self-hosting pays off only above a few thousand minutes a month. For backmesh that''s about 7,000 to 9,800 4-vCPU minutes, depending on the cloud."}},{"@type":"Question","name":"How much does a GitHub-hosted runner cost per minute in 2026?","acceptedAnswer":{"@type":"Answer","text":"In private repositories, Linux x64 costs $0.002 a minute for 1 core, $0.006 for 2 cores, $0.012 for 4, $0.022 for 8, $0.042 for 16, $0.082 for 32 and $0.162 for 64, per GitHub''s runner pricing page on 2026-11-21. GitHub rounds each job up to the nearest whole minute."}},{"@type":"Question","name":"Does GitHub charge for self-hosted runners?","acceptedAnswer":{"@type":"Answer","text":"No, as of 2026-11-21. GitHub announced a $0.002 per minute charge for self-hosted runners in private repositories on 2025-12-16 and postponed it on 2025-12-17, with no new date. Its billing docs list self-hosted runner usage as free."}},{"@type":"Question","name":"What fixed costs does a self-hosted runner setup have?","acceptedAnswer":{"@type":"Answer","text":"Each one has some. ARC needs a Kubernetes cluster, $0.10 an hour on EKS, about $73 a month. terraform-aws-github-runner uses API Gateway, SQS and Lambda, billed per request. RunsOn puts its control plane at from about $7 a month plus a yearly license for commercial use. WarpBuild BYOC''s AWS docs list one NAT gateway per availability zone among the quotas a stack needs, at $0.045 an hour each. backmesh runs two always-on VMs, about $86 a month on AWS, $74 on GCP and $111 on Azure."}},{"@type":"Question","name":"How many minutes a month before self-hosting pays off?","acceptedAnswer":{"@type":"Answer","text":"It depends on the fixed cost. By our arithmetic, backmesh''s control plane pays for itself at about 7,000 to 9,800 minutes a month of 4-vCPU jobs, and at about 15,400 to 15,700 minutes of 2-vCPU jobs on AWS. A setup with a larger fixed cost needs more minutes."}},{"@type":"Question","name":"What hidden costs does self-hosting add?","acceptedAnswer":{"@type":"Answer","text":"VM boot time, spot reclaims and on-demand reruns, disks, egress for cache and artifact traffic, and the hours someone spends running it. backmesh''s VMs take about 30 seconds to boot on AWS and 60 to 70 seconds on GCP and Azure, and each job starts with no Docker layer cache."}},{"@type":"Question","name":"What happens when a spot VM is reclaimed during a job?","acceptedAnswer":{"@type":"Answer","text":"The job fails. AWS gives a two-minute notice before it reclaims a spot instance. backmesh reruns a run''s failed jobs when reclaims were the only failures, preferring an on-demand runner, at most twice."}},{"@type":"Question","name":"Is backmesh faster than ubuntu-latest?","acceptedAnswer":{"@type":"Answer","text":"In backmesh''s benchmarks on 2026-11-18, backmesh-4 ran Docker, Rust and TypeScript builds 1.4 to 2.1 times faster than ubuntu-latest, at 2.8 to 5.5 times less per build, over 5 rounds each. Each backmesh job waited 43 to 50 seconds to start, against 2 seconds on ubuntu-latest."}},{"@type":"Question","name":"What can''t backmesh run?","acceptedAnswer":{"@type":"Answer","text":"backmesh runs Linux x86-64 jobs in private repositories only. It has no macOS, Windows or Arm runners, and its GPU runners are NVIDIA T4s on AWS and Azure. Keep macOS and Windows jobs on GitHub-hosted runners."}}]}]}'
---

A GitHub-hosted 4-core Linux runner costs $0.012 a minute in a private
repository. A self-hosted runner on a 4-vCPU spot VM in your own AWS, GCP or
Azure account costs about $0.0005 to $0.0019 a minute in compute, and GitHub
charges nothing for self-hosted minutes as of 2026-11-21. Every self-hosted
setup also has a fixed monthly cost for whatever starts the runners: a
Kubernetes cluster, Lambda functions, NAT gateways or a pair of VMs. At
150,000 minutes a month of 4-vCPU jobs, that's $1,800 on GitHub-hosted runners
and about $191 to $365 on backmesh, control plane included. Below about 7,000
to 9,800 4-vCPU minutes a month, backmesh's fixed cost eats the saving, and a
setup with a larger fixed cost needs more minutes.

Every GitHub price below comes from GitHub's docs, checked on 2026-11-21.
Third-party prices come from each vendor's own pricing or docs page on the
same day. backmesh publishes this page; its figures come from its
[cost page](/cost/) and [benchmarks](/benchmarks/).

## What each option costs

Per minute of a 4-vCPU Linux x64 job, and the fixed cost you pay whether or
not jobs run:

| Option                                                                                                              | Per 4-vCPU minute                        | Fixed cost each month                                                                                          | Who runs the machines |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------- |
| GitHub-hosted `linux_4_core`                                                                                        | $0.012                                   | None; $18 included on Team, $300 on Enterprise Cloud                                                           | GitHub                |
| [Actions Runner Controller](https://github.com/actions/actions-runner-controller) (ARC) on EKS                      | Your node prices                         | EKS charges $0.10 per cluster per hour, about $73 a month, plus the nodes that run ARC's controller            | You                   |
| [terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner)                    | Your EC2 spot prices                     | Per-request Lambda, API Gateway and SQS charges, plus a NAT gateway if runners sit in private subnets          | You                   |
| [RunsOn](https://runs-on.com/pricing/)                                                                              | $0.0013 spot, per RunsOn's page          | A €300 to €3,600 yearly license for commercial use, and a control plane RunsOn puts at "from about $7 a month" | You                   |
| [WarpBuild BYOC](https://www.warpbuild.com/pricing)                                                                 | $0.002 WarpBuild fee plus your VM        | NAT gateways listed in its AWS quotas (one per AZ), $0.045 an hour each on AWS                                 | You                   |
| [backmesh](https://github.com/backmesh/backmesh)                                                                    | $0.0005 to $0.0019 spot ([cost](/cost/)) | Two always-on VMs: about $86 on AWS, $74 on GCP, $111 on Azure                                                 | You                   |
| Managed services: [Namespace](https://namespace.so/pricing), [WarpBuild](https://www.warpbuild.com/pricing) managed | $0.008 for 4 vCPU and 16 GB              | None                                                                                                           | The vendor            |

Each row comes from these pages.

- GitHub's price is the `linux_4_core` SKU on its
  [runner pricing page](https://docs.github.com/en/billing/reference/actions-runner-pricing),
  and the included usage is from
  [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
  both read 2026-11-21.
- The EKS fee is from [AWS's EKS pricing](https://aws.amazon.com/eks/pricing/)
  for standard support, read 2026-11-21. 730 hours × $0.10 is $73. On GKE,
  [Google](https://cloud.google.com/kubernetes-engine/pricing) charges the same
  $0.10 per cluster per hour and gives $74.40 of free credit a month per
  billing account, enough for one zonal or Autopilot cluster.
- RunsOn's per-minute figure is its own table for an `m8a.xlarge` at a 7-day
  average spot price in us-east-1 with a 30 GB disk, and its license tiers
  and control plane figure are from the same
  [pricing page](https://runs-on.com/pricing/), read 2026-11-21.
- WarpBuild's $0.002 BYOC fee is from its
  [pricing page](https://www.warpbuild.com/pricing). Its
  [AWS BYOC docs](https://warpbuild.com/docs/ci/byoc/aws) list one NAT gateway
  per availability zone, three in all, among the quotas a stack needs. AWS
  charges [$0.045 per NAT gateway hour](https://aws.amazon.com/vpc/pricing/)
  in US East (Ohio).
  Both read 2026-11-21.
- backmesh's spot range is the 4-vCPU types in its catalog on 2026-11-13, and
  the control plane figures are from its [cost page](/cost/).
- Namespace lists $0.008 a minute prepaid for 4 vCPU and 16 GB, and $0.012
  overage. WarpBuild lists $0.008 for its managed 4 vCPU, 16 GB runner. Both
  read 2026-11-21.

All the self-hosted rows have a fixed cost. What differs is its size and
what you operate to keep it running.

## GitHub-hosted runners

GitHub bills each job by the minute and "rounds the minutes and partial
minutes each job uses up to the nearest whole minute"
([runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing),
read 2026-11-21). The Linux x64 prices in private repositories:

| Runner           | SKU                  | $/minute | 150,000 minutes a month |
| ---------------- | -------------------- | -------- | ----------------------- |
| Linux 1-core     | `actions_linux_slim` | $0.002   | $300                    |
| Linux 2-core     | `actions_linux`      | $0.006   | $900                    |
| Linux 4-core     | `linux_4_core`       | $0.012   | $1,800                  |
| Linux 8-core     | `linux_8_core`       | $0.022   | $3,300                  |
| Linux 16-core    | `linux_16_core`      | $0.042   | $6,300                  |
| Linux 32-core    | `linux_32_core`      | $0.082   | $12,300                 |
| Linux 64-core    | `linux_64_core`      | $0.162   | $24,300                 |
| Linux 4-core GPU | `linux_4_core_gpu`   | $0.052   | $7,800                  |

The monthly column is our arithmetic at list price. Each plan includes some
usage: $12 a month on Free, $18 on Pro and Team, and $300 on Enterprise Cloud
([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
read 2026-11-21). Larger runners can draw on that included usage on Team and
Enterprise Cloud, and they bill even in public repositories, per the same
page.

The price covers more than the VM. Each GitHub-hosted runner, apart from the
single-CPU one, "is a new virtual machine (VM) hosted by GitHub"
([GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)),
so jobs start clean and you maintain nothing. In backmesh's
[benchmarks](/benchmarks/), `ubuntu-latest` jobs waited a median 2 seconds to
start on 2026-11-18. You also get 10 GB of Actions cache per repository, and
cache beyond that costs $0.07 per GB a month
([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).

GitHub-hosted runners are the only option here with macOS. If you need
macOS, keep those jobs on GitHub whatever you do with Linux.

## The self-hosted runner fee

GitHub announced a $0.002 per minute "Actions cloud platform charge" for
self-hosted runners in private repositories on 2025-12-16, to start on
2026-03-01
([changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/)).
On 2025-12-17 it posted "We're postponing the announced billing change for
self-hosted GitHub Actions to take time to re-evaluate our approach"
([community discussion](https://github.com/orgs/community/discussions/182186)).

As of 2026-11-21, the discussion has no staff update with a new date, and
GitHub's billing docs list self-hosted runners as usage that "remains free
independently and does not reduce the included compute usage"
([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
The runner pricing page lists no self-hosted charge.

If the fee returns as announced, it adds $0.002 to every self-hosted row in
this post, including managed services whose machines register with GitHub as
self-hosted runners. At 150,000 minutes that's $300 a month. Our post on
[GitHub's self-hosted runner fee](/blog/github-self-hosted-runner-fee/) has
the history and what it would add at other volumes.

## DIY self-hosting: ARC and terraform-aws-github-runner

Both are free, open-source projects. You pay your cloud for the machines and
for the infrastructure that starts them.

ARC is a Kubernetes operator that GitHub maintains. It creates runner pods
when jobs queue and removes them after. The fixed cost is the cluster: $0.10
per cluster per hour on EKS, about $73 a month
([EKS pricing](https://aws.amazon.com/eks/pricing/)), or the same fee on GKE
less its $74.40 monthly credit for one cluster
([GKE pricing](https://cloud.google.com/kubernetes-engine/pricing)). On top
of that, ARC's controller and listener pods need nodes that stay up. Runner
pods share nodes, so the per-minute cost depends on how well you pack jobs
onto spot or on-demand node pools.

terraform-aws-github-runner runs on AWS only. Its
[docs](https://github-aws-runners.github.io/terraform-aws-github-runner/)
describe an API Gateway endpoint that receives GitHub's webhook, an SQS
queue, and Lambda functions that scale EC2 spot instances up and down. Runners
scale to zero when no workflows run, so the idle cost is the per-request
charges for those services, plus a NAT gateway at $0.045 an hour
([VPC pricing](https://aws.amazon.com/vpc/pricing/), US East (Ohio)) if your
runners sit in private subnets. Idle pools, if you configure them, keep
instances running.

Neither project charges a license fee. The cost that doesn't show up on the
cloud bill is the work: cluster and Helm chart upgrades for ARC, module bumps,
Lambda zips and AMIs for the Terraform module. Our side-by-side of
[ARC vs terraform-aws-github-runner vs backmesh](/blog/arc-vs-terraform-aws-github-runner-vs-backmesh/)
covers how each works.

## BYOC tools: backmesh, RunsOn and WarpBuild BYOC

These tools run each job on a VM in your cloud account and give you a single
install in place of a pipeline you build. Your cloud bills you for the VMs.

backmesh is free under Apache-2.0. `backmesh install` creates a control plane
of two always-on VMs, which cost about $86 a month on AWS, $74 on GCP and
$111 on Azure with their disks and public addresses ([cost](/cost/)). Each job
gets its own spot VM, deleted when the job ends. A 4-vCPU `backmesh-4` VM
cost $0.0497 to $0.07 an hour on AWS spot in us-east-2, $0.0318 to $0.0381 on
Azure in westus2 and $0.0899 to $0.1165 on GCP in us-central1, in backmesh's
catalog on 2026-11-13 ([cost](/cost/)).

RunsOn runs on AWS. Its [pricing page](https://runs-on.com/pricing/) lists a
free license for non-commercial use and €300 to €3,600 a year for commercial
use, by monthly job count. It puts its own control plane, a Fargate service
plus an S3 cache bucket and data transfer, at "from about $7 a month", and its
4-vCPU x64 spot figure at $0.0013 a minute.

WarpBuild BYOC runs on AWS, GCP or Azure and charges $0.002 a minute for Linux
runners on top of your cloud bill
([pricing](https://www.warpbuild.com/pricing)). Its
[AWS docs](https://warpbuild.com/docs/ci/byoc/aws) list a VPC, an S3 bucket
and one NAT gateway per availability zone, three in all, among the quotas a
stack needs. AWS charges $0.045 an hour per NAT gateway in US East (Ohio),
before data processing ([VPC pricing](https://aws.amazon.com/vpc/pricing/)).

For a side-by-side of two of these, see
[backmesh vs RunsOn](/blog/backmesh-vs-runs-on/).

## Managed runner services

Blacksmith, Depot, Namespace and WarpBuild's managed runners run the machines
for you and bill per minute, with no fixed cost on your cloud bill. Prices for
Linux x64, read 2026-11-21:

| Service                                         | Listed price                                            | Included                      |
| ----------------------------------------------- | ------------------------------------------------------- | ----------------------------- |
| [Blacksmith](https://www.blacksmith.sh/pricing) | $0.004 a minute for Ubuntu x64                          | 3,000 minutes a month         |
| [Depot](https://depot.dev/pricing)              | $0.006 a minute for its base 2-vCPU runner              | 2,000 minutes on the $20 plan |
| [Namespace](https://namespace.so/pricing)       | $0.008 prepaid, $0.012 overage, for 4 vCPU and 16 GB    | None listed                   |
| [WarpBuild](https://www.warpbuild.com/pricing)  | $0.004 for 2 vCPU and 8 GB, $0.008 for 4 vCPU and 16 GB | None listed                   |

Blacksmith and Depot don't list a 4-vCPU price on those pages, so we left it
out. At $0.008, a 4-vCPU managed minute is a third less than GitHub's $0.012
and 4 to 16 times a 4-vCPU spot VM's compute in backmesh's catalog. Your code and secrets run on the
vendor's machines.

## A month at four volumes

4-vCPU Linux jobs at list prices, before included usage. backmesh's range
runs from the cheapest month across AWS, GCP and Azure to the most expensive,
control plane included, at the 2026-11-13 spot prices on the
[cost page](/cost/). All figures are our arithmetic.

| Minutes a month | GitHub-hosted 4-core | backmesh on AWS | backmesh, all three clouds | Fee if it returns, $0.002 |
| --------------- | -------------------- | --------------- | -------------------------- | ------------------------- |
| 10,000          | $120                 | $94–$98         | $89–$117                   | $20                       |
| 50,000          | $600                 | $127–$144       | $127–$171                  | $100                      |
| 150,000         | $1,800               | $210–$261       | $191–$365                  | $300                      |
| 500,000         | $6,000               | $500–$669       | $376–$1,045                | $1,000                    |

At 10,000 minutes the saving is small, and on Azure the control plane alone
is $111. At 150,000 minutes backmesh costs 80% to 89% less than GitHub-hosted
4-core runners. The backmesh figures leave out boots, disks and on-demand
reruns, covered in the next section, so they're a floor.

The break-even for backmesh's fixed cost is our arithmetic too. Each 4-vCPU
minute moved from $0.012 to spot saves $0.010 to $0.0115, so the control plane
pays for itself at about 7,000 to 9,800 minutes a month, depending on the
cloud. At 2 vCPU, where GitHub charges $0.006, a `backmesh-2` VM on AWS cost
$0.024 to $0.0308 an hour on 2026-11-13
([benchmarks](/benchmarks/#method)), and the AWS control plane pays for itself
at about 15,400 to 15,700 minutes. The same logic applies to every
self-hosted option: the bigger its fixed cost, the more minutes it needs
before it beats GitHub.

Try your own minutes in the [cost calculator](/calculator/).

## The costs that aren't on the price list

Per-minute prices leave out several costs of self-hosting. These apply to any
setup that starts a fresh cloud VM per job, backmesh included.

| Cost                 | What it is                                                                                                                                                  | backmesh's figure                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| VM boot wait         | A fresh VM boots before the job starts, and bills while it boots                                                                                            | About 30 s on AWS, 60 to 70 s on GCP and Azure; $0.41 to $2.27 per 1,000 jobs ([cost](/cost/))                               |
| Spot reclaims        | The cloud takes a spot VM back; AWS gives a [two-minute notice](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html) | The job fails; backmesh reruns it, preferring on demand, at most twice ([FAQ](/faq/))                                        |
| On-demand reruns     | A rerun on demand costs more than spot                                                                                                                      | On demand cost 1.7 to 5.4 times spot on 2026-11-13 ([cost](/cost/))                                                          |
| No warm Docker cache | A new VM has no image layers from earlier jobs                                                                                                              | No Docker layer cache between jobs ([FAQ](/faq/))                                                                            |
| Disks                | Each runner has a disk while its job runs                                                                                                                   | 100 GB gp3 at 4,000 IOPS and 500 MiB/s on AWS, about $0.038 an hour ([cost](/cost/))                                         |
| Egress               | Cache, artifact and image-push traffic leaves your cloud                                                                                                    | Your cloud bills it ([from ubuntu-latest](/from-ubuntu-latest/)); backmesh's [cache](/cache/) has a bucket per runner region |
| Ops time             | Upgrades, quotas, failed boots, image changes                                                                                                               | `backmesh upgrade` and quota checks at install ([FAQ](/faq/))                                                                |

On egress, AWS gives
[100 GB of data transfer out to the internet free each month](https://aws.amazon.com/ec2/pricing/on-demand/)
across all services, and a NAT gateway adds $0.045 per GB it processes
([VPC pricing](https://aws.amazon.com/vpc/pricing/), US East (Ohio)), both
read 2026-11-21.

GitHub-hosted runners also start each job on a new VM, so they have no warm
Docker layer cache either. What they avoid is the boot wait you see, the
reclaims and the ops time.

In backmesh's
[benchmarks](/benchmarks/) on 2026-11-18, `backmesh-4` jobs waited a median 43
to 50 seconds to start, against 2 seconds on `ubuntu-latest`. backmesh starts
runners ahead of a run's later jobs, and a coding agent can run
`backmesh cue --in <seconds>` before it pushes. In 24 jobs each, cued jobs
waited a median 17 seconds against 100.5 seconds uncued
([cue benchmark](https://github.com/backmesh/backmesh/blob/main/benchmarks/cue/README.md#results)).

Ops time is the cost with no price on it. A Kubernetes cluster needs
upgrades, a Terraform pipeline needs module bumps, and any self-hosted setup
needs someone who answers when a runner doesn't start. Count those hours
against the saving before you switch.

## Speed changes the per-build cost

A faster runner finishes in fewer minutes, so the per-minute price doesn't
tell the whole story. backmesh built three pinned open-source projects 5 times
each on `ubuntu-latest` (2 vCPUs in a private repository) and on `backmesh-4`
spot VMs on AWS, on 2026-11-18
([benchmarks](/benchmarks/)):

| Workload              | `ubuntu-latest` runtime and cost | `backmesh-4` runtime and cost | Faster | Cheaper per build |
| --------------------- | -------------------------------- | ----------------------------- | ------ | ----------------- |
| Docker (k6 v0.54.0)   | 148 s, $0.018                    | 71 s, $0.0032                 | 2.1×   | 5.5×              |
| Rust (ripgrep 14.1.1) | 70 s, $0.012                     | 49 s, $0.0027                 | 1.4×   | 4.4×              |
| TypeScript (v5.6.3)   | 56 s, $0.006                     | 35 s, $0.0021                 | 1.6×   | 2.8×              |

The figures are medians of 5 rounds. backmesh's per-build cost counts its
cold start and its disk, and leaves out its control plane. Every run is linked
on the [benchmarks page](/benchmarks/#runs).

## backmesh's limits

backmesh runs Linux x86-64 jobs only, in private repositories only. It has no
macOS, Windows or Arm runners. Its GPU labels run an NVIDIA T4 on AWS and
Azure ([labels](/labels/#gpu)). Its image has fewer preinstalled toolchains
than `ubuntu-latest`, which setup actions add
([what differs](/from-ubuntu-latest/)). If you need macOS, Windows, Arm or
public repositories, keep those jobs on GitHub-hosted runners or pick another
option from the table above.

## Which to pick

| Your situation                                                  | Cheapest fit                                                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Under about 7,000 4-vCPU minutes a month                        | GitHub-hosted runners and your plan's included usage                                                                               |
| macOS jobs                                                      | GitHub-hosted runners                                                                                                              |
| You already run Kubernetes                                      | ARC on your cluster, since the cluster fee is already paid                                                                         |
| AWS only, and you want Windows or Arm                           | [terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner) or [RunsOn](https://runs-on.com/) |
| Linux jobs at volume, cloud credits to spend, AWS, GCP or Azure | A BYOC tool such as backmesh                                                                                                       |
| No cloud account to run CI in, or no one to own it              | A managed service, at about $0.004 to $0.008 a minute                                                                              |

If cloud credits are part of the decision, our post on
[paying for GitHub Actions with cloud credits](/blog/github-actions-cloud-credits/)
covers which programs pay for what. To cut minutes before changing runners,
see [how to cut your GitHub Actions bill](/blog/how-to-reduce-github-actions-costs/).

## Questions

### Are self-hosted GitHub Actions runners cheaper than GitHub-hosted runners?

Per minute, yes, for Linux jobs. A 4-vCPU spot VM cost about $0.0005 to $0.0019 a minute on AWS, GCP or Azure on 2026-11-13, against $0.012 for GitHub's 4-core runner. Every self-hosted setup adds a fixed monthly cost, so self-hosting pays off only above a few thousand minutes a month. For backmesh that's about 7,000 to 9,800 4-vCPU minutes, depending on the cloud.

### How much does a GitHub-hosted runner cost per minute in 2026?

In private repositories, Linux x64 costs $0.002 a minute for 1 core, $0.006 for 2 cores, $0.012 for 4, $0.022 for 8, $0.042 for 16, $0.082 for 32 and $0.162 for 64, per GitHub's runner pricing page on 2026-11-21. GitHub rounds each job up to the nearest whole minute.

### Does GitHub charge for self-hosted runners?

No, as of 2026-11-21. GitHub announced a $0.002 per minute charge for self-hosted runners in private repositories on 2025-12-16 and postponed it on 2025-12-17, with no new date. Its billing docs list self-hosted runner usage as free.

### What fixed costs does a self-hosted runner setup have?

Each one has some. ARC needs a Kubernetes cluster, $0.10 an hour on EKS, about $73 a month. terraform-aws-github-runner uses API Gateway, SQS and Lambda, billed per request. RunsOn puts its control plane at from about $7 a month plus a yearly license for commercial use. WarpBuild BYOC's AWS docs list one NAT gateway per availability zone among the quotas a stack needs, at $0.045 an hour each. backmesh runs two always-on VMs, about $86 a month on AWS, $74 on GCP and $111 on Azure.

### How many minutes a month before self-hosting pays off?

It depends on the fixed cost. By our arithmetic, backmesh's control plane pays for itself at about 7,000 to 9,800 minutes a month of 4-vCPU jobs, and at about 15,400 to 15,700 minutes of 2-vCPU jobs on AWS. A setup with a larger fixed cost needs more minutes.

### What hidden costs does self-hosting add?

VM boot time, spot reclaims and on-demand reruns, disks, egress for cache and artifact traffic, and the hours someone spends running it. backmesh's VMs take about 30 seconds to boot on AWS and 60 to 70 seconds on GCP and Azure, and each job starts with no Docker layer cache.

### What happens when a spot VM is reclaimed during a job?

The job fails. AWS gives a two-minute notice before it reclaims a spot instance. backmesh reruns a run's failed jobs when reclaims were the only failures, preferring an on-demand runner, at most twice.

### Is backmesh faster than ubuntu-latest?

In backmesh's benchmarks on 2026-11-18, backmesh-4 ran Docker, Rust and TypeScript builds 1.4 to 2.1 times faster than ubuntu-latest, at 2.8 to 5.5 times less per build, over 5 rounds each. Each backmesh job waited 43 to 50 seconds to start, against 2 seconds on ubuntu-latest.

### What can't backmesh run?

backmesh runs Linux x86-64 jobs in private repositories only. It has no macOS, Windows or Arm runners, and its GPU runners are NVIDIA T4s on AWS and Azure. Keep macOS and Windows jobs on GitHub-hosted runners.
