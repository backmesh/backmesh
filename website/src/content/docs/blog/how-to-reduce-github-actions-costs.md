---
title: 'How to cut your GitHub Actions bill'
description: Why GitHub Actions bills grow and how to cut them in 2026. Find the cost in the usage report, fix workflows that waste minutes, then pick cheaper runners, with current prices, YAML and a worked monthly bill.
date: 2026-11-18
lastUpdated: 2026-11-18
authors: backmesh
tags:
  - Cost
excerpt: Most GitHub Actions bills shrink in two passes. First stop paying for minutes you don't need, with concurrency, path filters, timeouts and caching. Then move what's left to cheaper runners. Current prices, YAML for each fix and a worked monthly bill.
head:
  - tag: title
    content: 'How to reduce GitHub Actions costs (2026): fixes and cheaper runners | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"How to cut your GitHub Actions bill","datePublished":"2026-11-18","dateModified":"2026-11-18","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/how-to-reduce-github-actions-costs/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"How much does GitHub Actions cost in 2026?","acceptedAnswer":{"@type":"Answer","text":"In private repositories GitHub bills per minute by runner: $0.002 for the 1-core ubuntu-slim runner, $0.006 for Linux 2-core x64, $0.005 for Linux 2-core arm64, $0.012 for Linux 4-core, $0.010 for Windows 2-core and $0.062 for macOS 3-core or 4-core. Each month includes $12 of usage on Free, $18 on Pro and Team and $300 on Enterprise Cloud. Standard runners in public repositories are free."}},{"@type":"Question","name":"Why does our GitHub Actions bill keep going up?","acceptedAnswer":{"@type":"Answer","text":"Usually because more runs happen: more pull requests and pushes, including from coding agents, superseded runs that keep going, workflows that run on every change, and matrices that grow. Copilot code review on private repositories has also consumed Actions minutes since 2026-06-01, and since 2026-10-28 cloud sandboxes draw from the same included pool."}},{"@type":"Question","name":"Does GitHub round job time up?","acceptedAnswer":{"@type":"Answer","text":"Yes. GitHub rounds the minutes and partial minutes each job uses up to the nearest whole minute, so a 10-second job bills one full minute."}},{"@type":"Question","name":"What is the default job timeout in GitHub Actions?","acceptedAnswer":{"@type":"Answer","text":"360 minutes. A hung job runs for six hours before GitHub cancels it unless you set timeout-minutes lower."}},{"@type":"Question","name":"Does Copilot code review use GitHub Actions minutes?","acceptedAnswer":{"@type":"Answer","text":"Yes, on private repositories since 2026-06-01. Each review consumes Actions minutes from your plan''s included usage, and usage beyond it bills at standard Actions rates."}},{"@type":"Question","name":"Can a bigger runner be cheaper?","acceptedAnswer":{"@type":"Answer","text":"Yes, when the job is CPU-bound. A 4-core Linux runner costs twice the 2-core price, so it is cheaper whenever it finishes the job in less than half the time. An 8-core runner at $0.022 beats a 4-core at $0.012 when it cuts the time below about 55%."}},{"@type":"Question","name":"Are self-hosted runners free?","acceptedAnswer":{"@type":"Answer","text":"GitHub charges nothing for them as of 2026-11-18, and they don''t reduce included usage. You pay for the machines. GitHub announced a $0.002 per minute fee for self-hosted runners in private repositories in December 2025 and postponed it the next day, with no new date."}},{"@type":"Question","name":"How much cheaper are third-party runners?","acceptedAnswer":{"@type":"Answer","text":"For a 2-vCPU Linux runner, on 2026-11-18 Blacksmith listed $0.004 a minute, WarpBuild $0.004, Namespace $0.002 prepaid or $0.003 overage, and Ubicloud $0.0012, against GitHub''s $0.006. Depot listed $0.006. Spot VMs in your own cloud cost less per minute but add a fixed cost for whatever manages them."}},{"@type":"Question","name":"What does backmesh cost and what are its limits?","acceptedAnswer":{"@type":"Answer","text":"backmesh is free, open-source software. Your cloud bills you for spot VMs and a control plane VM and a listener VM per org (t3.large and t3.small on AWS), about $74 to $111 a month for one org. It runs Linux x86-64 and arm64 jobs, in private repositories unless you turn on public repositories with --public-repos, with no macOS or Windows runners and GPU runners on AWS and Azure only, and a spot reclaim can fail a job, which backmesh reruns."}}]}]}'
---

To cut a GitHub Actions bill, first find which repositories, workflows and
runner types cost the most, then stop paying for minutes you don't need, then
move the minutes that remain to cheaper runners. The workflow fixes cost
nothing but a pull request each. Runner changes take more
work and cut the price of each minute that's left.

