---
title: 'ARC vs terraform-aws-github-runner vs backmesh: open-source GitHub Actions runners compared'
description: Three free, open-source ways to run autoscaling self-hosted GitHub Actions runners, compared on how they work, setup, clouds, isolation, spot, caching, start times, upkeep and cost, with a worked monthly bill.
date: 2026-11-18
lastUpdated: 2026-11-18
authors: backmesh
tags:
  - Comparisons
excerpt: Actions Runner Controller, terraform-aws-github-runner and backmesh are all free and open source. They differ in what you run to get runners. A side-by-side on setup, clouds, isolation, spot, caching, start times, upkeep and a worked monthly bill.
head:
  - tag: title
    content: 'ARC vs terraform-aws-github-runner vs backmesh (2026): open-source GitHub Actions runners compared | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What are the open-source alternatives to GitHub-hosted runners?","acceptedAnswer":{"@type":"Answer","text":"Three free, open-source runner managers autoscale self-hosted GitHub Actions runners: Actions Runner Controller (ARC, Apache-2.0, on Kubernetes), terraform-aws-github-runner (MIT, on AWS with Lambda, SQS and EC2) and backmesh (Apache-2.0, a spot VM per job on AWS, GCP or Azure)."}},{"@type":"Question","name":"Is there an alternative to Actions Runner Controller without Kubernetes?","acceptedAnswer":{"@type":"Answer","text":"Yes. terraform-aws-github-runner runs runners on EC2 through Lambda functions on AWS, and backmesh runs each job on its own spot VM in AWS, GCP or Azure from one CLI install. Neither needs a Kubernetes cluster."}},{"@type":"Question","name":"Which open-source GitHub Actions runner manager works on GCP and Azure?","acceptedAnswer":{"@type":"Answer","text":"ARC runs on any Kubernetes cluster, including GKE and AKS. backmesh runs VMs directly in GCP projects and Azure subscriptions as well as AWS accounts. terraform-aws-github-runner is AWS only."}},{"@type":"Question","name":"Which is cheapest to run?","acceptedAnswer":{"@type":"Answer","text":"All three are free software, and runners bill as cloud compute. The fixed part differs: ARC needs a Kubernetes cluster (EKS and GKE charge $0.10 per cluster per hour, about $73 a month, plus nodes), terraform-aws-github-runner scales to zero and bills Lambda and SQS per request, and backmesh keeps two small VMs at about $74 to $111 a month."}},{"@type":"Question","name":"Does terraform-aws-github-runner use ephemeral runners?","acceptedAnswer":{"@type":"Answer","text":"Optionally. Its enable_ephemeral_runners variable defaults to false, so runners can be reused across jobs unless you turn it on."}}]}'
---

Actions Runner Controller (ARC), terraform-aws-github-runner and backmesh are
the three free, open-source ways to autoscale self-hosted GitHub Actions
runners. In all three, your cloud bills you for the machines. What differs is
what you run to get them: a Kubernetes cluster for ARC, Terraform plus Lambda
functions on AWS for terraform-aws-github-runner, and a CLI that sets up two
small VMs for backmesh.

All figures below were checked on 2026-11-18 against each project's
repository and its cloud's pricing page. backmesh publishes this page, so it
names backmesh's limits next to each strength.

## At a glance

