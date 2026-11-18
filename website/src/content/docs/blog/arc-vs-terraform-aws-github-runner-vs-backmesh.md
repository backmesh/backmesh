---
title: 'ARC vs terraform-aws-github-runner vs backmesh: open-source GitHub Actions runners compared'
description: Three free, open-source ways to run autoscaling self-hosted GitHub Actions runners, compared on how they work, clouds, isolation and caching, with backmesh's measured start times.
date: 2026-11-18
lastUpdated: 2026-11-18
authors: backmesh
tags:
  - Comparisons
excerpt: Actions Runner Controller, terraform-aws-github-runner and backmesh are all free and open source. They differ in what you run to get runners. A side-by-side on how each works, clouds, isolation and caching, with backmesh's measured start times.
head:
  - tag: title
    content: 'ARC vs terraform-aws-github-runner vs backmesh (2026): open-source GitHub Actions runners compared | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Is there an alternative to Actions Runner Controller without Kubernetes?","acceptedAnswer":{"@type":"Answer","text":"Yes. terraform-aws-github-runner runs runners on EC2 through Lambda functions on AWS, and backmesh runs each job on its own spot VM in AWS, GCP or Azure from one CLI install. Neither needs a Kubernetes cluster."}},{"@type":"Question","name":"Which open-source GitHub Actions runner manager works on GCP and Azure?","acceptedAnswer":{"@type":"Answer","text":"ARC runs on any Kubernetes cluster, including GKE and AKS. backmesh runs VMs directly in GCP projects and Azure subscriptions as well as AWS accounts. terraform-aws-github-runner is AWS only."}},{"@type":"Question","name":"Does terraform-aws-github-runner use ephemeral runners?","acceptedAnswer":{"@type":"Answer","text":"Only if you turn on enable_ephemeral_runners; it defaults to false, so by default a runner can take more than one job."}}]}'
---

Actions Runner Controller (ARC), terraform-aws-github-runner and backmesh are
three free, open-source ways to autoscale self-hosted GitHub Actions runners.
In all three, your cloud bills you for the machines. What differs is what you
run to get them: a Kubernetes cluster for ARC, Terraform and Lambda functions
on AWS for the module, and one CLI install for backmesh, which gives each job
a fresh VM on AWS, GCP or Azure and starts runners ahead of jobs.

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

We haven't measured ARC or the Terraform module.

## At a glance

