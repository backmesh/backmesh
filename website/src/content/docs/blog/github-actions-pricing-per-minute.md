---
title: 'GitHub Actions pricing in 2026, per minute'
description: Every GitHub-hosted runner price per minute in 2026, from the 1-core Linux runner at $0.002 to the 96-core Windows runner at $0.552, with included usage per plan, storage and cache prices, how minutes are rounded, the January 2026 price cut and worked monthly bills.
date: 2026-11-26
lastUpdated: 2026-11-26
authors: backmesh
tags:
  - GitHub pricing
excerpt: GitHub Actions costs $0.006 a minute on the standard 2-core Linux runner in private repositories, $0.010 on Windows and $0.062 on macOS. Standard runners are free in public repositories. Every runner SKU, what each plan includes, storage and cache prices, and monthly bills at 20,000, 150,000 and 1,000,000 minutes.
head:
  - tag: title
    content: 'GitHub Actions pricing 2026: cost per minute for every runner | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"GitHub Actions pricing in 2026, per minute","datePublished":"2026-11-26","dateModified":"2026-11-26","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/github-actions-pricing-per-minute/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"How much does GitHub Actions cost per minute in 2026?","acceptedAnswer":{"@type":"Answer","text":"In private repositories, the standard 2-core Linux runner costs $0.006 a minute, the 2-core Windows runner $0.010 and the 3-core or 4-core macOS runner $0.062. Larger Linux x64 runners run from $0.012 a minute at 4 cores to $0.252 at 96 cores. Prices read on docs.github.com on 2026-11-26."}},{"@type":"Question","name":"How many free GitHub Actions minutes do I get?","acceptedAnswer":{"@type":"Answer","text":"Plans now include a dollar amount of compute each month: $12 on GitHub Free, $18 on Pro and Team, and $300 on Enterprise Cloud. At $0.006 a minute that is 2,000, 3,000 and 50,000 minutes of the standard 2-core Linux runner."}},{"@type":"Question","name":"Is GitHub Actions free for public repositories?","acceptedAnswer":{"@type":"Answer","text":"Yes for standard GitHub-hosted runners, which are free and unlimited in public repositories, and for self-hosted runners. Larger runners are billed in public repositories at the same per-minute rates as in private ones."}},{"@type":"Question","name":"Does GitHub round Actions minutes up?","acceptedAnswer":{"@type":"Answer","text":"Yes. GitHub rounds the minutes and partial minutes each job uses up to the nearest whole minute. A 10-second job bills one minute and a 61-second job bills two."}},{"@type":"Question","name":"Did GitHub Actions get cheaper in 2026?","acceptedAnswer":{"@type":"Answer","text":"Yes. On 2026-01-01 GitHub cut GitHub-hosted runner prices by up to 39%. The 2-core Linux runner went from $0.008 to $0.006 a minute, the 4-core Linux runner from $0.016 to $0.012, and the 2-core Windows runner from $0.016 to $0.010."}},{"@type":"Question","name":"Does GitHub charge for self-hosted runners?","acceptedAnswer":{"@type":"Answer","text":"No, as of 2026-11-26. GitHub announced a $0.002 per minute charge for self-hosted runners in private repositories from 2026-03-01 and postponed it on 2025-12-17. The billing docs list self-hosted runners as free."}},{"@type":"Question","name":"How much does GitHub Actions storage and cache cost?","acceptedAnswer":{"@type":"Answer","text":"Above the included amount, artifact and GitHub Packages storage costs $0.25 a GB-month and Actions cache costs $0.07 a GB-month. Each repository gets 10 GB of cache, and cache above that is billed only if the repository cache limit was raised above 10 GB."}},{"@type":"Question","name":"How much do 150,000 GitHub Actions minutes cost?","acceptedAnswer":{"@type":"Answer","text":"At list price, $900 on the standard 2-core Linux runner and $1,800 on the 4-core Linux runner, before included usage. On GitHub Team the $18 of included compute brings the 4-core bill to $1,782."}},{"@type":"Question","name":"Can included minutes be used on larger runners?","acceptedAnswer":{"@type":"Answer","text":"On GitHub Team and Enterprise Cloud, yes: larger runner usage draws from the same included compute as standard runners. Larger runners need a valid payment method and are only available on those two plans."}},{"@type":"Question","name":"What happens when I run out of included minutes?","acceptedAnswer":{"@type":"Answer","text":"Without a payment method on file, GitHub blocks further usage until the next billing cycle. With one, usage is billed at the per-minute rates, up to any budgets you set. GitHub can email you at 90% and 100% of included usage."}}]}]}'