|                        | [ARC](https://github.com/actions/actions-runner-controller) | [terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner) | [backmesh](https://github.com/backmesh/backmesh)             |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| License                | Apache-2.0                                                  | MIT                                                                                              | Apache-2.0                                                   |
| Maintained by          | GitHub                                                      | Community, formerly philips-labs                                                                 | backmesh                                                     |
| Where runners run      | Pods on any Kubernetes cluster                              | EC2 instances on AWS                                                                             | VMs on AWS, GCP or Azure                                     |
| What you operate       | The cluster, its node pools, ARC's Helm charts              | Terraform state, Lambda functions, SQS queues, the GitHub App webhook                            | The `backmesh` CLI; it creates two small VMs in your account |
| A fresh runner per job | Yes, ephemeral pods                                         | Optional: `enable_ephemeral_runners` defaults to `false`                                         | Yes, a new VM per job, deleted when it ends                  |
| Spot                   | Through spot node pools you set up                          | Default: `instance_target_capacity_type` is `spot`                                               | Default; `backmesh-od-*` labels run on demand                |
| Operating systems      | Mostly Linux containers                                     | Linux and Windows, x64 and arm64                                                                 | Linux x86-64 only                                            |
| Public repositories    | Supported                                                   | Supported                                                                                        | Not yet: private repositories only                           |
| Fixed cost while idle  | The cluster fee and any nodes kept running                  | Lambda and SQS per request                                                                       | About $86 a month on AWS, $74 on GCP, $111 on Azure          |

## How each one works

### Actions Runner Controller

ARC is a Kubernetes operator that GitHub maintains. You install it with Helm,
then create a runner scale set for a repository, org or enterprise. A listener
pod holds a long poll open to GitHub. When jobs queue, ARC creates runner
pods to take them and removes them after. Runners are containers, so each job
gets a fresh pod on a node that may also run other pods.

Jobs that need Docker need one of ARC's container modes. Docker-in-Docker
runs a Docker daemon in a privileged sidecar container. Kubernetes mode runs
each job's containers as separate pods and needs a persistent volume for the
job's work directory. ARC's README notes that the older autoscaling modes are
now legacy and maintained by the community only.

### terraform-aws-github-runner

This Terraform module, started at Philips and now maintained by the
community, builds an AWS serverless pipeline. GitHub sends a webhook when a
job queues. A Lambda function behind API Gateway checks it and puts it on an
SQS queue. A scale-up Lambda reads the queue and launches EC2 instances, spot
by default. A scale-down Lambda removes idle instances on a schedule.

Runners are EC2 instances from an AMI you choose or build, so they behave
like full VMs. By default they can be reused for more than one job. Turning
on `enable_ephemeral_runners` gives each job its own instance.

### backmesh

backmesh is a CLI. `backmesh install --org <org>` uses your signed-in `aws`,
`gcloud` or `az` CLI to create a control plane of two small, always-on VMs in
your account, and connects each cloud with a keyless role, so no cloud keys
are stored. A listener on the control plane long-polls GitHub for queued
jobs, so nothing needs an inbound port or a webhook.

For each job, backmesh starts a VM in the cheapest region with capacity and
deletes it when the job ends. A job moves to backmesh when its `runs-on`
changes, for example from `ubuntu-latest` to `backmesh-4`. Labels pick the
size and the cloud, and runners can be in other clouds than the control plane.

## Setup

| Step                | ARC                                               | terraform-aws-github-runner                                                    | backmesh                                                                                |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Prerequisites       | A Kubernetes cluster, Helm, a GitHub App or token | An AWS account, Terraform, a GitHub App with a webhook                         | An AWS, GCP or Azure account with its CLI signed in; an org owner                       |
| Install             | Two Helm charts: the controller, then a scale set | Build or download the Lambda zips, write a Terraform config, `terraform apply` | `curl -fsSL https://backmesh.com/install.sh \| sh`, then `backmesh install --org <org>` |
| GitHub side         | Register the app or token in a Kubernetes secret  | Create the GitHub App, point its webhook at the API Gateway URL                | An org owner installs the backmesh GitHub App during install                            |
| Change in workflows | `runs-on: <scale set name>`                       | `runs-on: [self-hosted, <labels>]`                                             | `runs-on: backmesh-4` (or another size)                                                 |

ARC is fastest to set up for a team that already runs Kubernetes and has Helm
pipelines. The Terraform module fits a team that already manages AWS with
Terraform and wants every resource in its own state. backmesh fits a team that
wants runners without either, or is on GCP or Azure.

## Isolation and security

All three can give each job a clean environment, but the boundary differs:

- ARC gives each job a new pod. Pods share a node's kernel with other pods,
  and Docker-in-Docker needs a privileged container, which weakens that
  boundary.
- terraform-aws-github-runner gives each job a full EC2 instance when
  ephemeral runners are on. With them off, a runner can take a later job on
  the same instance, so files and processes from one job can be seen by the
  next.
- backmesh gives each job its own VM, deleted when the job ends, and jobs use
  the VM's own Docker without privileged mode.

None of the three makes it safe to run untrusted pull requests from forks on
runners that can reach your network. GitHub's own guidance is to avoid
self-hosted runners on public repositories for that reason. backmesh supports
only private repositories for now. Its [security model](/security/) also notes
that jobs from every repository in an org share the same labels, so any repo
in the org can use the runners; per-repository isolation is planned.

## Spot and interruptions

Spot capacity costs far less than on demand, and the cloud can take it back.
The three handle that differently:

- ARC uses whatever nodes the cluster has. Spot comes from spot node pools or
  a node autoscaler such as Karpenter. A reclaimed node fails the jobs on it.
- terraform-aws-github-runner launches spot instances by default and can fall
  back to on demand. A reclaimed instance fails its job.
- backmesh runs spot by default. If spot reclaims were a run's only failures,
  it reruns those jobs on demand, up to twice. Jobs that shouldn't be
  interrupted use `backmesh-od-*` labels.

## Caching

GitHub's cache for Actions holds 10 GB per repository. With self-hosted
runners, restoring it means downloading from GitHub on every job.

- ARC and the Terraform module use GitHub's cache unless you add your own,
  for example a cache in S3 or a persistent volume.
- backmesh adds a cache bucket in your own account, in the runner's region.
  `backmesh/cache` takes the same inputs as `actions/cache`, and `setup-*`
  tools and npm, Yarn and pnpm downloads are cached automatically. Each job
  still starts with an empty Docker layer cache.

## Start times

A job on an autoscaled runner waits for capacity:

- ARC waits for a pod to schedule. On a node with room, that's seconds. If the
  cluster has to add a node, it's the node's boot time first.
- terraform-aws-github-runner waits for an EC2 instance to boot and register.
  A warm pool of idle instances, an option in the module, removes most of
  that wait at the cost of paying for idle instances.
- backmesh waits for a VM to boot: about 30 seconds on AWS and 60 to 70
  seconds on GCP and Azure. It learns each workflow's shape and starts runners
  ahead of predicted jobs, and a coding agent can run `backmesh cue` before it
  pushes so the VMs boot early.

## Upkeep

| Task         | ARC                                        | terraform-aws-github-runner                          | backmesh                                                         |
| ------------ | ------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------- |
| Upgrades     | Helm chart upgrades, plus cluster upgrades | Module version bumps, Lambda zips, `terraform apply` | `backmesh upgrade`                                               |
| Runner image | A container image you build or pick        | An AMI you build or pick                             | backmesh's [image](/runner-image/), Ubuntu 24.04, or your own    |
| Status       | Kubernetes tools and ARC's metrics         | CloudWatch logs and metrics                          | `backmesh status`: runners, queue, job times, month-to-date cost |
| Removal      | Uninstall the charts                       | `terraform destroy`                                  | `backmesh uninstall`                                             |

## What it costs

All three are free software. The bill is the runners' compute plus a fixed
part that differs:

| Fixed part    | ARC                                                                                                                                                                                       | terraform-aws-github-runner   | backmesh                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------- |
| What it is    | A Kubernetes cluster: [EKS](https://aws.amazon.com/eks/pricing/) and [GKE](https://cloud.google.com/kubernetes-engine/pricing) charge $0.10 per cluster per hour, plus nodes kept running | Lambda calls and SQS messages | Two small always-on VMs with their disks |
| About a month | $73 for the EKS or GKE fee, before nodes                                                                                                                                                  | Usually a few dollars         | $86 on AWS, $74 on GCP, $111 on Azure    |

A worked month: 150,000 minutes of 4-vCPU Linux jobs on AWS spot. backmesh's
[cost inputs](/cost/) put 4-vCPU spot VMs in us-east-2 at about $0.050 to
$0.070 an hour on 2026-11-13, or about $124 to $175 for those minutes. All
three tools would pay roughly that for the compute itself, since all three can
run spot. The fixed part then decides the total:

| On AWS, 150,000 4-vCPU minutes | Compute   | Fixed               | Total, about      |
| ------------------------------ | --------- | ------------------- | ----------------- |
| GitHub-hosted 4-core           | $1,800    | none                | $1,800            |
| ARC on EKS                     | $124–$175 | $73 + nodes for ARC | $197–$248 + nodes |
| terraform-aws-github-runner    | $124–$175 | a few dollars       | $130–$180         |
| backmesh                       | $124–$175 | $86                 | $210–$261         |

These leave out disks, boot time and engineering time. For ARC, the nodes that
run ARC's controller and listener, and any spare capacity for pods to land on,
add to the fixed part. For the Terraform module, the main cost is the time to
build and keep the pipeline and AMIs current. To try your own numbers on AWS,
GCP and Azure, use the [cost calculator](/calculator/).

## Which to pick

Pick ARC if you already run Kubernetes and have people who look after it. It's
GitHub's own reference for runner scale sets, it runs on any cloud with
Kubernetes, and it supports public repositories.

Pick terraform-aws-github-runner if you're on AWS only, already manage AWS with
Terraform, need Windows or arm64 runners, or want the lowest fixed cost and
are fine owning the pipeline.

Pick backmesh if you want a fresh spot VM for every job without running a
cluster or a Terraform pipeline, if you're on GCP or Azure, or if you want
one install across several clouds. It's the newest of the three, and it
supports only Linux x86-64 jobs in private repositories.

## Paid tools that also run in your cloud

Some paid tools also run runners in your own account. Per their pricing pages
on 2026-11-18: [RunsOn](https://runs-on.com/pricing/) is AWS only, with a
yearly license from €300 for commercial use and free for non-commercial use.
[WarpBuild BYOC](https://www.warpbuild.com/pricing) charges $0.002 per runner
minute plus your cloud bill, on AWS, GCP and Azure.
[Cirun](https://cirun.io/pricing) starts at $29 a month by number of private
repositories.

## Moving between them

All three take jobs by `runs-on` label, so you can move one workflow at a time
and run two side by side. A typical path from ARC or the Terraform module to
backmesh: install backmesh for the org, change one workflow's `runs-on` to a
backmesh label, compare its run times and cost in `backmesh status`, then move
the rest. [Coming from ubuntu-latest](/from-ubuntu-latest/) lists what jobs
may notice on backmesh's image, such as no systemd.

## Questions

**What are the open-source alternatives to GitHub-hosted runners?** ARC
(Apache-2.0, on Kubernetes), terraform-aws-github-runner (MIT, on AWS) and
backmesh (Apache-2.0, on AWS, GCP or Azure).

**Is there an ARC alternative without Kubernetes?** Yes.
terraform-aws-github-runner on AWS, and backmesh on AWS, GCP or Azure.

**Which works on GCP and Azure?** ARC, on GKE or AKS. backmesh, with VMs in
your project or subscription. terraform-aws-github-runner is AWS only.

**Which is cheapest to run?** All three are free; the fixed part differs. The
Terraform module scales to zero and costs a few dollars a month in Lambda and
SQS. backmesh's control plane costs about $74 to $111. ARC's cost is a
cluster, about $73 a month in fees on EKS or GKE before nodes.

**Does terraform-aws-github-runner use ephemeral runners?** Only if you turn
on `enable_ephemeral_runners`; it defaults to `false`.

**Can I run Windows or macOS jobs?** Windows: terraform-aws-github-runner.
macOS: none of the three is built for it. backmesh is Linux x86-64 only.

**Which handles spot reclaims best?** backmesh reruns jobs that failed only
because of a reclaim, on demand, up to twice. ARC and the Terraform module
fail the job and leave the retry to you.

**Can I move from ARC one workflow at a time?** Yes. Change one workflow's
`runs-on` to a backmesh label and the rest stay on ARC.
