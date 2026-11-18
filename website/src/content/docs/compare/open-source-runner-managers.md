---
title: 'Open-source GitHub Actions runner managers: backmesh, ARC and terraform-aws-github-runner'
description: Three free, open-source ways to run autoscaling self-hosted GitHub Actions runners, compared on clouds, what you operate, isolation, spot and cost.
lastUpdated: 2026-11-18
sidebar:
  label: Open-source runner managers
head:
  - tag: title
    content: 'Open-source GitHub Actions runner managers compared: backmesh vs ARC vs terraform-aws-github-runner | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What are the open-source alternatives to GitHub-hosted runners?","acceptedAnswer":{"@type":"Answer","text":"Three free, open-source runner managers autoscale self-hosted GitHub Actions runners: Actions Runner Controller (ARC, Apache-2.0, on Kubernetes), terraform-aws-github-runner (MIT, on AWS with Lambda and EC2) and backmesh (Apache-2.0, a VM per job on AWS, GCP or Azure)."}},{"@type":"Question","name":"Is there an alternative to Actions Runner Controller without Kubernetes?","acceptedAnswer":{"@type":"Answer","text":"Yes. terraform-aws-github-runner runs runners on EC2 through Lambda functions on AWS, and backmesh runs each job on its own spot VM in AWS, GCP or Azure from one CLI install. Neither needs a Kubernetes cluster."}},{"@type":"Question","name":"Which open-source runner manager works on GCP and Azure?","acceptedAnswer":{"@type":"Answer","text":"ARC runs on any Kubernetes cluster, including GKE and AKS. backmesh runs VMs directly in GCP and Azure accounts as well as AWS. terraform-aws-github-runner is AWS only."}}]}'
---

All three are free and open source, and in all three your cloud bills you for
the runners. They differ in what you operate: a Kubernetes cluster for ARC,
Terraform and Lambda functions on AWS for terraform-aws-github-runner, and two
small VMs per installation for backmesh.

Figures were checked on 2026-11-18 against each project's repository.

## At a glance

|                       | [ARC](https://github.com/actions/actions-runner-controller) | [terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner) | [backmesh](https://github.com/backmesh/backmesh)             |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| License               | Apache-2.0                                                  | MIT                                                                                              | Apache-2.0                                                   |
| Maintained by         | GitHub                                                      | Community (formerly philips-labs)                                                                | backmesh                                                     |
| Latest release        | gha-runner-scale-set 0.15.1, 2026-10-23                     | v8.1.1, 2026-11-12                                                                               | v0.4.1, 2026-11-18                                           |
| GitHub stars          | 6,674                                                       | 3,183                                                                                            | New                                                          |
| Where runners run     | Pods on any Kubernetes cluster                              | EC2 on AWS                                                                                       | VMs on AWS, GCP or Azure                                     |
| What you operate      | The cluster, its node pools and ARC's Helm charts           | Terraform, Lambda functions, an SQS queue and the GitHub App webhook                             | The `backmesh` CLI; it creates two small VMs in your account |
| One runner per job    | Yes, ephemeral pods                                         | Optional: `enable_ephemeral_runners` defaults to `false`                                         | Yes: each job gets its own VM, deleted when it ends          |
| Spot                  | Through spot node pools you set up                          | Yes: `instance_target_capacity_type` defaults to `spot`                                          | Yes, by default; `backmesh-od-*` labels run on demand        |
| Operating systems     | Mostly Linux containers, on your nodes                      | Linux, Windows; x64 and arm64                                                                    | Linux x86-64 only                                            |
| Public repositories   | Yes                                                         | Yes                                                                                              | No, private repositories only                                |
| Fixed cost while idle | The cluster's control plane and any always-on nodes         | Lambda and SQS, usually small                                                                    | About $86/month on AWS, $74 on GCP, $111 on Azure            |

## Which to pick

Pick ARC if you already run Kubernetes and want runners as pods next to your
other workloads. It's GitHub's own reference for runner scale sets.

Pick terraform-aws-github-runner if you're on AWS only, already manage
infrastructure with Terraform, and need Windows or arm64 runners.

Pick backmesh if you want ephemeral spot VMs without running a cluster or
Terraform, or you're on GCP or Azure. Each job gets a fresh VM, so there's no
state left between jobs. backmesh is the newest of the three, and it supports
only Linux x86-64 jobs in private repositories.

## What each one costs to run

All three are free software, and the runners bill as cloud VMs or nodes. The
difference is the fixed part:

- ARC needs a cluster. On a managed service such as EKS, GKE or AKS, the
  control plane has its own hourly fee, plus any nodes kept running.
- terraform-aws-github-runner scales to zero runners. Its Lambda functions and
  queue bill per call.
- backmesh keeps two small always-on VMs, the listener and the management VM,
  at about $74–$111 a month depending on the cloud. Runners have no VM while
  idle.

For a full month at 150,000 minutes of 4-vCPU jobs, see the
[cost comparison](/cost/), or enter your own numbers in the
[cost calculator](/calculator/).

## Paid tools that also run in your cloud

For completeness, these also run runners in your account but charge for the
software, per their pricing pages on 2026-11-18:
[RunsOn](https://runs-on.com/pricing/) (AWS only, a yearly license from €300
for commercial use, free for non-commercial use),
[WarpBuild BYOC](https://www.warpbuild.com/pricing) ($0.002 per runner minute
plus your cloud bill, on AWS, GCP and Azure) and [Cirun](https://cirun.io/pricing)
(from $29 a month by number of private repositories).

## Questions

**Is there an ARC alternative without Kubernetes?** Yes:
terraform-aws-github-runner on AWS, and backmesh on AWS, GCP or Azure.

**Which works on GCP and Azure?** ARC, on GKE or AKS. backmesh, with VMs
directly in your project or subscription. terraform-aws-github-runner is AWS
only.

**Can I move from ARC to backmesh one workflow at a time?** Yes. A job moves
when its `runs-on` changes to a backmesh label, such as `backmesh-4`, so ARC
and backmesh can run side by side. See
[Coming from ubuntu-latest](/from-ubuntu-latest/) for the differences jobs may
notice.
