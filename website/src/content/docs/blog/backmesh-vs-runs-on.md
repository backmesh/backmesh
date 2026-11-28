---
title: 'backmesh vs RunsOn: self-hosted GitHub Actions runners in your own cloud compared'
description: backmesh and RunsOn both run each GitHub Actions job on a fresh spot VM in your own cloud account. A side-by-side on license, clouds, caching and how each works, with backmesh's measured start times.
date: 2026-11-18
lastUpdated: 2026-11-18
authors: backmesh
tags:
  - Comparisons
excerpt: RunsOn runs GitHub Actions jobs on EC2 in your AWS account under a yearly license. backmesh runs them on spot VMs in AWS, GCP or Azure under Apache-2.0. A side-by-side on license, clouds, caching and how each works, with backmesh's measured start times.
head:
  - tag: title
    content: 'backmesh vs RunsOn (2026): a RunsOn alternative for AWS, GCP and Azure | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is the difference between backmesh and RunsOn?","acceptedAnswer":{"@type":"Answer","text":"Both run each GitHub Actions job on a fresh spot VM in your own cloud account. RunsOn is AWS only, supports Linux x64 and arm64, Windows and GPU, and charges a yearly license for commercial use. backmesh runs on AWS, GCP and Azure, supports Linux x86-64 and arm64, in private repositories or, with --public-repos, public ones, with NVIDIA T4 GPUs on AWS and Azure, and is free under Apache-2.0."}},{"@type":"Question","name":"Is there a RunsOn alternative for GCP or Azure?","acceptedAnswer":{"@type":"Answer","text":"Yes. RunsOn runs on AWS only. backmesh runs each job on its own spot VM in a GCP project or an Azure subscription as well as an AWS account, and one install can use several clouds."}},{"@type":"Question","name":"Does RunsOn support Windows, arm64 and GPU runners?","acceptedAnswer":{"@type":"Answer","text":"Yes. RunsOn runs Linux x64 and arm64, Windows, and GPU instances. backmesh runs Linux x86-64 and arm64, with NVIDIA T4 GPUs on AWS and Azure, and neither runs macOS."}}]}'
---

backmesh and RunsOn both run each GitHub Actions job on a fresh spot VM in
your own cloud account, and your cloud bills you for the compute. backmesh is
free under Apache-2.0, runs on AWS, GCP and Azure, and starts runners ahead
of jobs. RunsOn is AWS only, runs Linux, Windows, arm64 and GPU jobs, and
charges a yearly license for commercial use.

