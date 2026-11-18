---
title: 'backmesh vs RunsOn: self-hosted GitHub Actions runners in your own cloud compared'
description: backmesh and RunsOn both run each GitHub Actions job on a fresh spot VM in your own cloud account. A side-by-side on license, clouds, setup, isolation, spot, caching, start times, upkeep and a worked monthly bill on AWS.
date: 2026-11-18
lastUpdated: 2026-11-18
authors: backmesh
tags:
  - Comparisons
excerpt: RunsOn runs GitHub Actions jobs on EC2 in your AWS account under a yearly license. backmesh runs them on spot VMs in AWS, GCP or Azure under Apache-2.0. A side-by-side on license, clouds, operating systems, setup, isolation, spot, caching, start times and a worked monthly bill.
head:
  - tag: title
    content: 'backmesh vs RunsOn (2026): a RunsOn alternative for AWS, GCP and Azure | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is the difference between backmesh and RunsOn?","acceptedAnswer":{"@type":"Answer","text":"Both run each GitHub Actions job on a fresh spot VM in your own cloud account. RunsOn is AWS only, supports Linux x64 and arm64, Windows and GPU, and charges a yearly license for commercial use. backmesh runs on AWS, GCP and Azure, supports Linux x86-64 only in private repositories, and is free under Apache-2.0."}},{"@type":"Question","name":"Is there a RunsOn alternative for GCP or Azure?","acceptedAnswer":{"@type":"Answer","text":"Yes. RunsOn runs on AWS only. backmesh runs each job on its own spot VM in a GCP project or an Azure subscription as well as an AWS account, and one install can use several clouds."}},{"@type":"Question","name":"Is RunsOn open source?","acceptedAnswer":{"@type":"Answer","text":"Partly. Its public repository holds MIT-licensed CloudFormation assets and supporting files, and the RunsOn server and agent are commercially licensed. It is free for non-profit, open-source and personal non-commercial projects. The Sponsorship plan includes the full server and agent source."}},{"@type":"Question","name":"How much does a RunsOn license cost?","acceptedAnswer":{"@type":"Answer","text":"Per its pricing page on 2026-11-18, per legal entity per year: Starter €300 under 50,000 jobs a month, Growth €900 under 200,000, Scale €1,800 under 500,000, and Sponsorship €3,600 with no job limit. In US dollars that is $350, $1,050, $2,100 and $4,200. AWS bills the instances separately."}},{"@type":"Question","name":"Which is cheaper for 150,000 minutes of 4-vCPU jobs on AWS?","acceptedAnswer":{"@type":"Answer","text":"They come out close. From each side''s published prices, RunsOn is about $231 a month with a Starter license and its control plane, and backmesh about $235 to $286 with disks and its control plane. GitHub-hosted 4-core runners cost $1,800 for the same minutes."}},{"@type":"Question","name":"Does RunsOn support Windows, arm64 and GPU runners?","acceptedAnswer":{"@type":"Answer","text":"Yes. RunsOn runs Linux x64 and arm64, Windows Server 2022 and 2025, and NVIDIA and AMD GPU instances. Neither RunsOn nor backmesh runs macOS. backmesh runs Linux x86-64 only."}},{"@type":"Question","name":"Which starts jobs faster?","acceptedAnswer":{"@type":"Answer","text":"RunsOn publishes a median wait of 15 to 21 seconds from queued to running on AWS, and under 6 seconds with hot warm pools. A backmesh VM boots in about 30 seconds on AWS and 60 to 70 seconds on GCP and Azure, and backmesh starts runners ahead of predicted jobs and of pushes its coding agent cue."}},{"@type":"Question","name":"Can I run RunsOn and backmesh side by side?","acceptedAnswer":{"@type":"Answer","text":"Yes. Both pick up jobs by their runs-on label, so each job goes to the one its label names, and workflows can move one at a time."}}]}'
---

backmesh and RunsOn both run each GitHub Actions job on a fresh spot VM in
your own cloud account, and your cloud bills you for the compute. RunsOn is
AWS only, runs Linux, Windows, arm64 and GPU jobs, and charges a yearly
license for commercial use, from €300. backmesh runs on AWS, GCP and Azure,
runs only Linux x86-64 jobs in private repositories, and is free under
Apache-2.0 for any use. On AWS, the monthly bills come out close.

