---
title: GitHub Actions runners on AWS
description: How backmesh runs GitHub Actions jobs on EC2 spot VMs in your AWS account, what install creates there, the quotas to check and what it costs.
sidebar:
  label: AWS
---

backmesh runs each GitHub Actions job on its own EC2 VM in your AWS account,
spot unless the label says [on demand](/labels/#on-demand) or the job reruns
after a spot reclaim. The VM is deleted when the job ends, and AWS bills you for
it.

## VM types

A job's VM is the first type in its [label's](/labels/) list that has capacity:

| Label         | vCPU | Memory | Types, in order                                            |
| ------------- | ---- | ------ | ---------------------------------------------------------- |
| `backmesh-2`  | 2    | 8 GiB  | `m8i.large`, `m7a.large`, `m7i.large`, `m6a.large`         |
| `backmesh-4`  | 4    | 16 GiB | `m8i.xlarge`, `m7a.xlarge`, `m7i.xlarge`, `m6a.xlarge`     |
| `backmesh-8`  | 8    | 32 GiB | `m8i.2xlarge`, `m7a.2xlarge`, `m7i.2xlarge`, `m6a.2xlarge` |
| `backmesh-16` | 16   | 64 GiB | `m8i.4xlarge`, `m7a.4xlarge`, `m7i.4xlarge`, `m6a.4xlarge` |

The [KVM labels](/labels/#kvm) use `m8i`, then `m7i` (`m7a` and `m6a` don't
nest). When AWS is the control plane's cloud, its labels are plain, as above;
otherwise they name it, such as `backmesh-aws-4`.

## Regions

Runners use a fixed list of US regions, not discovered through your cloud CLI
or chosen on the command line: every one whose catalog offers every type
above, which leaves out `us-west-1` (no `m7a`), narrowed to the ones your
account allows. Each job tries the cheapest region first, then another when
AWS refuses for capacity or quota. [More](/install/#regions).

## What install creates

Install works through your signed-in `aws` CLI, and creates:

- **A role connection:** a CloudFormation stack with an IAM role and an OIDC
  provider, in the control plane's region, or `us-east-1` when the control plane is
  on another cloud, unless `AWS_REGION` is set. The role trusts only your control plane, so no AWS keys are stored.
- **Cache buckets**, through that connection: one per runner region,
  `bm-cache-<id>-<region>`, for the [cache](/cache/).
- **The control plane**, when AWS is its cloud: a `t3.large` VM and a
  `t3.small` VM for the listener, with their disks and public addresses, and a
  checkpoint bucket for its backups.

[Uninstall](/uninstall/) deletes the VMs and buckets. It asks before deleting
the checkpoint bucket, and leaves the role connection's setup for you to
delete in the console.

## Quotas

Spot labels count against EC2's "All Standard (A, C, D, H, I, M, R, T, Z) Spot
Instance Requests" quota (`L-34B43A08`), and on-demand labels against "Running
On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances" (`L-1216C47A`), in
vCPUs per region. Install reads both through `aws service-quotas` and prints
them as how many `backmesh-4` jobs fit at once. A region whose quota is at AWS's
default 5 vCPUs gets no `backmesh-8` or `backmesh-16` runners until you raise
it; install and [`backmesh status`](/status/) name the quota.
[More](/faq/#installing).

## Cost

These are catalog prices in `us-east-2`, spot in the lowest zone, for a
`backmesh-4` VM while its job runs:

| Type         | Spot $/h | On demand $/h |
| ------------ | -------- | ------------- |
| `m8i.xlarge` | 0.0583   | 0.2117        |
| `m7a.xlarge` | 0.07     | 0.2318        |
| `m7i.xlarge` | 0.0497   | 0.2016        |
| `m6a.xlarge` | 0.0547   | 0.1728        |

Other sizes scale with their vCPUs. Each job also pays for its VM's boot and its
100 GB disk, about $0.01 an hour. The control plane costs about $86 a month. At
those prices, 150,000 minutes a month of `backmesh-4` jobs cost at least
$210–$261 with the control plane, before disks, boots and runners started ahead
of jobs; see [the costs](/#cost). Spot prices change by the hour.
