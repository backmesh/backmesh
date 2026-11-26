---
title: 'Blacksmith vs Depot vs runners in your own cloud'
description: Blacksmith and Depot run GitHub Actions jobs on their own machines and bill per minute. Runners in your own AWS, GCP or Azure account bill through your cloud. Prices at 2, 4 and 8 vCPUs, operating systems, caching, own-cloud options and when each one fits, checked on 2026-11-26.
date: 2026-11-26
lastUpdated: 2026-11-26
authors: backmesh
tags:
  - Comparisons
excerpt: Blacksmith lists $0.004 a minute for a 2-vCPU Linux runner and Depot $0.006, against GitHub's $0.006. Spot VMs in your own cloud cost less per minute but add always-on VMs and a boot wait per job. A side-by-side of Blacksmith, Depot, backmesh and RunsOn with GitHub-hosted as the baseline.
head:
  - tag: title
    content: 'Blacksmith vs Depot vs own-cloud runners: GitHub Actions prices (2026) | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"Blacksmith vs Depot vs runners in your own cloud","datePublished":"2026-11-26","dateModified":"2026-11-26","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/blacksmith-vs-depot-vs-own-cloud-runners/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is the difference between Blacksmith and Depot?","acceptedAnswer":{"@type":"Answer","text":"Both are managed GitHub Actions runners that bill per minute. Blacksmith runs jobs in Firecracker microVMs on its own bare-metal machines in US and EU data centers and lists $0.004 a minute for a 2-vCPU Linux x64 runner, with 3,000 free 2-vCPU minutes a month. Depot runs jobs on single-tenant EC2 instances, lists $0.006 a minute for 2 vCPUs, and sells plans from $20 a month with 2,000 minutes. Depot also sells container builds with a persistent layer cache, and offers a deployment in your own AWS account on its Business plan."}},{"@type":"Question","name":"Is Blacksmith cheaper than Depot?","acceptedAnswer":{"@type":"Answer","text":"Per minute on Linux, yes, on 2026-11-26. Blacksmith listed $0.004, $0.008 and $0.016 a minute at 2, 4 and 8 vCPUs on x64, and Depot $0.006, $0.012 and $0.024. On arm64 Blacksmith listed $0.0025 at 2 vCPUs and Depot $0.006. Both listed $0.008 for 2-vCPU Windows and $0.08 for macOS."}},{"@type":"Question","name":"Is Depot cheaper than GitHub-hosted runners?","acceptedAnswer":{"@type":"Answer","text":"Not per minute on Linux x64. On 2026-11-26 Depot listed $0.006 and $0.012 a minute at 2 and 4 vCPUs, the same as GitHub, and $0.024 at 8 vCPUs against GitHub''s $0.022. Depot is cheaper than GitHub on Windows, and its case rests on faster jobs and caching, which cut the minutes a job uses."}},{"@type":"Question","name":"Is there a Blacksmith alternative that runs in my own cloud account?","acceptedAnswer":{"@type":"Answer","text":"Blacksmith''s pricing, security and self-hosting pages describe only its own hardware. Runners in your own account include backmesh, free under Apache-2.0 on AWS, GCP and Azure, RunsOn on AWS under a yearly license, and Depot''s own-AWS deployment on its Business plan."}},{"@type":"Question","name":"Can Depot run in my own AWS account?","acceptedAnswer":{"@type":"Answer","text":"Yes, on the Business plan. Depot Managed on AWS puts the build compute and cache in a dedicated sub-account of your AWS organization, and Depot must enable it for your organization. Depot''s pricing page lists it only on Business, which has custom pricing."}},{"@type":"Question","name":"Which runners support macOS, Windows and arm64?","acceptedAnswer":{"@type":"Answer","text":"Blacksmith and Depot both run Linux x64, Linux arm64, Windows and macOS jobs. RunsOn runs Linux x64 and arm64, Windows and GPU jobs on AWS. backmesh runs Linux x86-64 and arm64 (arm64 on AWS and GCP), with NVIDIA T4 GPUs on AWS and Azure."}},{"@type":"Question","name":"Do Blacksmith and Depot keep a Docker layer cache?","acceptedAnswer":{"@type":"Answer","text":"Yes. Blacksmith stores Docker layer caches on sticky disks at $0.50 per GB a month, through its own setup-docker-builder and build-push-action. Depot keeps a persistent layer cache per project for its container builds, 50 GB by default, at $0.20 per GB a month past the plan''s allowance. backmesh keeps no Docker layer cache between jobs, since each job starts on a new VM."}},{"@type":"Question","name":"Can AWS, GCP or Azure credits pay for Blacksmith or Depot?","acceptedAnswer":{"@type":"Answer","text":"Their pricing pages bill per minute on their own plans, so credits in your cloud account don''t cover those minutes. Runners in your own cloud account bill to that account, so its credits and committed-spend discounts apply."}},{"@type":"Question","name":"When is a managed runner a better pick than runners in my own cloud?","acceptedAnswer":{"@type":"Answer","text":"When you need macOS, Windows or arm64, when Docker builds dominate CI and a warm layer cache matters, when you have no cloud account or credits to use, or when your volume is small enough that always-on VMs would cost more than the per-minute savings. Every self-hosted setup in your own account has a fixed cost for the VMs that manage it."}}]}]}'
