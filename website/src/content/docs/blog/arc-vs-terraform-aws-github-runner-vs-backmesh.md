---
title: 'ARC vs terraform-aws-github-runner vs backmesh: open-source GitHub Actions runners compared'
description: Three free, open-source ways to run autoscaling self-hosted GitHub Actions runners, compared on how they work, clouds, monthly bills on AWS and measured start times.
date: 2026-11-18
lastUpdated: 2026-11-18
authors: backmesh
tags:
  - Comparisons
excerpt: Actions Runner Controller, terraform-aws-github-runner and backmesh are all free and open source. They differ in what you run to get runners. A side-by-side on how each works, clouds, monthly bills and start times.
head:
  - tag: title
    content: 'ARC vs terraform-aws-github-runner vs backmesh (2026): open-source GitHub Actions runners compared | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Is there an alternative to Actions Runner Controller without Kubernetes?","acceptedAnswer":{"@type":"Answer","text":"Yes. terraform-aws-github-runner runs runners on EC2 through Lambda functions on AWS, and backmesh runs each job on its own spot VM in AWS, GCP or Azure from one CLI install. Neither needs a Kubernetes cluster."}},{"@type":"Question","name":"Which open-source GitHub Actions runner manager works on GCP and Azure?","acceptedAnswer":{"@type":"Answer","text":"ARC runs on any Kubernetes cluster, including GKE and AKS. backmesh runs VMs directly in GCP projects and Azure subscriptions as well as AWS accounts. terraform-aws-github-runner is AWS only."}},{"@type":"Question","name":"Which is cheapest to run?","acceptedAnswer":{"@type":"Answer","text":"terraform-aws-github-runner, at every volume we priced on AWS, because it scales to zero: its Lambda, API Gateway, EventBridge and SQS calls cost about $1 to $19 a month at 10,000 to 1,000,000 minutes. ARC on EKS adds about $90 a month for the cluster fee and a node for its controller; on GKE the free tier covers the fee for one zonal or Autopilot cluster. backmesh costs the most: two always-on VMs at $86 a month on AWS, and a faster runner disk that costs more per job."}}]}'
---

Actions Runner Controller (ARC), terraform-aws-github-runner and backmesh are
three free, open-source ways to autoscale self-hosted GitHub Actions runners.
In all three, your cloud bills you for the machines. What differs is what you
run to get them: a Kubernetes cluster for ARC, Terraform and Lambda functions
on AWS for the module, and a CLI that sets up two always-on VMs for backmesh.

On AWS, the Terraform module costs the least at every volume we priced, and
backmesh the most. backmesh's case is faster starts and disk-bound steps, a
fresh VM per job with nothing to build, and three clouds.

## At a glance