---

GitHub Actions costs $0.006 a minute on the standard 2-core Linux runner in a
private repository, $0.010 on the 2-core Windows runner and $0.062 on the
3-core or 4-core macOS runner. Larger Linux x64 runners cost $0.012 a minute
at 4 cores and $0.252 at 96 cores. Standard runners are free in public
repositories, self-hosted runners are free everywhere, and each plan includes
$12 to $300 of compute a month. GitHub rounds every job up to a whole minute.
All prices below are from
[GitHub's runner pricing reference](https://docs.github.com/en/billing/reference/actions-runner-pricing)
and [Actions billing docs](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
read 2026-11-26.

## Prices at a glance

| Question                                   | Answer, read 2026-11-26                                    |
| ------------------------------------------ | ---------------------------------------------------------- |
| Standard Linux runner (`ubuntu-latest`)    | $0.006 a minute, 2 vCPU, 8 GB in private repositories      |
| Cheapest runner                            | $0.002 a minute, `ubuntu-slim` (1 vCPU, 5 GB)              |
| Most expensive runner                      | $0.552 a minute, Windows 96-core                           |
| Included compute per month                 | $12 Free, $18 Pro and Team, $300 Enterprise Cloud          |
| Public repositories                        | Standard runners free and unlimited; larger runners billed |
| Self-hosted runners                        | Free; the announced $0.002 fee is postponed                |
| Rounding                                   | Each job rounds up to the next whole minute                |
| Artifact storage above the included amount | $0.25 a GB-month                                           |
| Cache above 10 GB per repository           | $0.07 a GB-month                                           |
| Last price change                          | 2026-01-01, up to 39% lower                                |

## Standard runners

These are the runners behind `ubuntu-latest`, `windows-latest` and
`macos-latest`. In private repositories they draw from your plan's included
compute, then bill per minute. Specs are from
[GitHub's hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

| Runner                          | Label                            | vCPU, RAM                | Billing SKU           | Per minute |
| ------------------------------- | -------------------------------- | ------------------------ | --------------------- | ---------- |
| Linux 1-core x64                | `ubuntu-slim`                    | 1, 5 GB                  | `actions_linux_slim`  | $0.002     |
| Linux 2-core x64                | `ubuntu-latest`, `ubuntu-24.04`  | 2, 8 GB                  | `actions_linux`       | $0.006     |
| Linux 2-core arm64              | `ubuntu-24.04-arm`               | 2, 8 GB                  | `actions_linux_arm`   | $0.005     |
| Windows 2-core x64              | `windows-latest`, `windows-2025` | 2, 8 GB                  | `actions_windows`     | $0.010     |
| Windows 2-core arm64            | `windows-11-arm`                 | 2, 8 GB                  | `actions_windows_arm` | $0.010     |
| macOS 3-core M1 or 4-core Intel | `macos-latest`, `macos-15-intel` | 3 (M1), 7 GB or 4, 14 GB | `actions_macos`       | $0.062     |

In public repositories the same labels get bigger machines for free: the Linux,
Windows and Intel macOS runners have 4 vCPUs and 16 GB (14 GB on macOS Intel).
`ubuntu-slim` runs in a container on a shared VM, has a 15-minute job timeout
and can't run Docker-in-Docker. GitHub describes it as a runner for automation,
issue operations and short jobs, and says it doesn't suit typical CI/CD builds.

## Larger runners

Larger runners are only available on GitHub Team and GitHub Enterprise Cloud,
need a payment method on file, and are billed in public repositories too. They
bill only while a job runs on them, so creating one costs nothing.

### x64

| Runner                | Billing SKU             | Per minute | Per vCPU-minute |
| --------------------- | ----------------------- | ---------- | --------------- |
| Linux Advanced 2-core | `linux_2_core_advanced` | $0.006     | $0.0030         |
| Linux 4-core          | `linux_4_core`          | $0.012     | $0.0030         |
| Linux 8-core          | `linux_8_core`          | $0.022     | $0.00275        |
| Linux 16-core         | `linux_16_core`         | $0.042     | $0.00263        |
| Linux 32-core         | `linux_32_core`         | $0.082     | $0.00256        |
| Linux 64-core         | `linux_64_core`         | $0.162     | $0.00253        |
| Linux 96-core         | `linux_96_core`         | $0.252     | $0.00263        |
| Windows 4-core        | `windows_4_core`        | $0.022     | $0.0055         |
| Windows 8-core        | `windows_8_core`        | $0.042     | $0.00525        |
| Windows 16-core       | `windows_16_core`       | $0.082     | $0.00513        |
| Windows 32-core       | `windows_32_core`       | $0.162     | $0.00506        |
| Windows 64-core       | `windows_64_core`       | $0.322     | $0.00503        |
| Windows 96-core       | `windows_96_core`       | $0.552     | $0.00575        |
| macOS 12-core         | `macos_l`               | $0.077     | $0.0064         |

The per-vCPU column is our arithmetic (price ÷ cores). Linux x64 costs close
to $0.003 per vCPU-minute at every size, so a job that runs twice as fast on
twice the cores costs about the same. Windows costs about twice Linux per
vCPU.

### arm64

| Runner                | Billing SKU           | Per minute |
| --------------------- | --------------------- | ---------- |
| Linux 2-core          | `linux_2_core_arm`    | $0.005     |
| Linux 4-core          | `linux_4_core_arm`    | $0.008     |
| Linux 8-core          | `linux_8_core_arm`    | $0.014     |
| Linux 16-core         | `linux_16_core_arm`   | $0.026     |
| Linux 32-core         | `linux_32_core_arm`   | $0.050     |
| Linux 64-core         | `linux_64_core_arm`   | $0.098     |
| Windows 2-core        | `windows_2_core_arm`  | $0.008     |
| Windows 4-core        | `windows_4_core_arm`  | $0.014     |
| Windows 8-core        | `windows_8_core_arm`  | $0.026     |
| Windows 16-core       | `windows_16_core_arm` | $0.050     |
| Windows 32-core       | `windows_32_core_arm` | $0.098     |
| Windows 64-core       | `windows_64_core_arm` | $0.194     |
| macOS 5-core (M2 Pro) | `macos_xl`            | $0.102     |

Linux arm64 costs a third to 40% less than x64 at the same core count: $0.008
against $0.012 at 4 cores, $0.098 against $0.162 at 64. Moving a job to arm64
needs its build and dependencies to run on arm64.

### GPU

| Runner                 | Billing SKU          | Per minute |
| ---------------------- | -------------------- | ---------- |
| Linux 4-core, one T4   | `linux_4_core_gpu`   | $0.052     |
| Windows 4-core, one T4 | `windows_4_core_gpu` | $0.102     |

GPU runners are larger runners, so they need Team or Enterprise Cloud. Monthly
GPU bills and the self-hosted alternatives are in
[GitHub Actions GPU pricing](/blog/github-actions-gpu-pricing/).

## The January 2026 price cut

GitHub announced on
[2025-12-16](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/)
that GitHub-hosted runners would cost up to 39% less, and the cut
[took effect on 2026-01-01](https://github.blog/changelog/2026-01-01-reduced-pricing-for-github-hosted-runners-usage/).
GitHub said the new rates already include a $0.002 per minute "Actions cloud
platform charge". The earlier prices below are from the
[docs page as of 2025-10-30](https://github.com/github/docs/blob/3d77b7e3ca336aa39ca90ab5e4a03434f17fe661/content/billing/reference/actions-runner-pricing.md),
in GitHub's public docs repository.

| Runner             | Per minute, 2025 | Per minute, 2026 | Change |
| ------------------ | ---------------- | ---------------- | ------ |
| Linux 1-core       | $0.002           | $0.002           | 0%     |
| Linux 2-core x64   | $0.008           | $0.006           | -25%   |
| Linux 2-core arm64 | $0.005           | $0.005           | 0%     |
| Windows 2-core     | $0.016           | $0.010           | -38%   |
| macOS 3 or 4-core  | $0.080           | $0.062           | -23%   |
| Linux 4-core x64   | $0.016           | $0.012           | -25%   |
| Linux 16-core x64  | $0.064           | $0.042           | -34%   |
| Linux 64-core x64  | $0.256           | $0.162           | -37%   |
| Linux 96-core x64  | $0.384           | $0.252           | -34%   |
| Linux 4-core arm64 | $0.010           | $0.008           | -20%   |
| Windows 4-core     | $0.032           | $0.022           | -31%   |
| Windows 64-core    | $0.512           | $0.322           | -37%   |
| macOS 12-core      | $0.120           | $0.077           | -36%   |
| Linux GPU          | $0.070           | $0.052           | -26%   |
| Windows GPU        | $0.140           | $0.102           | -27%   |

The announcement said the free minute quotas would stay the same. GitHub now
states them in dollars, and its docs give $300 as 50,000 minutes of the
standard Linux runner.

## What each plan includes

| Plan                          | Included compute a month | Artifact storage | Cache per repository | Custom image storage |
| ----------------------------- | ------------------------ | ---------------- | -------------------- | -------------------- |
| GitHub Free                   | $12                      | 500 MB           | 10 GB                | n/a                  |
| GitHub Pro                    | $18                      | 1 GB             | 10 GB                | n/a                  |
| GitHub Free for organizations | $12                      | 500 MB           | 10 GB                | n/a                  |
| GitHub Team                   | $18                      | 2 GB             | 10 GB                | 75 GB                |
| GitHub Enterprise Cloud       | $300                     | 50 GB            | 10 GB                | 150 GB               |

Included compute is a dollar amount, so the minutes it buys depend on the
runner. Our arithmetic, at the rates above:

| Included compute | Linux 2-core ($0.006) | Linux 4-core ($0.012) | Windows 2-core ($0.010) | macOS 3-core ($0.062) |
| ---------------- | --------------------- | --------------------- | ----------------------- | --------------------- |
| $12              | 2,000 min             | 1,000 min             | 1,200 min               | 193 min               |
| $18              | 3,000 min             | 1,500 min             | 1,800 min               | 290 min               |
| $300             | 50,000 min            | 25,000 min            | 30,000 min              | 4,838 min             |

Several products share that pool. Standard runners and cloud sandbox compute
draw from it on every plan. Larger runners draw from it on Team and Enterprise
Cloud. Copilot code review in private repositories uses Actions compute on top
of its AI credits and draws from it too. GitHub's docs say no usage type has
priority, so a team that turns on Copilot code review uses up its included
minutes sooner. The pool resets at the start of each billing cycle.

## How GitHub counts minutes

- Each job's time rounds up to the next whole minute. A 10-second job bills one
  minute and a 61-second job bills two. A matrix of 30 jobs that each take 20
  seconds bills 30 minutes, though it used 10 minutes of compute.
- Failed runs bill for the time they ran. GitHub's example: a 10-minute
  workflow that fails at minute 5 and then passes on a rerun bills 15 minutes.
- The repository owner pays, whoever triggered the run. Anyone with write
  access can start runs that the owner pays for.
- Standard runners are free in public repositories, for GitHub Pages and for
  Dependabot.
- Self-hosted runners don't bill and don't draw from included compute.
- Without a payment method on file, usage stops when included compute runs
  out. With one, usage bills at the per-minute rates up to any
  [budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets) you set.
  GitHub can email you at 90% and 100% of included usage.

The rounding matters most for teams with many short jobs. Splitting lint, type
checks and unit tests into a dozen parallel jobs of 15 seconds each bills 12
minutes per push. Running them as steps of one job bills one or two.

## Storage and cache prices

| Storage                                     | Included                            | Price above included |
| ------------------------------------------- | ----------------------------------- | -------------------- |
| Artifacts and GitHub Packages (shared pool) | 500 MB to 50 GB by plan             | $0.25 a GB-month     |
| Actions cache                               | 10 GB per repository                | $0.07 a GB-month     |
| Custom images for larger runners            | 75 GB Team, 150 GB Enterprise Cloud | $0.07 a GB-month     |

Storage accrues by the hour in GB-hours, and the monthly bill divides by the
hours in the month. Deleting an artifact stops future charges but leaves the
hours already accrued on the bill: 10 GB kept for 10 days of a 30-day month is
2,400 GB-hours, or 3.33 GB-months, about $0.83 at $0.25 before the included
allowance. GitHub uses binary
gigabytes (1 GB = 2^30 bytes). Logs and job summaries don't count against
artifact storage.

Cache is billed on each hour's peak use above 10 GB per repository, and only
if someone raised the repository's cache limit above 10 GB. At the default
limit there's no cache charge. A repository that keeps 15
GB of cache all month after raising the limit pays for 5 GB, $0.35 a month.

## Monthly bills, worked through

Our arithmetic at list prices read 2026-11-26, before any budgets or taxes. The
included compute is taken off as if Actions were the only thing using it.

### Linux 4-core (`linux_4_core`, $0.012 a minute)

| Minutes a month | List price | GitHub Team ($18 off) | Enterprise Cloud ($300 off) | Same minutes in 2025 ($0.016) |
| --------------- | ---------- | --------------------- | --------------------------- | ----------------------------- |
| 20,000          | $240       | $222                  | $0                          | $320                          |
| 150,000         | $1,800     | $1,782                | $1,500                      | $2,400                        |
| 1,000,000       | $12,000    | $11,982               | $11,700                     | $16,000                       |

On Enterprise Cloud, $300 covers the first 25,000 minutes of 4-core Linux, so
the 20,000-minute month costs nothing if no other product draws from the pool.

### Linux 2-core (`ubuntu-latest`, $0.006 a minute)

| Minutes a month | List price | GitHub Team ($18 off) | Enterprise Cloud ($300 off) |
| --------------- | ---------- | --------------------- | --------------------------- |
| 20,000          | $120       | $102                  | $0                          |
| 150,000         | $900       | $882                  | $600                        |
| 1,000,000       | $6,000     | $5,982                | $5,700                      |

### A mixed month on GitHub Team

A team runs 100,000 minutes of `ubuntu-latest`, 10,000 minutes of
`macos-latest` for an iOS build and 5,000 minutes of `windows-latest`:

| Runner         | Minutes | Rate   | Cost   |
| -------------- | ------- | ------ | ------ |
| Linux 2-core   | 100,000 | $0.006 | $600   |
| macOS 3-core   | 10,000  | $0.062 | $620   |
| Windows 2-core | 5,000   | $0.010 | $50    |
| Included       |         |        | -$18   |
| Total          | 115,000 |        | $1,252 |

macOS is 9% of the minutes and about half the bill. For most teams with an iOS
or macOS app, the macOS jobs are the first place to look.

To try other mixes, GitHub has a
[pricing calculator](https://github.com/pricing/calculator?feature=actions),
and the backmesh [calculator](/calculator/) compares GitHub-hosted prices with
spot VMs in AWS, GCP and Azure.

## The self-hosted runner fee

GitHub's 2025-12-16 announcement also set a $0.002 per minute charge on
self-hosted runners in private repositories from 2026-03-01. GitHub
[postponed it on 2025-12-17](https://github.com/orgs/community/discussions/182186)
"to take time to re-evaluate our approach", and as of 2026-11-26 the billing
docs list self-hosted runners as free. If it returns as announced, it would add
$40 a month at 20,000 minutes, $300 at 150,000 and $2,000 at 1,000,000, at any
runner size. The history, who it would reach and how to plan for it are in
[GitHub's self-hosted runner fee: where it stands](/blog/github-self-hosted-runner-fee/).

## Ways to pay less

There are two passes, covered in detail in
[How to cut your GitHub Actions bill](/blog/how-to-reduce-github-actions-costs/):

1. Stop paying for minutes you don't need: cancel superseded runs with
   `concurrency`, skip unaffected workflows with `paths` filters, set
   `timeout-minutes`, cache dependencies, and merge tiny jobs to cut rounding.
2. Move the remaining minutes to cheaper runners: arm64 where your stack
   supports it, right-sized larger runners, or self-hosted runners on your own
   cloud account, where cloud credits also apply.

Self-hosting moves the per-minute price to your cloud bill and adds a fixed
cost. Every self-hosted setup has one: a Kubernetes cluster for Actions Runner
Controller, Lambda functions and queues for the Terraform module, or a control
plane VM for a runner manager.

backmesh is one such runner manager. It's free and open source and runs each
job on its own spot VM in your AWS, GCP or Azure account. On its
[cost page](/cost/), 150,000 minutes a month of 4-vCPU jobs come to about
$191 to $365 at spot prices on 2026-11-13, against $1,800 on GitHub's 4-core
runner, with the always-on VMs (about $74 to $111 a month for one org)
included. It runs Linux x86-64 and arm64 jobs (arm64 on AWS and GCP), with no macOS or
Windows runners. Each job waits about 40 s for its VM to boot, about 10 s when cued, a spot reclaim fails the job
(backmesh reruns such jobs, preferring on demand), and each job starts with an
empty Docker layer cache. For GPU jobs on AWS and Azure, see
[GPU pricing](/blog/github-actions-gpu-pricing/).

## Questions

### How much does GitHub Actions cost per minute in 2026?

In private repositories, the standard 2-core Linux runner costs $0.006 a
minute, the 2-core Windows runner $0.010 and the 3-core or 4-core macOS runner
$0.062. Larger Linux x64 runners run from $0.012 a minute at 4 cores to $0.252
at 96 cores
([runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing),
read 2026-11-26).

### How many free GitHub Actions minutes do I get?

Plans now include a dollar amount of compute each month: $12 on GitHub Free,
$18 on Pro and Team, and $300 on Enterprise Cloud. At $0.006 a minute that's
2,000, 3,000 and 50,000 minutes of the standard 2-core Linux runner.

### Is GitHub Actions free for public repositories?

Yes for standard GitHub-hosted runners, which are free and unlimited in public
repositories, and for self-hosted runners. Larger runners are billed in public
repositories at the same per-minute rates as in private ones.

### Does GitHub round Actions minutes up?

Yes. GitHub rounds the minutes and partial minutes each job uses up to the
nearest whole minute. A 10-second job bills one minute and a 61-second job
bills two.

### Did GitHub Actions get cheaper in 2026?

Yes. On 2026-01-01 GitHub cut GitHub-hosted runner prices by up to 39%. The
2-core Linux runner went from $0.008 to $0.006 a minute, the 4-core Linux
runner from $0.016 to $0.012, and the 2-core Windows runner from $0.016 to
$0.010.

### Does GitHub charge for self-hosted runners?

No, as of 2026-11-26. GitHub announced a $0.002 per minute charge for
self-hosted runners in private repositories from 2026-03-01 and postponed it on
2025-12-17. The
[billing docs](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
list self-hosted runners as free.

### How much does GitHub Actions storage and cache cost?

Above the included amount, artifact and GitHub Packages storage costs $0.25 a
GB-month and Actions cache costs $0.07 a GB-month. Each repository gets 10 GB
of cache, and cache above that is billed only if the repository cache limit
was raised above 10 GB.

### How much do 150,000 GitHub Actions minutes cost?

At list price, $900 on the standard 2-core Linux runner and $1,800 on the
4-core Linux runner, before included usage. On GitHub Team the $18 of included
compute brings the 4-core bill to $1,782.

### Can included minutes be used on larger runners?

On GitHub Team and Enterprise Cloud, yes: larger runner usage draws from the
same included compute as standard runners. Larger runners need a valid payment
method and are only available on those two plans.

### What happens when I run out of included minutes?

Without a payment method on file, GitHub blocks further usage until the next
billing cycle. With one, usage is billed at the per-minute rates, up to any
budgets you set. GitHub can email you at 90% and 100% of included usage.