All RunsOn figures below come from [runs-on.com](https://runs-on.com/) and
[github.com/runs-on/runs-on](https://github.com/runs-on/runs-on), read on
2026-11-18. Claims about customers and benchmarks are RunsOn's own, and are
labelled that way. backmesh publishes this page, so it names backmesh's limits
next to each strength.

## At a glance

|                     | [RunsOn](https://runs-on.com/)                                        | [backmesh](https://github.com/backmesh/backmesh)                                   |
| ------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| License             | Server and agent commercial; repo's CloudFormation assets MIT         | Apache-2.0; the cache action MIT                                                   |
| Price               | Free for non-commercial use; €300 to €3,600 a year for commercial use | Free for all use                                                                   |
| Latest release      | v3.6.2, 2026-11-13                                                    | v0.4.1, 2026-11-18                                                                 |
| Public repo since   | 2023-12-09, 1,421 GitHub stars                                        | 2026-11-16                                                                         |
| Clouds              | AWS                                                                   | AWS, GCP, Azure                                                                    |
| Install             | One CloudFormation stack, or a Terraform / OpenTofu module            | `backmesh install --org <org>` through your `aws`, `gcloud` or `az` CLI            |
| Control plane       | A Fargate service in your account, "from about $7 a month"            | Two small VMs in your account, about $86 a month on AWS, $74 on GCP, $111 on Azure |
| A fresh VM per job  | Yes                                                                   | Yes                                                                                |
| Spot                | Default, with on-demand fallback                                      | Default; `backmesh-od-*` labels run on demand                                      |
| Operating systems   | Linux x64 and arm64, Windows, GPU; no macOS                           | Linux x86-64 only                                                                  |
| Public repositories | Supported, in a separate environment per RunsOn's security docs       | Not yet: private repositories only                                                 |
| Runner image        | AMIs built from GitHub's full runner images, refreshed every 15 days  | Ubuntu 24.04 with GitHub's apt packages; toolchains from setup actions             |

## How each one works

### RunsOn

RunsOn's CloudFormation stack creates a VPC, a cache bucket, IAM roles and a
control plane on ECS Fargate. You then install a private GitHub App from the
stack's outputs.

It has two modes under one license. In Flex, GitHub posts each queued job's
webhook to an API Gateway endpoint in your account, and the job's label
describes the machine:

```yaml
runs-on: runs-on=${{ github.run_id }}/family=m8+r8/cpu=4
```

Labels can also pick RAM, an image, a disk size, `extras=s3-cache` and more.
In Fleet, a platform team defines named runner shapes in Terraform, and a
`fleetd` process pulls jobs from GitHub's runner scale sets, so nothing listens
for inbound traffic. In both, an EC2 instance boots for the job, runs it and is
terminated.

### backmesh

backmesh is a CLI. `backmesh install --org <org>` uses your signed-in `aws`,
`gcloud` or `az` CLI to create a control plane of two small always-on VMs in
your account, and connects each cloud with a keyless role, so no cloud keys
are stored. A listener on the control plane long-polls GitHub for queued
jobs, so nothing needs an inbound port or a webhook.

For each job, backmesh starts a VM in the cheapest region with capacity and
deletes it when the job ends. Labels pick a fixed size and a cloud:

```yaml
runs-on: backmesh-4 # 4 vCPU, 16 GiB, spot, the control plane's cloud
runs-on: backmesh-gcp-4 # the same on GCP
```

There are four [sizes](/labels/), 2 to 16 vCPUs at 4 GiB per vCPU, each with
on-demand and KVM variants. Sizes and instance types aren't configurable.
Runners can be in other clouds than the control plane, so one install can
serve AWS, [GCP](/gcp/) and [Azure](/azure/).

## Setup

| Step                | RunsOn                                                                                  | backmesh                                                                                |
| ------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Prerequisites       | An AWS account with admin rights, a GitHub org owner                                    | An AWS, GCP or Azure account with its CLI signed in, a GitHub org owner                 |
| Install             | Deploy the CloudFormation stack, about 10 minutes per RunsOn                            | `curl -fsSL https://backmesh.com/install.sh \| sh`, then `backmesh install --org <org>` |
| GitHub side         | Install the private GitHub App from the stack's outputs                                 | Install backmesh's public GitHub App during install                                     |
| Change in workflows | `runs-on: runs-on=${{ github.run_id }}/family=m8+r8/cpu=4`                              | `runs-on: backmesh-4`                                                                   |
| Other targets       | Terraform module for an existing VPC, IAM boundaries, GitHub Enterprise Server or Fleet | `--runners gcp`, `--runners azure` to add clouds                                        |

RunsOn's labels give a workflow author control over the instance family, RAM,
disk and image. backmesh's labels are shorter and fixed. A coding agent can
also set backmesh up: paste `set up https://backmesh.com/SKILL.md` into Claude
Code, Codex or another agent. See [Install](/install/) for every option.

## Isolation and security

Both give each job its own VM, deleted after the job. The differences are in
what sits around it:

- RunsOn's stack creates its own VPC, and runner security groups have no
  inbound rule.
  Repositories on one stack share the cache bucket and the runners' IAM role.
  Cache isolation, which scopes cache credentials to a repository and branch,
  is off by default and RunsOn recommends turning it on for every stack.
- backmesh runners have no cloud identity. Each job gets a 15-minute cache
  token for its own repository and region only. Runners use the account's
  default VPC or network, so a job can reach other instances there whose
  firewall rules allow it. backmesh's advice is a cloud account or project
  with nothing else in its default network.
- RunsOn's GitHub App is private to your install, with its key in your
  account. backmesh uses one public GitHub App whose private key backmesh
  holds; the [security model](/security/) lists what that key can do.
- RunsOn sends a license check and one telemetry event per launch to
  runs-on.com, and says its CI path doesn't depend on that. backmesh sends
  one event per job and gets an hour-long GitHub token for your org from
  api.backmesh.com about every 30 minutes. An outage longer than 30 minutes
  makes new jobs wait at GitHub until it answers.

Jobs from every repository in an org share backmesh's labels and trust level;
per-repository runner groups are planned. For public repositories, RunsOn's
security docs say to use a separate environment. backmesh doesn't run public
repositories yet.

## Spot and interruptions

Both run spot by default. RunsOn tries spot first and launches on demand when
spot capacity is unavailable, which its docs put at a 2 to 3 second delay on
Flex. A job that loses its spot instance mid-run is retried once on an
on-demand instance by default, and a circuit breaker moves the stack to on
demand when interruptions spike.

backmesh falls back to the next VM type in the label's list, then another
region, when a cloud refuses for capacity. When no type has capacity, jobs
wait at GitHub. When spot reclaims were a run's only failures, it reruns those jobs
once the run finishes, preferring on demand, up to twice. After 2 reclaims in
15 minutes on a cloud, it starts that cloud's spot jobs on demand for 30
minutes. `backmesh-od-*` labels run on demand every time.

## Caching

GitHub's cache holds 10 GB per repository for free. Both tools move the cache
into a bucket in your account.

- RunsOn's Magic Cache points `actions/cache` and the `setup-*` actions'
  caches at S3 in your VPC with no change to cache steps. A job adds
  `extras=s3-cache` to its label and a `runs-on/action@v2` step. RunsOn sets no size cap. RunsOn's
  benchmark shows a 4 GB restore in 17 seconds against 41 seconds on
  GitHub-hosted at 4 vCPU.
- RunsOn also offers Docker layer caching through an ephemeral ECR registry in
  your account, and sticky disks: an EBS volume snapshotted after each job
  and restored before the next, for caches that are slow to archive.
- backmesh's [cache](/cache/) is a bucket in each runner region.
  `backmesh/cache` takes the same inputs as `actions/cache`. The versions
  `setup-*` actions install and npm, Yarn and pnpm downloads are cached with
  no workflow change. Each repository keeps up to 10 GB per region by default,
  changed with `--cache-cap`.

backmesh has no Docker layer cache: each job starts on a new VM with no image
layers. For heavy Docker builds, RunsOn's ECR cache and sticky disks do more
today.

## Start times

RunsOn publishes its numbers on AWS. In its burst benchmark, 15 jobs queued at
once, the median wait from queued to running was 15 to 21 seconds across 29 x64
runner types. Its warm pools docs list Linux queue times under 25 seconds cold,
under 15 seconds from a stopped pool and under 6 seconds from a hot pool, which
bills for running instances.

A backmesh VM boots in about 30 seconds on AWS and 60 to 70 seconds on GCP and
Azure. backmesh learns each workflow's shape and starts runners ahead of a
run's later jobs. A coding agent can run `backmesh cue --in <seconds>` when its
pre-push checks start, so runners for the run's first jobs boot before the
push.

RunsOn also publishes [benchmarks](https://runs-on.com/benchmarks/) of 9
providers and 94 runners, last run on 2026-11-16 from an open harness. backmesh
hasn't published comparable benchmarks.

## Upkeep

| Task         | RunsOn                                                         | backmesh                                                           |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Upgrades     | Update the stack version; the stack pins it until you upgrade  | `backmesh upgrade`                                                 |
| Runner image | RunsOn's AMIs from GitHub's templates, or your own             | backmesh's [image](/runner-image/), or `container:` per job        |
| Visibility   | Per-job cost reporting, OpenTelemetry export                   | `backmesh status`: runners, queue, start times, month-to-date cost |
| Removal      | Delete the stack, empty its two buckets, remove the GitHub App | `backmesh uninstall`                                               |

RunsOn's AMIs come from GitHub's own image templates, so jobs that rely on
`ubuntu-latest`'s preinstalled tools tend to run unchanged. backmesh's image
lacks those toolchains and systemd; see [Coming from
ubuntu-latest](/from-ubuntu-latest/).

## What it costs

RunsOn's bill has three lines, per its pricing page: the license, EC2 and EBS,
and the control plane. backmesh's has two: VMs with their disks, and the
control plane. Neither marks up compute.

| Tier        | Jobs a month   | € a year | $ a year |
| ----------- | -------------- | -------- | -------- |
| Free        | Non-commercial | 0        | 0        |
| Starter     | Under 50,000   | 300      | 350      |
| Growth      | Under 200,000  | 900      | 1,050    |
| Scale       | Under 500,000  | 1,800    | 2,100    |
| Sponsorship | No limit       | 3,600    | 4,200    |

RunsOn counts one job per runner launched, across all your orgs and AWS
accounts. Two months in a row over a tier moves you up. Paid tiers have a
15-day trial.

A worked month: 150,000 minutes of 4-vCPU Linux jobs on AWS spot. To pick a
RunsOn tier, assume an average job of 5 minutes, which is 30,000 jobs, inside
Starter.

- RunsOn compute: its pricing page lists `m8a.xlarge` at $0.0013 a minute,
  the 7-day average spot price in us-east-1's cheapest zone with a 30 GB gp3
  disk. 150,000 × $0.0013 = $195.
- RunsOn license: Starter, $350 ÷ 12 = $29.17 a month.
- RunsOn control plane: "from about $7 a month", per its pricing page.
- backmesh compute: [cost inputs](/cost/) put `backmesh-4` spot types in
  us-east-2 at $0.0497 to $0.07 an hour on 2026-11-13. 150,000 ÷ 60 = 2,500
  hours, so $124 to $175.
- backmesh disks: each runner's 100 GB disk is about $0.01 an hour on AWS,
  2,500 × $0.01 = $25.
- backmesh control plane: about $86 a month on AWS.

| On AWS, 150,000 4-vCPU minutes | Compute   | Disks      | License | Control plane | Total, about |
| ------------------------------ | --------- | ---------- | ------- | ------------- | ------------ |
| GitHub-hosted 4-core           | $1,800    | included   | none    | none          | $1,800       |
| RunsOn                         | $195      | in compute | $29     | $7            | $231         |
| backmesh                       | $124–$175 | $25        | none    | $86           | $235–$286    |

The two land within about $5 to $55 of each other. Regions and price dates differ, and both rows leave out boot time and on-demand retries. backmesh
puts boots at $0.41 to $0.58 per 1,000 jobs on AWS, about $12 to $17 for
30,000 jobs. If the average job were 2 minutes, 75,000 jobs, RunsOn moves to
Growth at $87.50 a month, about $290 in total.

On GCP and Azure there is no RunsOn row. backmesh's [cost page](/cost/) puts
the same 150,000 minutes at $191 to $206 a month on Azure and $299 to $365 on
GCP, control plane included, before disks and boots. To try your own numbers,
use the [cost calculator](/calculator/).

GitHub announced a $0.002 per minute fee for self-hosted runners in private
repositories in December 2025, then postponed it. It would reach both tools'
jobs the same way; see [where it stands](/blog/github-self-hosted-runner-fee/).

## Which to pick

Pick RunsOn if you're on AWS and need Windows, arm64 or GPU runners, want to
choose instance families, RAM and disks per job, or run heavy Docker builds
that benefit from a layer cache or sticky disks. It's the more mature of the
two, with releases since 2023, published benchmarks, warm pools, GitHub
Enterprise Server support, and, per RunsOn, 1,200+ companies and 5M+ jobs a
day. It also runs public repositories, and its license is free for
non-commercial and open-source projects.

Pick backmesh if your runners belong on GCP or Azure, or on more than one
cloud from one install. Pick it if you want no license fee and no job-count
tiers for commercial use, under Apache-2.0, or if your coding agents push
often and `backmesh cue` would start runners before they do. It's a new
project, its public repository dates from 2026-11-16, and it runs only Linux
x86-64 jobs in private repositories, with no Docker layer cache between jobs.

## Moving between them

Both take jobs by `runs-on` label, so they can run side by side in one org and
workflows can move one at a time. To try backmesh next to RunsOn: install
backmesh for the org, change one workflow's `runs-on` from a RunsOn label to
`backmesh-4`, compare its run times in `backmesh status`, then move the rest.
Swap `extras=s3-cache` and `runs-on/action@v2` for `backmesh/cache` steps.
Windows, arm64 and GPU jobs stay on RunsOn. For other free options, see [ARC vs terraform-aws-github-runner vs
backmesh](/blog/arc-vs-terraform-aws-github-runner-vs-backmesh/).

## Questions

**What is the difference between backmesh and RunsOn?** Both run each job on a
fresh spot VM in your own cloud account. RunsOn is AWS only, supports Linux
x64 and arm64, Windows and GPU, and charges a yearly license for commercial
use. backmesh runs on AWS, GCP and Azure, supports Linux x86-64 only in
private repositories, and is free under Apache-2.0.

**Is there a RunsOn alternative for GCP or Azure?** Yes. RunsOn runs on AWS
only. backmesh runs each job on its own spot VM in a GCP project or an Azure
subscription as well as an AWS account, and one install can use several
clouds.

**Is RunsOn open source?** Partly. Its public repository holds MIT-licensed
CloudFormation assets and supporting files, and the RunsOn server and agent
are commercially licensed. It's free for non-profit, open-source and personal
non-commercial projects. The Sponsorship plan includes the full server and
agent source.

**How much does a RunsOn license cost?** Per its pricing page on 2026-11-18,
per legal entity per year: Starter €300 under 50,000 jobs a month, Growth €900
under 200,000, Scale €1,800 under 500,000, and Sponsorship €3,600 with no job
limit. In US dollars that's $350, $1,050, $2,100 and $4,200. AWS bills the
instances separately.

**Which is cheaper for 150,000 minutes of 4-vCPU jobs on AWS?** They come out
close. From each side's published prices, RunsOn is about $231 a month with a
Starter license and its control plane, and backmesh about $235 to $286 with
disks and its control plane. GitHub-hosted 4-core runners cost $1,800 for the
same minutes.

**Does RunsOn support Windows, arm64 and GPU runners?** Yes. RunsOn runs Linux
x64 and arm64, Windows Server 2022 and 2025, and NVIDIA and AMD GPU instances.
Neither RunsOn nor backmesh runs macOS. backmesh runs Linux x86-64 only.

**Which starts jobs faster?** RunsOn publishes a median wait of 15 to 21
seconds from queued to running on AWS, and under 6 seconds with hot warm
pools. A backmesh VM boots in about 30 seconds on AWS and 60 to 70 seconds on
GCP and Azure, and backmesh starts runners ahead of predicted jobs and of
pushes its coding agent cues.

**Can I run RunsOn and backmesh side by side?** Yes. Both pick up jobs by
their `runs-on` label, so each job goes to the one its label names, and
workflows can move one at a time.