|                        | [ARC](https://github.com/actions/actions-runner-controller)                                                                                                             | [terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner) | [backmesh](https://github.com/backmesh/backmesh)                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| License                | Apache-2.0, maintained by GitHub                                                                                                                                        | MIT, maintained by the community, formerly philips-labs                                          | Apache-2.0                                                                              |
| Where runners run      | Pods on any Kubernetes cluster                                                                                                                                          | EC2 instances on AWS                                                                             | VMs on AWS, GCP or Azure                                                                |
| What you operate       | The cluster, its node pools, ARC's Helm charts                                                                                                                          | Terraform state, Lambda zips, an AMI, the GitHub App webhook                                     | The `backmesh` CLI and two always-on VMs (t3.large and t3.small on AWS)                 |
| Install                | Two Helm charts, then a scale set                                                                                                                                       | A Terraform config and `terraform apply`                                                         | `backmesh install --org <org>`                                                          |
| A fresh runner per job | Yes, a new pod on a shared node                                                                                                                                         | Optional: `enable_ephemeral_runners` defaults to `false`                                         | Yes, a new VM, deleted when the job ends                                                |
| Docker in jobs         | A privileged Docker-in-Docker sidecar, or Kubernetes mode ([docs](https://docs.github.com/en/actions/tutorials/use-actions-runner-controller/deploy-runner-scale-sets)) | The instance's Docker                                                                            | The VM's Docker, unprivileged                                                           |
| Spot                   | Through spot node pools you set up; a reclaimed node fails its jobs                                                                                                     | Default, with optional on-demand failover                                                        | Default; reruns reclaimed jobs on demand; `backmesh-od-*` labels run on demand          |
| Operating systems      | Mostly Linux containers                                                                                                                                                 | Linux and Windows, x64 and arm64                                                                 | Linux x86-64 only                                                                       |
| Runner disk            | The node's                                                                                                                                                              | 30 GB gp3 by default                                                                             | 100 GB gp3 at 4,000 IOPS and 500 MiB/s                                                  |
| Cache                  | GitHub's, unless you add one                                                                                                                                            | GitHub's, unless you add one                                                                     | A bucket in your account per runner region, with `setup-*` and package downloads cached |
| Public repositories    | Supported                                                                                                                                                               | Supported                                                                                        | Not yet                                                                                 |
| Upgrades               | Helm chart and cluster upgrades                                                                                                                                         | Module bumps, Lambda zips, `terraform apply`                                                     | `backmesh upgrade`                                                                      |

## How each one works

**ARC.** A Kubernetes operator that GitHub maintains. You install it with Helm
and create a runner scale set. A listener pod holds a long poll open to
GitHub; when jobs queue, ARC creates runner pods and removes them after. Pods
share their node's kernel with other pods.

**terraform-aws-github-runner.** An AWS serverless pipeline. GitHub sends a
webhook when a job queues; a Lambda function behind API Gateway puts it on
EventBridge and SQS, a scale-up Lambda launches EC2 instances, and a
scale-down Lambda removes idle ones every 5 minutes. Runners are full VMs from
an AMI you choose or build.

**backmesh.** `backmesh install --org <org>` uses your signed-in `aws`,
`gcloud` or `az` CLI to create the control plane, and connects each cloud with
a keyless role. A listener long-polls GitHub, so nothing needs an inbound
port. For each job, backmesh starts a VM in the cheapest region with capacity
and deletes it when the job ends. A job moves over when its `runs-on` changes,
for example from `ubuntu-latest` to `backmesh-4`.

All three take jobs by `runs-on` label, so they can run side by side and
workflows can move one at a time.

## What it costs

Monthly bills for 4-vCPU Linux spot jobs of 5 minutes on AWS, with each
tool's fixed part and runner disks folded in:

| 4-vCPU minutes a month | GitHub-hosted | ARC on EKS  | terraform-aws-github-runner | backmesh      |
| ---------------------- | ------------- | ----------- | --------------------------- | ------------- |
| 10,000                 | $120          | $98–$101    | $9–$13                      | $101–$105     |
| 150,000                | $1,800        | $214–$265   | $136–$186                   | $316–$367     |
| 1,000,000              | $12,000       | $918–$1,256 | $902–$1,240                 | $1,621–$1,960 |

terraform-aws-github-runner is the cheapest at every volume, because it
scales to zero. ARC on EKS pays about $90 a month for its cluster and
controller node, then the same compute. backmesh costs the most: its two VMs
are $86 a month, and at 1,000,000 minutes a job costs $0.0081 to $0.0098
against $0.0045 to $0.0062 on the module. About $0.0029 of that gap is
backmesh's faster disk, against the module's default 30 GB baseline disk.

These leave out boot time and engineering time: building the module's
pipeline and AMIs, or running ARC's cluster. On GCP, the free tier covers
GKE's fee for one zonal or Autopilot cluster. To try your own numbers on AWS,
GCP and Azure, use the [cost calculator](/calculator/).

<details>
<summary>How the bills are computed</summary>

- **Compute.** backmesh's [cost inputs](/cost/) put 4-vCPU spot VMs in
  us-east-2 at $0.0497 to $0.07 an hour on 2026-11-13. All three can run spot,
  so all three pay about that.
- **ARC on EKS:** $90 a month. The EKS fee is $0.10 an hour, $73. ARC's
  [controller chart](https://github.com/actions/actions-runner-controller/blob/master/charts/gha-runner-scale-set-controller/values.yaml)
  requests no CPU or memory by default, so the smallest node that fits sets
  the cost. A t3.micro takes 4 pods on EKS, too few for the cluster's own pods
  plus the controller and a listener; a t3.small takes 11. A t3.small at
  $0.0208 an hour with a 20 GB gp3 disk: $16.78.
- **The Terraform module:** $1, $3 and $19 a month at the three volumes, with
  its [defaults](https://github.com/github-aws-runners/terraform-aws-github-runner/blob/main/variables.tf).
  Always on: a 512 MB scale-down Lambda every 5 minutes and Lambda's polling of
  the build queue, $0.38. Per job: three `workflow_job` webhooks, each an HTTP
  API call, a 100 ms Lambda call and an archived EventBridge event, then a
  dispatcher call, two SQS requests and a 2-second scale-up call, about $0.03
  per 1,000 jobs. The CloudWatch agent is on by default: 100 KB of logs per
  job, kept 180 days, about $0.07 per 1,000 jobs. Its runner disk is 30 GB
  gp3 at baseline, $0.0033 an hour.
- **backmesh:** $87, $96 and $154 a month. The two VMs with their disks and
  public addresses are $86. Its cache buckets add the rest: per job, 50 GET
  and 10 PUT or LIST requests and 0.05 GB saved, as if one job in ten saved a
  500 MB entry, kept 7 days. Its runner disk is 100 GB gp3 at 4,000 IOPS and
  500 MiB/s: $0.011 an hour for storage and $0.027 for IOPS and throughput
  above the baseline, $0.0384 in all.
- **GitHub-hosted:** 4-core runners at $0.012 a minute.

Prices are AWS us-east-1 list prices before free tiers, read on 2026-11-18,
from AWS's pricing pages for [EKS](https://aws.amazon.com/eks/pricing/),
[EC2](https://aws.amazon.com/ec2/pricing/on-demand/),
[EBS](https://aws.amazon.com/ebs/pricing/),
[Lambda](https://aws.amazon.com/lambda/pricing/),
[API Gateway](https://aws.amazon.com/api-gateway/pricing/),
[EventBridge](https://aws.amazon.com/eventbridge/pricing/),
[SQS](https://aws.amazon.com/sqs/pricing/),
[S3](https://aws.amazon.com/s3/pricing/) and
[CloudWatch](https://aws.amazon.com/cloudwatch/pricing/). Lambda's and SQS's
always-free tiers would cover most of the module's bill. The webhook, log and
cache inputs are our estimates; none of the three projects publishes per-job
figures.

</details>

## Speed

A job on an autoscaled runner waits for capacity. ARC waits for a pod to
schedule, plus a node's boot if the cluster has to add one. The module waits
for an EC2 instance to boot and register, unless its `pool_config` keeps idle
instances ready. We found no published start-time measurements for either.

backmesh's numbers are our own measurements on AWS in November 2026, over 15
spot `m8i.xlarge` runners. With backmesh's disk, a runner was ready a median
36.7 seconds after its VM launched, against 61.8 seconds on a baseline gp3
disk. Pulling the runner image took 8.0 seconds against 33.7, and `npm ci`
for express 5.1.0 took 3.9 seconds against 12.2. A coding agent can run
`backmesh cue` before it pushes so runners boot early: over 24 jobs each,
cued jobs waited a median 17 seconds for a runner, against 100.5 seconds
uncued.

## Which to pick

Pick ARC if you already run Kubernetes and have people who look after it.
It's GitHub's own reference for runner scale sets, runs on any cloud with
Kubernetes, and supports public repositories.

Pick terraform-aws-github-runner if you're on AWS only, already manage AWS
with Terraform, need Windows or arm64 runners, or want the lowest bill and are
fine owning the pipeline.

Pick backmesh if you want a fresh VM for every job without running a cluster
or a Terraform pipeline, if image pulls and package installs slow your jobs,
or if you're on GCP or Azure or want one install across several clouds. It's
the newest of the three, and supports only Linux x86-64 jobs in private
repositories. For paid tools that also run in your account, see
[backmesh vs RunsOn](/blog/backmesh-vs-runs-on/).

## Questions

**Is there an ARC alternative without Kubernetes?** Yes.
terraform-aws-github-runner runs runners on EC2 through Lambda functions on
AWS, and backmesh runs each job on its own spot VM in AWS, GCP or Azure from
one CLI install.

**Which works on GCP and Azure?** ARC, on GKE or AKS. backmesh, with VMs in
your project or subscription. terraform-aws-github-runner is AWS only.

**Which is cheapest to run?** terraform-aws-github-runner, at every volume we
priced on AWS, because it scales to zero: about $1 to $19 a month at 10,000 to
1,000,000 minutes on top of compute. ARC on EKS adds about $90 a month for the
cluster fee and a node for its controller; on GKE the free tier covers the fee
for one zonal or Autopilot cluster. backmesh costs the most: two always-on VMs
at $86 a month on AWS, and a faster runner disk that costs more per job.
