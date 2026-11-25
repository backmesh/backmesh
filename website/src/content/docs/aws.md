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

| Label                         | vCPU | Memory | Types, in order                                                           |
| ----------------------------- | ---- | ------ | ------------------------------------------------------------------------- |
| `backmesh-ubuntu-2404-2vcpu`  | 2    | 8 GiB  | `m8a.large`, `m8i.large`, `m7a.large`, `m7i.large`, `m6a.large`           |
| `backmesh-ubuntu-2404-4vcpu`  | 4    | 16 GiB | `m8a.xlarge`, `m8i.xlarge`, `m7a.xlarge`, `m7i.xlarge`, `m6a.xlarge`      |
| `backmesh-ubuntu-2404-8vcpu`  | 8    | 32 GiB | `m8a.2xlarge`, `m8i.2xlarge`, `m7a.2xlarge`, `m7i.2xlarge`, `m6a.2xlarge` |
| `backmesh-ubuntu-2404-16vcpu` | 16   | 64 GiB | `m8a.4xlarge`, `m8i.4xlarge`, `m7a.4xlarge`, `m7i.4xlarge`, `m6a.4xlarge` |

The on-demand labels, such as `backmesh-ubuntu-2404-od-4vcpu`, use the same types. `m8a` goes
first because it ran backmesh's builds in 0.64–0.88 times `m8i`'s time,
typically about 1.3 times as fast. When a zone has no spot `m8a`, the job moves
on to the next zone or type within seconds. The [KVM labels](/labels/#kvm) use `m8i`, then `m7i` (`m8a`, `m7a` and
`m6a` don't nest). The [GPU labels](/labels/#gpu) use `g4dn.xlarge` (one T4, 4 vCPUs and
16 GiB), then `g4dn.2xlarge` (the same T4, 8 vCPUs and 32 GiB). The
[arm64 labels](/labels/#arm64), `backmesh-ubuntu-2404-arm-2vcpu` to `backmesh-ubuntu-2404-arm-16vcpu` and their
on-demand twins, use Graviton's `m8g`, then `m7g`, at the same sizes:
`m8g.xlarge` and `m7g.xlarge` for `backmesh-ubuntu-2404-arm-4vcpu`; the arm64 high-memory
ones, `backmesh-ubuntu-2404-arm-highmem-<n>vcpu`, use `r8g`, then `r7g`. When AWS is the control plane's cloud, its labels are plain, as above;
otherwise they name it, such as `backmesh-aws-ubuntu-2404-4vcpu`.

The [high-memory labels](/labels/#high-memory) use the same sizes with 8 GiB a
vCPU, on `r8a`, `r8i`, `r7a`, `r7i` then `r6a`: `backmesh-ubuntu-2404-highmem-16vcpu`
is `r8a.4xlarge` first, 16 vCPUs and 128 GiB. They count against the same
Standard vCPU quotas.

## Regions

Runners use a fixed list of US regions, or with `--runner-geo eu` of EU ones,
not discovered through your cloud CLI or chosen on the command line: every one
whose catalog offers every type above and below, which leaves out `us-west-1`
(no `m7a` or `m8a`), and in the EU keeps `eu-central-1` and `eu-west-1`,
narrowed to the ones your account allows. Each job tries the cheapest region first, then another when
AWS refuses for capacity or quota. [More](/install/#regions).

## What install creates

Install works through your signed-in `aws` CLI, and creates:

- **A role connection:** a CloudFormation stack with an IAM role and an OIDC
  provider, in the control plane's region, or `us-east-1` when the control plane is
  on another cloud, unless `AWS_REGION` is set. The role trusts only your control plane, so no AWS keys are stored.
- **Cache buckets**, through that connection: one per runner region,
  `bm-cache-<id>-<region>`, for the [cache](/cache/).
- **The control plane**, when AWS is its cloud: a `t3.large` VM, with its disk
  and public address, and a checkpoint bucket for its backups; and each org's
  listener on its own `t3.small` VM, with its disk and public address.

[Uninstall](/uninstall/) deletes the VMs and buckets. It asks before deleting
the checkpoint bucket, and leaves the role connection's setup for you to
delete in the console.

## Quotas

Spot labels count against EC2's "All Standard (A, C, D, H, I, M, R, T, Z) Spot
Instance Requests" quota (`L-34B43A08`), and on-demand labels against "Running
On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances" (`L-1216C47A`), in
vCPUs per region, the arm64 labels' Graviton VMs with the rest. Install reads both through `aws service-quotas` and prints
them as how many `backmesh-ubuntu-2404-4vcpu` jobs fit at once. A region whose quota is at AWS's
default 5 vCPUs gets no `backmesh-ubuntu-2404-8vcpu` or `backmesh-ubuntu-2404-16vcpu` runners until you raise
it; install and [`backmesh status`](/status/) name the quota. The GPU labels
count against "All G and VT Spot Instance Requests" (`L-3819A6DF`) and
"Running On-Demand G and VT instances" (`L-DB2E81BA`) instead, 0 on most new
accounts: request at least 4 vCPUs per region in the
[Service Quotas console](https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas).
[More](/faq/#installing).

## Cost

These are catalog prices in `us-east-2`, spot in the lowest zone, for a
`backmesh-ubuntu-2404-4vcpu` VM while its job runs:

| Type         | Spot $/h | On demand $/h |
| ------------ | -------- | ------------- |
| `m8a.xlarge` | 0.065    | 0.2434        |
| `m8i.xlarge` | 0.0583   | 0.2117        |
| `m7a.xlarge` | 0.07     | 0.2318        |
| `m7i.xlarge` | 0.0497   | 0.2016        |
| `m6a.xlarge` | 0.0547   | 0.1728        |
| `m8g.xlarge` | 0.0534   | 0.1795        |
| `m7g.xlarge` | 0.0608   | 0.1632        |

`m8a`'s prices are from the catalog on 2026-11-23, when `m8i.xlarge`'s spot
price was 0.0649. On spot, `m8a.xlarge` then cost about the same an hour as
`m8i.xlarge`, so a `backmesh-ubuntu-2404-4vcpu` job that finishes sooner costs less;
`m8a.4xlarge` cost about 27 % more than `m8i.4xlarge`, about even a job. On
demand `m8a` costs 15 % more an hour than `m8i`, so a job costs about 9 % less at
`backmesh-ubuntu-2404-od-4vcpu` and about the same at `backmesh-ubuntu-2404-od-16vcpu`.

The arm64 labels' `m8g` and `m7g` are from the catalog on 2026-11-24. On
demand, `m8g` costs 0.85 of `m8i` an hour.

Other sizes scale with their vCPUs. Each job also pays for its VM's boot and its
100 GB gp3 disk at 4,000 IOPS and 500 MiB/s, about $0.038 an hour. The
control plane and one org's listener VM cost about $86 a month. At
those prices, 150,000 minutes a month of `backmesh-ubuntu-2404-4vcpu` jobs cost at least
$210–$261 with one org's always-on VMs, before disks, boots and runners started ahead
of jobs; see [the costs](/#cost). Spot prices change by the hour.