Everything about RunsOn below comes from [runs-on.com](https://runs-on.com/)
and [github.com/runs-on/runs-on](https://github.com/runs-on/runs-on), read on
2026-11-18. backmesh publishes this page.

## What we measured

These are our own measurements of backmesh on AWS in November 2026.

**Disk.** Each backmesh runner has a 100 GB gp3 disk at 4,000 IOPS and
500 MiB/s. Our [runner disk spike](https://github.com/anycloud-sh/anycloud/blob/depombo/runner-disk-tier-spike/experiments/runner-disk-tier/README.md)
([anycloud#7](https://github.com/anycloud-sh/anycloud/pull/7)) ran 5 spot
`m8i.xlarge` VMs on that disk and 5 on gp3 at its included 3,000 IOPS and
125 MiB/s. This compares backmesh's disk with gp3's baseline, not with
another product:

| Median                                | backmesh's disk, 4,000 IOPS and 500 MiB/s | gp3 baseline, 3,000 IOPS and 125 MiB/s |
| ------------------------------------- | ----------------------------------------- | -------------------------------------- |
| VM launch to runner container started | 36.7 s                                    | 61.8 s                                 |
| Runner image pull                     | 8.0 s                                     | 33.7 s                                 |
| `npm ci` for express 5.1.0            | 3.9 s                                     | 12.2 s                                 |

The faster disk costs about $0.0046 more per 10-minute job on AWS.

**Cued starts.** A coding agent can run `backmesh cue --in <seconds>` when its
pre-push checks start, so runners boot before the push. Over 24 jobs each,
cued jobs waited a median 17 seconds for a runner, against 100.5 seconds
uncued ([method and results](https://github.com/backmesh/backmesh/blob/main/benchmarks/cue/README.md#results)).

RunsOn publishes its own
[build and queue benchmarks](https://runs-on.com/benchmarks/) from an open
harness. We haven't benchmarked RunsOn.

## At a glance

|                     | [backmesh](https://github.com/backmesh/backmesh)                                                                                                | [RunsOn](https://runs-on.com/)                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| License             | Apache-2.0; the cache action MIT                                                                                                                | Server and agent commercial; the repo's CloudFormation assets MIT                                                                   |
| Price               | Free for all use. Your cloud bills you; its always-on VMs are about $86 a month on AWS for one org ([cost](/cost/), [calculator](/calculator/)) | Free for non-commercial use; €300 to €3,600 a year for commercial use, and AWS bills you ([pricing](https://runs-on.com/pricing/))  |
| Clouds              | AWS, GCP, Azure, several from one install                                                                                                       | AWS                                                                                                                                 |
| Operating systems   | Linux x86-64 and arm64; NVIDIA T4 GPUs on AWS and Azure                                                                                         | Linux x64 and arm64, Windows, GPU                                                                                                   |
| A fresh VM per job  | Yes                                                                                                                                             | Yes                                                                                                                                 |
| Starting ahead      | Learns each workflow's shape and starts runners for a run's later jobs; `backmesh cue` starts them before a push                                | [Warm pools](https://runs-on.com/docs/performance/warm-pools/) of stopped or running instances                                      |
| Runner disk         | 100 GB gp3 at 4,000 IOPS and 500 MiB/s                                                                                                          | Any size, IOPS and MiB/s per job ([`volume=`](https://runs-on.com/docs/runners/labels/)); its pricing assumes 30 GB gp3 at 400 MB/s |
| Cache               | A bucket per runner region; `setup-*` tools and npm, Yarn and pnpm downloads cached with no workflow change ([cache](/cache/))                  | [Magic Cache](https://runs-on.com/docs/performance/caching/actions/) in S3, an ECR Docker layer cache, sticky disks                 |
| Spot                | Default; fails over to other types and regions, reruns reclaimed jobs on demand                                                                 | Default, with on-demand fallback and a circuit breaker ([spot](https://runs-on.com/configuration/spot-instances/))                  |
| Isolation           | Runners have no cloud identity; each job gets a 15-minute cache token for its own repository ([security](/security/))                           | No inbound rules; per-repository cache isolation is opt-in ([security](https://runs-on.com/docs/control-plane/security/))           |
| Install             | `backmesh install --org <org>` through your `aws`, `gcloud` or `az` CLI                                                                         | A CloudFormation or Terraform stack; it creates a private GitHub App ([install](https://runs-on.com/installation/flex/))            |
| Public repositories | Not yet                                                                                                                                         | Supported, in a separate environment                                                                                                |

## How each one works

**backmesh.** `backmesh install` creates a control plane VM and, for each org, a
listener VM (t3.large and t3.small on AWS) in your account. The listener long-polls
GitHub for queued jobs, so nothing needs an inbound port or a webhook. For
each job, backmesh starts a VM in the cheapest region with capacity and
deletes it when the job ends. Labels pick one of four fixed
[sizes](/labels/) and a cloud, for example `runs-on: backmesh-ubuntu-2404-4vcpu` or
`backmesh-gcp-ubuntu-2404-4vcpu`.

**RunsOn.** A CloudFormation stack sets up networking, a cache bucket and a
control plane on ECS Fargate. GitHub posts each queued job's webhook to an API
Gateway endpoint in your account, and the job's label describes the machine,
for example `runs-on: runs-on=${{ github.run_id }}/family=m8+r8/cpu=4`. An
EC2 instance boots for the job, runs it and is terminated. Its Fleet mode
pulls jobs from GitHub instead
([Flex vs Fleet](https://runs-on.com/docs/flex-vs-fleet/)).

Both take jobs by `runs-on` label, so they can run side by side and workflows
can move one at a time.

## Which to pick

Pick backmesh if coding
agents push often and `backmesh cue` would start runners first, if you want
no license or job-count tiers, or if your runners belong on GCP, Azure or
several clouds. It's a new project, and runs only Linux jobs, x86-64 and arm64, in
private repositories unless you turn on [public repositories](/public-repos/), with no Docker layer
cache.

Pick RunsOn if you need Windows or GPUs other than a T4, per-job instance
families and disks, a Docker layer cache, or public repositories.

For free tools on Kubernetes and AWS, see
[ARC vs terraform-aws-github-runner vs backmesh](/blog/arc-vs-terraform-aws-github-runner-vs-backmesh/).

## Questions

**What is the difference between backmesh and RunsOn?** Both run each job on a
fresh spot VM in your own cloud account. RunsOn is AWS only, supports Linux
x64 and arm64, Windows and GPU, and charges a yearly license for commercial
use. backmesh runs on AWS, GCP and Azure, supports Linux x86-64 and arm64, in private repositories or, with `--public-repos`, public ones, with NVIDIA T4 GPUs on AWS and Azure, and is free under
Apache-2.0.

**Is there a RunsOn alternative for GCP or Azure?** Yes. RunsOn runs on AWS
only. backmesh runs each job on its own spot VM in a GCP project or an Azure
subscription as well as an AWS account, and one install can use several
clouds.

**Does RunsOn support Windows, arm64 and GPU runners?** Yes. RunsOn runs Linux
x64 and arm64, Windows, and GPU instances. backmesh runs Linux x86-64 and
arm64, with NVIDIA T4 GPUs on AWS and Azure, and neither runs macOS.
