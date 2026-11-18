---
title: 'backmesh vs RunsOn: self-hosted GitHub Actions runners in your own cloud compared'
description: backmesh and RunsOn both run each GitHub Actions job on a fresh spot VM in your own cloud account. A side-by-side on license, clouds, how each works, monthly bills on AWS and measured start times.
date: 2026-11-18
lastUpdated: 2026-11-18
authors: backmesh
tags:
  - Comparisons
excerpt: RunsOn runs GitHub Actions jobs on EC2 in your AWS account under a yearly license, and costs less on AWS. backmesh runs them on spot VMs in AWS, GCP or Azure under Apache-2.0, with faster disks and cued starts. A side-by-side on license, clouds, bills and start times.
head:
  - tag: title
    content: 'backmesh vs RunsOn (2026): a RunsOn alternative for AWS, GCP and Azure | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is the difference between backmesh and RunsOn?","acceptedAnswer":{"@type":"Answer","text":"Both run each GitHub Actions job on a fresh spot VM in your own cloud account. RunsOn is AWS only, supports Linux x64 and arm64, Windows and GPU, and charges a yearly license for commercial use. backmesh runs on AWS, GCP and Azure, supports Linux x86-64 only in private repositories, and is free under Apache-2.0."}},{"@type":"Question","name":"Which is cheaper on AWS, RunsOn or backmesh?","acceptedAnswer":{"@type":"Answer","text":"RunsOn, at every volume we priced. At 1,000,000 4-vCPU minutes a month, RunsOn is about $1,592 and backmesh $1,621 to $1,960, license and control planes included. backmesh''s two always-on VMs cost $86 a month at any volume, and its faster runner disk costs more per job."}},{"@type":"Question","name":"Is there a RunsOn alternative for GCP or Azure?","acceptedAnswer":{"@type":"Answer","text":"Yes. RunsOn runs on AWS only. backmesh runs each job on its own spot VM in a GCP project or an Azure subscription as well as an AWS account, and one install can use several clouds."}}]}'
---

backmesh and RunsOn both run each GitHub Actions job on a fresh spot VM in
your own cloud account, and your cloud bills you for the compute. RunsOn is
AWS only, runs Linux, Windows, arm64 and GPU jobs, and charges a yearly
license for commercial use. backmesh runs on AWS, GCP and Azure, runs only
Linux x86-64 jobs in private repositories, and is free under Apache-2.0.

On AWS, RunsOn costs less at every volume we priced. backmesh's case is
faster starts and disk-bound steps, no license, and three clouds.