Every GitHub price below links to GitHub's docs and was checked on
2026-11-18. Third-party prices come from each vendor's pricing page on the
same day.

## Find where the money goes

In an organization, open "Billing & Licensing", then "Metered usage". The chart can be grouped by SKU, which is
GitHub's name for a runner type such as `actions_linux` or `actions_macos`.
"Get usage report" emails a CSV
([GitHub docs](https://docs.github.com/en/billing/how-tos/products/view-productlicense-use)).
The detailed report has `repository`, `workflow_path`, `sku`, `quantity` and
`net_amount` columns
([field list](https://docs.github.com/en/billing/reference/billing-reports)).
Sum `net_amount` by `workflow_path` and `sku` to rank workflows by cost, and
fix the top of that list first.

Then compare what each runner costs. Per minute, in private repositories
([runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)):

| Runner                       | SKU                  | $/minute |
| ---------------------------- | -------------------- | -------- |
| Linux 1-core (`ubuntu-slim`) | `actions_linux_slim` | $0.002   |
| Linux 2-core arm64           | `actions_linux_arm`  | $0.005   |
| Linux 2-core x64             | `actions_linux`      | $0.006   |
| Linux 4-core x64             | `linux_4_core`       | $0.012   |
| Linux 8-core x64             | `linux_8_core`       | $0.022   |
| Linux 16-core x64            | `linux_16_core`      | $0.042   |
| Windows 2-core               | `actions_windows`    | $0.010   |
| macOS 3-core or 4-core       | `actions_macos`      | $0.062   |
| macOS 12-core                | `macos_l`            | $0.077   |

A macOS minute costs about ten times a Linux 2-core minute. A Windows minute
costs 1.7 times as much.

Four billing rules decide how far minutes stretch:

- GitHub "rounds the minutes and partial minutes each job uses up to the
  nearest whole minute"
  ([runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)).
  A 10-second job bills one minute.
- Each month includes $12 of usage on Free, $18 on Pro and Team, and $300 on
  Enterprise Cloud
  ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
  At $0.006 that's 2,000, 3,000 and 50,000 Linux 2-core minutes.
- Since 2026-06-01, each Copilot code review on a private repository consumes
  Actions minutes from that included usage, and usage beyond it bills at
  standard Actions rates
  ([changelog](https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/)).
  Since 2026-10-28, cloud sandboxes draw from the same dollar pool
  ([changelog](https://github.blog/changelog/2026-10-28-work-from-anywhere-with-a-new-connected-copilot-cloud-experience)).
- Artifact storage includes 500 MB on Free, 1 GB on Pro, 2 GB on Team and
  50 GB on Enterprise Cloud, shared with GitHub Packages. Cache storage
  includes 10 GB per repository, and beyond that costs $0.07 per GB a month.
  Storage accrues hourly
  ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).

So a bill that keeps going up usually has more runs behind it: more pull
requests, more pushes per pull request, more matrix entries, and now Copilot
reviews and sandboxes drawing from the same included pool.

## Fix the workflows first

These changes cost nothing but a pull request. Apply them to the workflows at
the top of your usage report.

### Cancel superseded runs

Every push to a pull request starts a new run, and the old one keeps billing
until it ends. A `concurrency` group with `cancel-in-progress` stops it. GitHub
says `cancel-in-progress: true` cancels "any currently running job or workflow
in the same concurrency group"
([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

The condition keeps runs on `main` from cancelling each other, which matters
for deploys.

### Skip changes that can't affect the result

With `paths-ignore`, a workflow doesn't run when every changed file matches.
With `paths`, it runs when at least one does
([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).

```yaml
on:
  pull_request:
    paths-ignore:
      - 'docs/**'
      - '**.md'
```

If the workflow is a required check, a skipped run leaves the check
"Pending" and blocks the merge, per the same page. Either keep path filters off
required workflows, or use a small always-run job that reports success.

### Don't run full CI on drafts

By default a `pull_request` workflow runs on `opened`, `synchronize` and
`reopened`
([events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)).
Add `ready_for_review` and skip drafts, so CI runs once the author asks for
review:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  test:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
```

### Set timeouts

A job's `timeout-minutes` defaults to 360
([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).
A hung job runs six hours: $4.32 on a 4-core Linux runner and $22.32 on macOS
3-4 core (our arithmetic, 360 minutes × the per-minute price). Set a limit a
little above the job's normal time:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
```

### Trim matrices and merge tiny jobs

A matrix of 3 OS × 4 language versions is 12 jobs on every push. Run the full
matrix on `main` or nightly, and one or two entries on pull requests.

Rounding makes tiny jobs expensive. Six lint jobs of 20 seconds each bill six
minutes. One job that runs all six checks in about 2 minutes bills two (our
example). Each job also repeats checkout and setup, so merging saves real
time too.

### Cache dependencies

The `setup-node`, `setup-python`, `setup-java`, `setup-go`, `setup-ruby` and
`setup-dotnet` actions can create and restore dependency caches with one
input
([dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)):

```yaml
- uses: actions/setup-node@v7
  with:
    node-version: 22
    cache: npm
```

GitHub removes cache entries not accessed in over 7 days, and the limit is
10 GB per repository by default, per the same page. Build cache keys from a lockfile
hash so a dependency change makes a new cache.

### Keep lint off macOS

One r/devops thread is titled
"[We accidentally spent $300/month running lint on macOS runners](https://www.reddit.com/r/devops/comments/1tj0gdi/)".
It's an easy mistake: a matrix includes `macos-latest` and every job inherits
it, including ones that only format text. Lint, type checks and unit tests
that don't touch Apple SDKs can run on Linux. A lint minute moved from macOS
3-4 core to `ubuntu-slim` goes from $0.062 to $0.002.

### Check scheduled workflows

The shortest schedule is every 5 minutes
([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).
That's 288 runs a day, about 8,640 a month. Even at one rounded-up minute
each on Linux 2-core, that's $51.84 a month for one cron job (our
arithmetic). Ask whether hourly or nightly would do.

### Shorten artifact retention

GitHub keeps logs and artifacts for 90 days by default
([docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts)).
For build outputs only the next job needs, set `retention-days`, which takes 1
to 90 days
([upload-artifact](https://github.com/actions/upload-artifact)):

```yaml
- uses: actions/upload-artifact@v7
  with:
    name: dist
    path: dist/
    retention-days: 3
```

## Then pick cheaper runners

Once the waste is gone, the minutes that remain can cost less per minute.

### Right-size the runner

A larger runner costs more per minute and can cost less per job. The 4-core
Linux runner is $0.012, twice the 2-core's $0.006, so it's cheaper whenever it
finishes in under half the time. A 20-minute job on 2-core costs $0.12. If
4-core runs it in 9 minutes, it costs $0.108. The 8-core runner at $0.022
beats the 4-core when it brings the time below 55% (0.012 ÷ 0.022). This
works for CPU-bound jobs such as compiles and parallel tests. Jobs that wait
on the network or run one thread won't speed up, so time a few runs before
switching.

### Use arm64 and ubuntu-slim where they fit

Linux 2-core arm64 is $0.005, 17% under x64, if your toolchain and images
build for Arm. `ubuntu-slim` is 1 vCPU and 5 GB in a container, with a
15-minute job limit, meant for automation, linting and short jobs
([changelog](https://github.blog/changelog/2026-01-22-1-vcpu-linux-runner-now-generally-available-in-github-actions)).
At $0.002 it's a third of the 2-core price for labelers, formatters and API
calls.

### Managed third-party runners

These services run the machines and register them with GitHub as
self-hosted runners. You change `runs-on` and pay them per minute. Prices for
a base Linux x64 runner, from their pricing pages on 2026-11-18:

| Service                                                       | 2 vCPU $/min                   | 4 vCPU $/min                   | Free each month |
| ------------------------------------------------------------- | ------------------------------ | ------------------------------ | --------------- |
| GitHub-hosted                                                 | $0.006                         | $0.012                         | $12–$300        |
| [Blacksmith](https://www.blacksmith.sh/pricing)               | $0.004                         | not listed                     | 3,000 minutes   |
| [Depot](https://depot.dev/pricing)                            | $0.006                         | not listed                     | plans from $20  |
| [Namespace](https://namespace.so/pricing)                     | $0.002 prepaid, $0.003 overage | $0.004 prepaid, $0.006 overage | none listed     |
| [Ubicloud](https://www.ubicloud.com/use-cases/github-actions) | $0.0012                        | $0.0025                        | 1,250 minutes   |
| [WarpBuild](https://www.warpbuild.com/pricing) managed        | $0.004                         | $0.008                         | none listed     |

Namespace's 2-vCPU price is for 4 GB of memory and its 4-vCPU price for 8 GB.
Depot includes 2,000 minutes on its $20 plan and 20,000 on its $200 plan.
These services also sell faster caches and Docker builds. The trade-off is
that your code and secrets run on their machines.

### Self-hosted runners in your own cloud

GitHub charges nothing for self-hosted runners today; they're usage that
"remains free independently and does not reduce the included compute usage"
([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
GitHub announced a $0.002 per minute fee and postponed it, with no new date
(see [the self-hosted runner fee](/blog/github-self-hosted-runner-fee/)).

On your own cloud account, a spot VM is the cheapest compute. A 4-vCPU spot
VM cost $0.0318 to $0.1165 an hour on 2026-11-13 across AWS, GCP and Azure
in backmesh's catalog, or about $0.0005 to $0.0019 a minute, against $0.012
for GitHub's 4-core runner ([cost inputs](/cost/)). What you add is the work
and fixed cost of running the thing that starts the VMs:

| Option                                                                                           | Clouds          | Software cost              | What you run                                                                                                    |
| ------------------------------------------------------------------------------------------------ | --------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Actions Runner Controller](https://github.com/actions/actions-runner-controller)                | Any Kubernetes  | Free                       | A Kubernetes cluster                                                                                            |
| [terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner) | AWS             | Free                       | Terraform, Lambda, SQS, EC2                                                                                     |
| [RunsOn](https://runs-on.com/pricing/)                                                           | AWS             | €300–€3,600 a year license | A CloudFormation stack                                                                                          |
| [WarpBuild BYOC](https://www.warpbuild.com/pricing)                                              | AWS, GCP, Azure | $0.002 a minute            | Your cloud account; WarpBuild's control                                                                         |
| backmesh                                                                                         | AWS, GCP, Azure | Free, Apache-2.0           | A control plane VM and a listener VM per org (t3.large and t3.small on AWS), about $74–$111 a month for one org |

backmesh publishes this page. It starts one spot VM per job and deletes it
when the job ends. Its limits: Linux x86-64 and arm64, private repositories unless you
turn on [public repositories](/public-repos/), no macOS or Windows runners, and GPU runners on AWS and Azure only. A
spot reclaim can fail a job, which
backmesh reruns, and jobs that mustn't repeat should use an on-demand label.
Its image has fewer preinstalled tools than `ubuntu-latest`
([what differs](/from-ubuntu-latest/)), and cache traffic leaves your cloud as
egress unless you use [its cache](/cache/). For a side-by-side of the free
options, see
[ARC vs terraform-aws-github-runner vs backmesh](/blog/arc-vs-terraform-aws-github-runner-vs-backmesh/).

Self-hosting pays off with volume. Each 4-vCPU minute moved from GitHub's
$0.012 to spot saves about $0.010 to $0.0115, so backmesh's fixed $74–$111 a
month for one org pays for itself at roughly 7,000 to 9,800 such minutes a month, depending on
the cloud (our
arithmetic). At 2 vCPU, where GitHub charges $0.006, the saving per minute is
smaller. A team using a few thousand minutes is better off with the fixes
above and the included usage.

## A worked example

This is a hypothetical team on GitHub Team, with made-up but plausible
volumes. All figures are our arithmetic at the list prices above.

Its month before any change:

| Line                                   | Minutes | $/min  | Cost   |
| -------------------------------------- | ------- | ------ | ------ |
| Linux 2-core, CI on every push         | 120,000 | $0.006 | $720   |
| Linux 4-core, integration tests        | 40,000  | $0.012 | $480   |
| macOS 3-4 core, 1,000 iOS + 2,000 lint | 3,000   | $0.062 | $186   |
| Included usage on Team                 |         |        | −$18   |
| Total                                  |         |        | $1,368 |

Step 1 moves lint off macOS to `ubuntu-slim`. 2,000 minutes at $0.002 is $4,
and macOS drops to 1,000 minutes, $62. Saving: $120.

Step 2 adds concurrency, path filters, draft skipping and caching. Assume
these remove 30% of Linux minutes; measure your own. 2-core drops to 84,000
minutes ($504), and 4-core to 28,000 ($336). Saving: $360.

Step 3 moves the integration tests to 8-core. Assume they're CPU-bound and
finish in half the time: 14,000 minutes × $0.022 is $308. Saving: $28.

The bill is now $504 + $308 + $4 + $62 − $18 = $860, down $508 (37%) with no
new vendor.

Step 4 moves all Linux jobs to 4-vCPU spot VMs with backmesh and keeps macOS
on GitHub. The integration tests go back to 4 vCPU at 28,000 minutes, so the
total is 84,000 + 28,000 + 2,000 = 114,000 minutes. At the per-1,000-minute
spot prices on [the cost page](/cost/) plus one org's always-on VMs:

| Cloud | 114,000 spot minutes | Always-on VMs | Linux month |
| ----- | -------------------- | ------------- | ----------- |
| Azure | $60–$72              | $111          | $171–$183   |
| AWS   | $94–$133             | $86           | $180–$219   |
| GCP   | $171–$221            | $74           | $245–$295   |

Add macOS at $62 less the $18 included, $44, and the month is about $215–$339.
That leaves out VM boots and disks, so it's a floor. Against the starting
$1,368, that's 75% to 84% lower. Steps 1 to 3 do the first 37% on their own.

Ubicloud's managed runners would price the same Linux minutes at $0.0012 for
2 vCPU and $0.0025 for 4 vCPU: 86,000 × $0.0012 + 28,000 × $0.0025 = $173.20,
before its free minutes. A managed service at that price and no fixed cost
can beat self-hosting at this volume. Self-hosting gains as minutes grow or
when the build has to stay in your account. Try your own figures in
[the calculator](/calculator/).

## Checklist

Ordered from least effort to most.

| Step                                      | Effort         | What it removes                                 |
| ----------------------------------------- | -------------- | ----------------------------------------------- |
| Read the usage report by workflow and SKU | 30 minutes     | Guessing                                        |
| `concurrency` with `cancel-in-progress`   | One line       | Superseded runs                                 |
| `timeout-minutes` on every job            | One line a job | Hung jobs billing up to 360 minutes             |
| Move lint and checks off macOS            | Small          | Minutes at $0.062                               |
| Skip drafts, add path filters             | Small          | Runs that can't change the result               |
| Shorter cron, shorter `retention-days`    | Small          | Idle scheduled runs, storage                    |
| Cache dependencies                        | Small          | Install time in every job                       |
| Trim matrices, merge tiny jobs            | Medium         | Rounding to whole minutes, repeated setup       |
| `ubuntu-slim` and arm64 where they fit    | Medium         | 17% to 67% of the Linux 2-core price            |
| Right-size CPU-bound jobs                 | Medium         | Minutes on runners too small for the job        |
| Managed third-party runners               | Medium         | Up to 80% of the per-minute price, by vendor    |
| Self-hosted runners on spot VMs           | Larger         | Most of the per-minute price; adds a fixed cost |

To start with the last row, see [install](/install/).

## Questions

**How much does GitHub Actions cost in 2026?** In private repositories,
per minute: $0.002 for `ubuntu-slim`, $0.006 for Linux 2-core x64, $0.005 for
Linux 2-core arm64, $0.012 for Linux 4-core, $0.010 for Windows 2-core and
$0.062 for macOS 3-4 core
([runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)).
Each month includes $12 on Free, $18 on Pro and Team and $300 on Enterprise
Cloud. Standard runners in public repositories are free.

**Why does our GitHub Actions bill keep going up?** Usually more runs: more
pull requests and pushes, including from coding agents, superseded runs that
keep going, workflows that run on every change, and growing matrices. Copilot
code review has also consumed Actions minutes on private repositories since
2026-06-01, and cloud sandboxes share the included pool since 2026-10-28.

**Does GitHub round job time up?** Yes. Each job is rounded up to the nearest
whole minute, so a 10-second job bills one minute.

**What is the default job timeout in GitHub Actions?** 360 minutes. Set `timeout-minutes`
lower so a hung job doesn't run six hours.

**Does Copilot code review use GitHub Actions minutes?** Yes, on private
repositories since 2026-06-01. Reviews draw from included usage, and beyond it
they bill at standard Actions rates
([changelog](https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/)).

**Can a bigger runner be cheaper?** Yes, for CPU-bound jobs. The 4-core Linux
runner costs twice the 2-core price, so it's cheaper whenever it takes less
than half the time. The 8-core at $0.022 beats the 4-core at $0.012 below
about 55% of the time.

**Are self-hosted runners free?** GitHub charges nothing for them as of
2026-11-18, and they don't reduce included usage. You pay for the machines.
A $0.002 per minute fee was announced in December 2025 and postponed the next
day, with no new date.

**How much cheaper are third-party runners?** For 2 vCPU on 2026-11-18:
Blacksmith and WarpBuild $0.004, Namespace $0.002 prepaid or $0.003 overage,
Ubicloud $0.0012, against GitHub's $0.006. Depot is $0.006. Spot VMs in your
own cloud cost less per minute but add a fixed cost.

**What does backmesh cost and what are its limits?** The software is free and
open source. Your cloud bills you for spot VMs and a control plane VM and a
listener VM per org (t3.large and t3.small on AWS),
about $74–$111 a month for one org. It runs Linux x86-64 and arm64 jobs, in private
repositories unless you turn on [public repositories](/public-repos/), with no macOS or Windows runners and GPU runners on AWS and Azure
only, and a spot reclaim can fail a job, which backmesh reruns.