|                        | [backmesh](https://github.com/backmesh/backmesh)                                                                               | [ARC](https://github.com/actions/actions-runner-controller)                                                                                                             | [terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner)                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| License                | Apache-2.0                                                                                                                     | Apache-2.0, maintained by GitHub                                                                                                                                        | MIT, maintained by the community, formerly philips-labs                                                          |
| Price                  | Free. Your cloud bills you; the control plane is about $86 a month on AWS ([cost](/cost/), [calculator](/calculator/))         | Free. Your cloud bills you for the cluster ([EKS](https://aws.amazon.com/eks/pricing/), [GKE](https://cloud.google.com/kubernetes-engine/pricing)) and its nodes        | Free. AWS bills you for EC2, and per request for [Lambda](https://aws.amazon.com/lambda/pricing/) and its queues |
| Where runners run      | VMs on AWS, GCP or Azure, several from one install                                                                             | Pods on any Kubernetes cluster                                                                                                                                          | EC2 instances on AWS                                                                                             |
| What you operate       | The `backmesh` CLI and two always-on VMs (t3.large and t3.small on AWS)                                                        | The cluster, its node pools, ARC's Helm charts                                                                                                                          | Terraform state, Lambda zips, an AMI, the GitHub App webhook                                                     |
| A fresh runner per job | Yes, a new VM, deleted when the job ends                                                                                       | Yes, a new pod on a shared node                                                                                                                                         | Optional: `enable_ephemeral_runners` defaults to `false`                                                         |
| Starting ahead         | Learns each workflow's shape and starts runners for a run's later jobs; `backmesh cue` starts them before a push               | Idle runners kept by the scale set's `minRunners`                                                                                                                       | Idle instances kept by `pool_config`                                                                             |
| Docker in jobs         | The VM's own Docker; the job can be root on its own VM, which no other job shares                                              | A privileged Docker-in-Docker sidecar, or Kubernetes mode ([docs](https://docs.github.com/en/actions/tutorials/use-actions-runner-controller/deploy-runner-scale-sets)) | The instance's Docker                                                                                            |
| Cache                  | A bucket per runner region; `setup-*` tools and npm, Yarn and pnpm downloads cached with no workflow change ([cache](/cache/)) | GitHub's, unless you add one                                                                                                                                            | GitHub's, unless you add one                                                                                     |
| Spot                   | Default; fails over to other types and regions, reruns reclaimed jobs on demand                                                | Through spot node pools you set up                                                                                                                                      | Default, with optional on-demand failover                                                                        |
| Operating systems      | Linux x86-64 only                                                                                                              | Mostly Linux containers                                                                                                                                                 | Linux and Windows, x64 and arm64                                                                                 |
| Public repositories    | Not yet                                                                                                                        | Supported                                                                                                                                                               | Supported                                                                                                        |
| Upgrades               | `backmesh upgrade`                                                                                                             | Helm chart and cluster upgrades                                                                                                                                         | Module bumps, Lambda zips, `terraform apply`                                                                     |

## How each one works

**backmesh.** `backmesh install --org <org>` uses your signed-in `aws`,
`gcloud` or `az` CLI to create the control plane, and connects each cloud
with a keyless role. A listener long-polls GitHub, so nothing needs an
inbound port. For each job, backmesh starts a VM in the cheapest region with
capacity and deletes it when the job ends. A job moves over when its
`runs-on` changes, for example from `ubuntu-latest` to `backmesh-4`.

**ARC.** A Kubernetes operator that GitHub maintains. You install it with Helm
and create a runner scale set. A listener pod holds a long poll open to
GitHub; when jobs queue, ARC creates runner pods and removes them after. Pods
share their node's kernel with other pods.

**terraform-aws-github-runner.** An AWS serverless pipeline. GitHub sends a
webhook when a job queues; a Lambda function behind API Gateway puts it on
EventBridge and SQS, a scale-up Lambda launches EC2 instances, and a
scale-down Lambda removes idle ones every 5 minutes by default. Runners are
full VMs from an AMI you choose or build.

All three take jobs by `runs-on` label, so they can run side by side and
workflows can move one at a time.

## Which to pick

Pick backmesh if you want a fresh VM for every job without running a cluster
or a Terraform pipeline, if you want a runner disk set up for image pulls and package installs
without tuning it yourself,
if coding agents push often and `backmesh cue` would start runners first, or
if you're on GCP or Azure or want one install across several clouds. It's
the newest of the three, and supports only Linux x86-64 jobs in private
repositories.

Pick ARC if you already run Kubernetes. Pick terraform-aws-github-runner if
you're on AWS only and need Windows or arm64 runners. For paid tools that
also run in your account, see [backmesh vs RunsOn](/blog/backmesh-vs-runs-on/).

## Questions

**Is there an alternative to Actions Runner Controller without Kubernetes?**
Yes. terraform-aws-github-runner runs runners on EC2 through Lambda functions
on AWS, and backmesh runs each job on its own spot VM in AWS, GCP or Azure
from one CLI install. Neither needs a Kubernetes cluster.

**Which open-source GitHub Actions runner manager works on GCP and Azure?**
ARC runs on any Kubernetes cluster, including GKE and AKS. backmesh runs VMs
directly in GCP projects and Azure subscriptions as well as AWS accounts.
terraform-aws-github-runner is AWS only.

**Does terraform-aws-github-runner use ephemeral runners?** Only if you turn
on `enable_ephemeral_runners`; it defaults to `false`, so by default a runner
can take more than one job.