Everything about RunsOn below comes from [runs-on.com](https://runs-on.com/)
and [github.com/runs-on/runs-on](https://github.com/runs-on/runs-on), read on
2026-11-18. backmesh publishes this page.

## At a glance

|                     | [RunsOn](https://runs-on.com/)                                                                                             | [backmesh](https://github.com/backmesh/backmesh)                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| License             | Server and agent commercial; the repo's CloudFormation assets MIT                                                          | Apache-2.0; the cache action MIT                                                                                      |
| Price               | Free for non-commercial use; €300 to €3,600 a year for commercial use ([pricing](https://runs-on.com/pricing/))            | Free for all use                                                                                                      |
| Clouds              | AWS                                                                                                                        | AWS, GCP, Azure                                                                                                       |
| Operating systems   | Linux x64 and arm64, Windows, GPU; no macOS                                                                                | Linux x86-64 only                                                                                                     |
| Install             | A CloudFormation stack, then a GitHub App you register ([install](https://runs-on.com/installation/flex/))                 | `backmesh install --org <org>` through your `aws`, `gcloud` or `az` CLI                                               |
| Control plane       | A Fargate task with Lambda functions and queues, "from about $7 a month"                                                   | Two always-on VMs (t3.large and t3.small on AWS): $86 a month on AWS, $74 on GCP, $111 on Azure                       |
| Spot                | Default, with on-demand fallback and a circuit breaker ([spot](https://runs-on.com/configuration/spot-instances/))         | Default, failing over to other types and regions; `backmesh-od-*` labels run on demand                                |
| Runner disk         | Configurable per job; its pricing quotes a 30 GB gp3 disk                                                                  | 100 GB gp3 at 4,000 IOPS and 500 MiB/s                                                                                |
| Cache               | S3 Magic Cache, an ECR Docker layer cache, sticky disks ([caching](https://runs-on.com/docs/performance/caching/actions/)) | A bucket per runner region; `setup-*` and package downloads cached with no workflow change; no layer cache            |
| Isolation           | No inbound rules; cache isolation per repository is opt-in ([security](https://runs-on.com/docs/control-plane/security/))  | Runners have no cloud identity; each job gets a 15-minute cache token for its own repository ([security](/security/)) |
| Public repositories | Supported, in a separate environment                                                                                       | Not yet                                                                                                               |
| Runner image        | A full Ubuntu 24.04 image, or your own                                                                                     | Ubuntu 24.04 with GitHub's apt packages; toolchains from setup actions ([differences](/from-ubuntu-latest/))          |
| Upgrades            | Update the stack ([upgrades](https://runs-on.com/docs/maintenance/upgrades/))                                              | `backmesh upgrade`                                                                                                    |

## How each one works

**RunsOn.** The CloudFormation stack sets up networking, a cache bucket and a
control plane on ECS Fargate. GitHub posts each queued job's webhook to an API
Gateway endpoint in your account, and the job's label describes the machine,
for example `runs-on: runs-on=${{ github.run_id }}/family=m8+r8/cpu=4`. An
EC2 instance boots for the job, runs it and is terminated. In its Fleet mode a
`fleetd` process pulls jobs from GitHub instead
([Flex vs Fleet](https://runs-on.com/docs/flex-vs-fleet/)).

**backmesh.** A listener on the control plane long-polls GitHub for queued
jobs, so nothing needs an inbound port or a webhook. For each job, backmesh
starts a VM in the cheapest region with capacity and deletes it when the job
ends. Labels pick one of four fixed [sizes](/labels/) and a cloud, for example
`runs-on: backmesh-4` or `backmesh-gcp-4`.

Both take jobs by `runs-on` label, so they can run side by side and workflows
can move one at a time.

## What it costs

Monthly bills for 4-vCPU Linux spot jobs of 5 minutes on AWS, with each
tool's license and control plane folded in:

| 4-vCPU minutes a month | Jobs    | GitHub-hosted | RunsOn         | backmesh      |
| ---------------------- | ------- | ------------- | -------------- | ------------- |
| 10,000                 | 2,000   | $120          | $52 (Starter)  | $101–$105     |
| 150,000                | 30,000  | $1,800        | $249 (Starter) | $316–$367     |
| 1,000,000              | 200,000 | $12,000       | $1,592 (Scale) | $1,621–$1,960 |

RunsOn is cheaper at every volume. At small volumes, backmesh's two VMs, $86
a month however few jobs run, outweigh RunsOn's license. At large ones the
gap narrows to about a tenth of a cent a job, $0.0080 for RunsOn against
$0.0081 to $0.0098 for backmesh at 1,000,000 minutes. Most of that is
backmesh's faster disk, which costs about $0.0023 more per 5-minute job than a
baseline gp3 disk of the same size.

On GCP and Azure there is no RunsOn row; backmesh's [cost page](/cost/) has
those clouds, and the [cost calculator](/calculator/) takes your own numbers.

<details>
<summary>How the bills are computed</summary>

- **RunsOn's runners.** Its [pricing page](https://runs-on.com/pricing/) lists
  `m8a.xlarge` at $0.0013 a minute, the 7-day average spot price in
  us-east-1's cheapest zone with a 30 GB gp3 disk.
- **RunsOn's license.** Per legal entity per year: Starter €300 ($350) under
  50,000 jobs a month, Growth €900 ($1,050) under 200,000, Scale €1,800
  ($2,100) under 500,000, Sponsorship €3,600 ($4,200). RunsOn counts one job
  per runner launched.
- **RunsOn's stack**, from its
  [CloudFormation template](https://github.com/runs-on/runs-on/blob/main/cloudformation/template.yaml)
  with its defaults: $9, $25 and $117 a month at the three volumes. Always on:
  the Fargate task (0.25 vCPU, 0.5 GB, Arm) at $7.21, two Secrets Manager
  secrets at $0.80, and queue polling at $0.31. Per job: four webhooks, each an
  API Gateway REST call, a 100 ms Lambda call and three FIFO queue requests,
  plus DynamoDB, a cache-credential Lambda call and 100 KB of CloudWatch Logs,
  about $0.09 per 1,000 jobs. The cache is below.
- **backmesh's runners.** `backmesh-4` spot types in us-east-2 at $0.0497 to
  $0.07 an hour on 2026-11-13 ([cost inputs](/cost/)), plus the 100 GB gp3
  disk at 4,000 IOPS and 500 MiB/s: $0.011 an hour for storage and $0.027 for
  IOPS and throughput above gp3's baseline, $0.0384 in all.
- **backmesh's control plane:** $87, $96 and $154 a month. The two VMs with
  their disks and public addresses are $86; the rest is the cache.
- **The cache, the same for both.** Per job, 50 GET and 10 PUT or LIST
  requests and 0.05 GB saved, as if one job in ten saved a 500 MB entry.
  Entries last 10 days on RunsOn, its default, and 7 days on backmesh.
  backmesh's 10 GB cap per repository and region can lower that.
- **GitHub-hosted:** 4-core runners at $0.012 a minute.

Prices are AWS us-east-1 list prices before free tiers, read on 2026-11-18,
from AWS's pricing pages for
[Fargate](https://aws.amazon.com/fargate/pricing/),
[Lambda](https://aws.amazon.com/lambda/pricing/),
[API Gateway](https://aws.amazon.com/api-gateway/pricing/),
[SQS](https://aws.amazon.com/sqs/pricing/),
[DynamoDB](https://aws.amazon.com/dynamodb/pricing/on-demand/),
[Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/),
[S3](https://aws.amazon.com/s3/pricing/),
[CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) and
[EBS](https://aws.amazon.com/ebs/pricing/). Neither project publishes per-job
figures, so the webhook, log and cache inputs are our estimates. At 10,000
minutes RunsOn's stack comes to $9, a little above its own "from about $7":
the Fargate task alone is $7.21. Both columns leave out boot time and
on-demand retries.

</details>

## Speed

backmesh's numbers are our own measurements on AWS in November 2026. With
backmesh's disk, a runner was ready a median 36.7 seconds after its VM
launched, against 61.8 seconds on a baseline gp3 disk. Pulling the runner
image took 8.0 seconds against 33.7, and `npm ci` for express 5.1.0 took 3.9
seconds against 12.2. That was over 15 spot `m8i.xlarge` runners.

A coding agent can run `backmesh cue --in <seconds>` when its pre-push checks
start, so runners boot before the push. Over 24 jobs each, cued jobs waited a
median 17 seconds for a runner, against 100.5 seconds uncued.

RunsOn publishes [build and queue benchmarks](https://runs-on.com/benchmarks/)
from an open harness, and offers
[warm pools](https://runs-on.com/docs/performance/warm-pools/) that cut the
wait at the cost of idle instances. Neither project has benchmarked the
other.

## Which to pick

Pick RunsOn if you're on AWS and want the lower bill, or need Windows, arm64
or GPU runners, per-job instance families and disks, a Docker layer cache or
public repositories. It's the more mature of the two, and free for
non-commercial and open-source projects.

Pick backmesh if steps that read and write disk, such as image pulls and
package installs, slow your jobs, or if coding agents push often and
`backmesh cue` would start runners first. Pick it too if you want no license
or job-count tiers, or runners on GCP, Azure or several clouds from one
install. It's a new project, and runs only Linux x86-64 jobs in private
repositories.

For free tools on AWS and Kubernetes, see
[ARC vs terraform-aws-github-runner vs backmesh](/blog/arc-vs-terraform-aws-github-runner-vs-backmesh/).

## Questions

**What is the difference between backmesh and RunsOn?** Both run each job on a
fresh spot VM in your own cloud account. RunsOn is AWS only, supports Linux
x64 and arm64, Windows and GPU, and charges a yearly license for commercial
use. backmesh runs on AWS, GCP and Azure, supports Linux x86-64 only in
private repositories, and is free under Apache-2.0.

**Which is cheaper on AWS, RunsOn or backmesh?** RunsOn, at every volume we
priced. At 1,000,000 4-vCPU minutes a month, RunsOn is about $1,592 and
backmesh $1,621 to $1,960, license and control planes included. backmesh's
two always-on VMs cost $86 a month at any volume, and its faster runner disk
costs more per job.

**Is there a RunsOn alternative for GCP or Azure?** Yes. RunsOn runs on AWS
only. backmesh runs each job on its own spot VM in a GCP project or an Azure
subscription as well as an AWS account, and one install can use several
clouds.