---

Blacksmith and Depot are managed GitHub Actions runners: your jobs run on
their machines and they bill you per minute. On 2026-11-26 Blacksmith listed
$0.004 a minute for a 2-vCPU Linux x64 runner and Depot $0.006, against
GitHub's $0.006. Runners in your own AWS, GCP or Azure account, such as
backmesh or RunsOn, bill through your cloud at spot prices, which are lower
per minute, and add a fixed monthly cost for the VMs that manage them plus a
VM boot per job. Blacksmith is the cheaper of the two managed services per
minute on Linux. Depot is built around Docker builds and is the only one of
the two that offers a deployment in your own AWS account, on its Business
plan.

Every Blacksmith and Depot figure below comes from their own pricing pages
and docs, read on 2026-11-26. backmesh publishes this page, and backmesh's
figures come from its [cost page](/cost/).

## At a glance

|                       | [Blacksmith](https://www.blacksmith.sh/pricing)                                                                                                                                              | [Depot](https://depot.dev/pricing)                                                                                                                                             | Runners in your own cloud (backmesh, RunsOn)                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Where jobs run        | Firecracker microVMs on Blacksmith's bare-metal machines in US and EU data centers ([security](https://www.blacksmith.sh/security))                                                          | Single-tenant EC2 instances run by Depot ([runners](https://depot.dev/docs/github-actions/overview))                                                                           | VMs in your AWS, GCP or Azure account                                                                                                  |
| Who bills the compute | Blacksmith, per minute                                                                                                                                                                       | Depot, per minute, on a plan                                                                                                                                                   | Your cloud; backmesh is free, RunsOn adds a yearly license for commercial use                                                          |
| Plan fee              | None listed; Enterprise on request                                                                                                                                                           | $20 a month (Developer), $200 (Startup), custom (Business)                                                                                                                     | backmesh none; RunsOn €300 to €3,600 a year ([pricing](https://runs-on.com/pricing/))                                                  |
| Included minutes      | 3,000 2-vCPU x64 minutes a month per org                                                                                                                                                     | 2,000 (Developer), 20,000 (Startup)                                                                                                                                            | None; you pay your cloud from the first minute                                                                                         |
| Fixed cost            | None                                                                                                                                                                                         | The plan fee                                                                                                                                                                   | Always-on VMs that run the setup; for backmesh about $50 to $68 a month for one org ([cost](/cost/))                                   |
| Operating systems     | Linux x64 and arm64, Windows x64 (listed on their pricing page; their docs still call it a public beta), macOS M4 ([instance types](https://docs.blacksmith.sh/blacksmith-runners/overview)) | Linux x64 and arm64, Windows, macOS ([runner types](https://depot.dev/docs/github-actions/runner-types))                                                                       | backmesh: Linux x86-64 and arm64 (arm64 on AWS and GCP), T4 GPUs on AWS and Azure. RunsOn: Linux x64 and arm64, Windows, GPU, AWS only |
| Dependency cache      | `actions/cache` goes to Blacksmith's co-located cache with no change; 25 GB free per repo ([cache](https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions))                      | `actions/cache` goes to Depot Cache with no change ([cache](https://depot.dev/docs/cache/integrations/github-actions))                                                         | backmesh: `backmesh/cache` and automatic `setup-*` and npm, Yarn and pnpm caches in a bucket in your account ([cache](/cache/))        |
| Docker layer cache    | Sticky disks, $0.50 per GB a month ([Docker builds](https://docs.blacksmith.sh/blacksmith-caching/docker-builds))                                                                            | Persistent layer cache per project for container builds, $0.20 per GB a month past the plan's allowance ([container builds](https://depot.dev/docs/container-builds/overview)) | backmesh: none, each job starts on a new VM. RunsOn: an ECR layer cache                                                                |
| Own-cloud option      | None described on its pricing, security or [self-hosting](https://www.blacksmith.sh/self-hosting) pages                                                                                      | Business plan only: compute and cache in a dedicated AWS sub-account ([Depot Managed](https://depot.dev/docs/managed/on-aws))                                                  | Runs only in your account                                                                                                              |

## Prices per minute at 2, 4 and 8 vCPUs

Linux x64, the size most CI jobs use. GitHub-hosted is the baseline, at list
price before a plan's included usage.

| vCPUs | [GitHub-hosted](https://docs.github.com/en/billing/reference/actions-runner-pricing) | [Blacksmith](https://www.blacksmith.sh/pricing) | [Depot](https://depot.dev/docs/github-actions/runner-types) | backmesh, spot VM in your account |
| ----- | ------------------------------------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| 2     | $0.006                                                                               | $0.004                                          | $0.006                                                      | about $0.0003 to $0.0010          |
| 4     | $0.012                                                                               | $0.008                                          | $0.012                                                      | about $0.0005 to $0.0019          |
| 8     | $0.022                                                                               | $0.016                                          | $0.024                                                      | about $0.0011 to $0.0039          |

GitHub, Blacksmith and Depot prices were read on 2026-11-26. backmesh's 4-vCPU
range is the spot price of `backmesh-ubuntu-2404-4vcpu`'s VM types across
AWS, GCP and Azure on 2026-11-13, from Azure's cheapest type to GCP's
priciest ([cost](/cost/)). The 2-vCPU and 8-vCPU rows scale that range by
vCPU count, as the cost page says sizes do. They are arithmetic, not
measured, and they leave out the always-on VMs, disks and the boot each job
pays for.

Blacksmith costs 33% less than GitHub at 2 and 4 vCPUs and 27% less at 8.
Depot matches GitHub at 2 and 4 vCPUs and costs more at 8 ($0.024 against
$0.022), so its case rests on faster jobs and Docker builds that use fewer
minutes. Spot VMs in your own account cost about 4 to 22 times less per
minute than the three, before the fixed costs.

### Other operating systems

| 2 vCPUs unless noted | GitHub-hosted         | Blacksmith        | Depot                    | backmesh                                                        |
| -------------------- | --------------------- | ----------------- | ------------------------ | --------------------------------------------------------------- |
| Linux arm64          | $0.005                | $0.0025           | $0.006                   | Spot VM in your account, AWS and GCP ([labels](/labels/#arm64)) |
| Windows              | $0.010                | $0.008            | $0.008                   | None                                                            |
| macOS                | $0.062 (3 or 4 cores) | $0.08 (6 vCPU M4) | $0.08 (`depot-macos-26`) | None                                                            |

On arm64 Blacksmith listed $0.005 at 4 vCPUs and $0.01 at 8, and Depot
$0.012 and $0.024, the same as its x64 prices. On Windows Blacksmith listed
$0.016 at 4 vCPUs and $0.032 at 8, and Depot the same. backmesh runs no
Windows or macOS, and runs arm64 on AWS and GCP. RunsOn runs arm64 and Windows on AWS.

## What a month costs

The same workload as on backmesh's [cost page](/cost/): 150,000 minutes a
month of 4-vCPU Linux jobs. These are list prices, arithmetic, not measured.
A faster runner would use fewer minutes, which this leaves out for every
column.

| Runner        | How it's computed                                                                                                 | Month            |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| GitHub-hosted | 150,000 × $0.012, before included usage                                                                           | $1,800           |
| Blacksmith    | 150,000 × $0.008, less 3,000 free 2-vCPU minutes, which are 1,500 4-vCPU minutes ($12)                            | $1,188           |
| Depot         | Startup plan $200 plus 150,000 × $0.012, less whatever share of the 20,000 included minutes 4-vCPU jobs draw down | $1,760 to $2,000 |
| backmesh      | Spot VMs plus one org's always-on VMs, by cloud                                                                   | $148 to $341     |

Blacksmith's docs count free minutes as 2-vCPU x64 minutes: a 2-vCPU Arm
minute uses 0.625 of them, a 2-vCPU Windows minute 2 and a 6-vCPU macOS
minute 20, and larger runners use them in proportion to their vCPUs, so a
4-vCPU x64 minute uses two
([instance types](https://docs.blacksmith.sh/blacksmith-runners/overview)).
Depot's docs say larger runners use multipliers against included minutes
([runners](https://depot.dev/docs/github-actions/overview)) but don't give the
multiplier, so the Depot row is a range: $1,760 if the included minutes
counted one for one, $2,000 if they covered none. Storage for
caches is extra on both. backmesh's range is the [cost page](/cost/)'s:
Azure's $148 to GCP's $341, with the always-on VMs included and disks and
boots left out.

At small volumes the order flips. One org's always-on VMs on backmesh cost
about $50 to $68 a month whether jobs run or not. Blacksmith's free tier
covers 3,000 2-vCPU minutes, so a team that runs 15,000 2-vCPU minutes a month pays
Blacksmith $48 (12,000 × $0.004), less than the lowest of those always-on
costs. Use the
[calculator](/calculator/) with your own minutes.

## How each one works

### Blacksmith

Blacksmith runs each job in an ephemeral Firecracker microVM on bare-metal
machines it runs in data centers in the US and EU. Its
[security page](https://www.blacksmith.sh/security) says jobs never share
kernels, the VM is destroyed when the job ends, and it is SOC 2 Type 2. You
change `runs-on` to a label such as `blacksmith-4vcpu-ubuntu-2404`.

Its docs say microVMs boot in under 3 seconds and that it has
[no concurrency limits](https://docs.blacksmith.sh/blacksmith-runners/concurrency).
`actions/cache` and the `setup-*` actions' caches go to a cache next to the
runners with no workflow change, with 25 GB free per repository and the
same 7-day eviction as GitHub's. For larger state, sticky disks mount a
persisted ext4 disk at a path you choose, and Docker layer caching uses
sticky disks through `useblacksmith/setup-docker-builder` and
`useblacksmith/build-push-action`, both at $0.50 per GB a month. A Docker
layer cache is evicted after 7 days without use. Jobs that can wait up to 24
hours to start can use
[flex scheduling](https://docs.blacksmith.sh/blacksmith-runners/flex-scheduling)
at 40% off.

### Depot

Depot runs each job on an ephemeral, single-tenant EC2 instance: AMD
instances for Intel labels and Graviton4 for arm64, with 8,000 IOPS disks and
a RAM-backed disk accelerator on Linux
([runner types](https://depot.dev/docs/github-actions/runner-types)). You
change `runs-on` to a label such as `depot-ubuntu-24.04-4`. Depot tracks jobs
by the second and bills whole minutes at the end of the month, with no
one-minute minimum per job
([runners](https://depot.dev/docs/github-actions/overview)).

Depot's runners send `actions/cache` and the `setup-*` caches to Depot Cache
with no workflow change, scoped to the repository that saved them, with a
default 14-day retention. Depot's other product is container builds:
`depot/build-push-action` sends a build to a BuildKit builder next to the
runner, 16 vCPUs by default at $0.04 a minute, with a persistent layer cache
per project that the whole team shares, 50 GB by default
([container builds](https://depot.dev/docs/container-builds/overview)). The
Developer plan includes 500 build minutes and Startup 5,000.

Depot is the only one of the two managed services with an own-cloud option.
[Depot Managed on AWS](https://depot.dev/docs/managed/on-aws) puts the build
compute and cache in a dedicated sub-account of your AWS organization, while
you still use Depot's CLI, web app and API. Depot has to enable it for your
organization, and its [pricing page](https://depot.dev/pricing) lists
"Deploy in your AWS account" on the Business plan only, which has custom
pricing.

### Runners in your own cloud

backmesh runs each job on its own spot VM in your AWS, GCP or Azure account
and deletes it when the job ends. `backmesh install` creates a control plane
VM and a listener VM per org in your account. The listener long-polls GitHub,
so nothing needs an inbound port. Labels pick a size and a cloud, for example
`runs-on: backmesh-ubuntu-2404-4vcpu` or `backmesh-gcp-ubuntu-2404-4vcpu`
([labels](/labels/)). It's free under Apache-2.0.

RunsOn is the other common option for this model on AWS. It runs each job on
EC2 in your AWS account, supports Linux x64 and arm64, Windows and GPU
instances, and charges €300 to €3,600 a year for commercial use, by jobs a
month ([pricing](https://runs-on.com/pricing/)). For a side-by-side, see
[backmesh vs RunsOn](/blog/backmesh-vs-runs-on/).

Both carry a fixed cost for what manages the runners, as every self-hosted
setup in your own account does. On backmesh it's the control plane VM and one
listener VM per org, about $56 a month on AWS, $50 on GCP and $68 on Azure
for one org ([cost](/cost/)).

## The tradeoffs

### Managed: Blacksmith and Depot

- There is nothing to run. No always-on VMs, no cloud quotas to raise, no
  install.
- Jobs start fast. Blacksmith states sub-3-second microVM boots, and both
  keep caches warm next to their runners.
- Docker layer caching works across jobs on both, for a storage fee.
- macOS, Windows and arm64 are on the same bill.
- Your code and the secrets a job uses run on the vendor's machines for the
  length of the job. Blacksmith's security page says its GitHub App can't
  read repository or org secrets directly, but the job itself has them, as
  on any runner.
- They invoice you directly, so startup credits or committed spend in your
  AWS, GCP or Azure account don't pay for the minutes. See
  [paying for GitHub Actions with cloud credits](/blog/github-actions-cloud-credits/).
- The per-minute price is about 4 to 22 times a spot VM's, so the gap grows
  with volume.

### Your own cloud: backmesh, RunsOn

- Your cloud bills the compute, so credits, savings plans and committed-use
  discounts apply.
- Code, secrets, caches and logs stay in your account. backmesh's
  [security model](/security/) lists what does reach it.
- The always-on VMs cost money every month, jobs or not.
- Each job waits about 40 s for its VM to boot, about 10 s when cued. The [benchmarks](/benchmarks/) have
  backmesh's latest measured wait on AWS. backmesh starts runners ahead of a
  run's later jobs, and `backmesh cue` lets a coding agent start them before
  it pushes.
- Spot VMs can be reclaimed. On backmesh a reclaimed job fails, and when
  reclaims were a run's only failures backmesh reruns its failed jobs once
  the run finishes, preferring on demand, at most twice. A spot label falls
  back to on demand when the cloud has no spot capacity
  ([on demand](/labels/#on-demand)).
- You raise your own cloud quotas. Runners past a quota wait at GitHub.
- On backmesh, each job starts on a new VM with no Docker layer cache, and
  only Linux x86-64 and arm64 (arm64 on AWS and GCP) jobs run, in private repositories unless you turn on
  [public repositories](/public-repos/).

## Which to pick

Pick Blacksmith if you want the lowest managed per-minute price on Linux,
need arm64, Windows or macOS without running anything, run bursty CI that
would hit a concurrency cap, or use less CI than the always-on VMs of a
self-hosted setup would cost.

Pick Depot if Docker builds are most of your CI time, since its container
builds share a persistent layer cache across the team and its runners sit
next to the builders. Depot is also the managed pick if you want the vendor
to run things inside your own AWS account and can buy its Business plan.

Pick runners in your own cloud if you run tens of thousands of Linux minutes
a month, have cloud credits or committed spend to use, or need code and
secrets to stay in your account. Pick backmesh for GCP, Azure or several
clouds, or for no license fee. Pick RunsOn if you are on AWS and need arm64,
Windows or a Docker layer cache.

All of them take jobs by `runs-on` label, so you can mix them: macOS or
Docker-heavy jobs on a managed service and the bulk of Linux jobs in your
account. [Coming from ubuntu-latest](/from-ubuntu-latest/) lists what
changes on backmesh's image, and
[how to cut your GitHub Actions bill](/blog/how-to-reduce-github-actions-costs/)
covers the workflow fixes to make first.

## Questions

### What is the difference between Blacksmith and Depot?

Both are managed GitHub Actions runners that bill per minute. Blacksmith runs
jobs in Firecracker microVMs on its own bare-metal machines in US and EU data
centers and lists $0.004 a minute for a 2-vCPU Linux x64 runner, with 3,000
free 2-vCPU minutes a month. Depot runs jobs on single-tenant EC2 instances,
lists $0.006 a minute for 2 vCPUs, and sells plans from $20 a month with
2,000 minutes. Depot also sells container builds with a persistent layer
cache, and offers a deployment in your own AWS account on its Business plan.

### Is Blacksmith cheaper than Depot?

Per minute on Linux, yes, on 2026-11-26. Blacksmith listed $0.004, $0.008
and $0.016 a minute at 2, 4 and 8 vCPUs on x64, and Depot $0.006, $0.012 and
$0.024. On arm64 Blacksmith listed $0.0025 at 2 vCPUs and Depot $0.006. Both
listed $0.008 for 2-vCPU Windows and $0.08 for macOS.

### Is Depot cheaper than GitHub-hosted runners?

Not per minute on Linux x64. On 2026-11-26 Depot listed $0.006 and $0.012 a
minute at 2 and 4 vCPUs, the same as GitHub, and $0.024 at 8 vCPUs against
GitHub's $0.022. Depot is cheaper than GitHub on Windows, and its
case rests on faster jobs and caching, which cut the minutes a job uses.

### Is there a Blacksmith alternative that runs in my own cloud account?

Blacksmith's pricing, security and self-hosting pages describe only its own
hardware. Runners in your own account include backmesh, free under
Apache-2.0 on AWS, GCP and Azure, RunsOn on AWS under a yearly license, and
Depot's own-AWS deployment on its Business plan.

### Can Depot run in my own AWS account?

Yes, on the Business plan. Depot Managed on AWS puts the build compute and
cache in a dedicated sub-account of your AWS organization, and Depot must
enable it for your organization. Depot's pricing page lists it only on
Business, which has custom pricing.

### Which runners support macOS, Windows and arm64?

Blacksmith and Depot both run Linux x64, Linux arm64, Windows and macOS jobs.
RunsOn runs Linux x64 and arm64, Windows and GPU jobs on AWS. backmesh runs
Linux x86-64 and arm64 (arm64 on AWS and GCP), with NVIDIA T4 GPUs on AWS and
Azure.

### Do Blacksmith and Depot keep a Docker layer cache?

Yes. Blacksmith stores Docker layer caches on sticky disks at $0.50 per GB a
month, through its own `setup-docker-builder` and `build-push-action`. Depot
keeps a persistent layer cache per project for its container builds, 50 GB
by default, at $0.20 per GB a month past the plan's allowance. backmesh
keeps no Docker layer cache between jobs, since each job starts on a new VM.

### Can AWS, GCP or Azure credits pay for Blacksmith or Depot?

Their pricing pages bill per minute on their own plans, so credits in your
cloud account don't cover those minutes. Runners in your own cloud account
bill to that account, so its credits and committed-spend discounts apply.

### When is a managed runner a better pick than runners in my own cloud?

When you need macOS, Windows or arm64, when Docker builds dominate CI and a
warm layer cache matters, when you have no cloud account or credits to use,
or when your volume is small enough that always-on VMs would cost more than
the per-minute savings. Every self-hosted setup in your own account has a
fixed cost for the VMs that manage it.
