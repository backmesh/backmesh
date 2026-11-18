---
title: GitHub Actions runners on Azure
description: How backmesh runs GitHub Actions jobs on spot VMs in your Azure subscription, what install creates there, the quotas to check and what it costs.
sidebar:
  label: Azure
---

backmesh runs each GitHub Actions job on its own VM in your Azure subscription,
spot unless the label says [on demand](/labels/#on-demand) or the job reruns
after a spot reclaim. The VM is deleted when the job ends, and Azure bills you
for it.

## VM types

A job's VM is the first type in its [label's](/labels/) list that has capacity:

| Label         | vCPU | Memory | Types, in order                                               |
| ------------- | ---- | ------ | ------------------------------------------------------------- |
| `backmesh-2`  | 2    | 8 GiB  | `Standard_D2ads_v5`, `Standard_D2as_v5`, `Standard_D2s_v5`    |
| `backmesh-4`  | 4    | 16 GiB | `Standard_D4ads_v5`, `Standard_D4as_v5`, `Standard_D4s_v5`    |
| `backmesh-8`  | 8    | 32 GiB | `Standard_D8ads_v5`, `Standard_D8as_v5`, `Standard_D8s_v5`    |
| `backmesh-16` | 16   | 64 GiB | `Standard_D16ads_v5`, `Standard_D16as_v5`, `Standard_D16s_v5` |

The [KVM labels](/labels/#kvm) use `as_v5` and `s_v5` only, since `ads_v5`
doesn't nest. When Azure is the control plane's cloud, its labels are plain,
as above; otherwise they name it, such as `backmesh-azure-4`.

## Regions

Runners use a fixed list of US regions, not discovered through your cloud CLI
or chosen on the command line: every one whose catalog offers every type
above — every US region qualifies — narrowed to the ones your account allows.
Each job tries the cheapest region first, then another when Azure refuses for
capacity or quota. [More](/install/#regions).

## What install creates

Install works through your `az` CLI, signed in with a subscription, and
creates:

- **A role connection:** a custom role, a resource group with a managed
  identity and its federated credential, and a role assignment. The identity
  trusts only your control plane, so no Azure keys are stored.
- **Cache buckets**, through that connection: one per runner region,
  `bm-cache-<id>-<region>`, for the [cache](/cache/).
- **The control plane**, when Azure is its cloud: a `Standard_D2s_v5` VM and a
  `Standard_B2s` VM for the listener, with their disks and public addresses,
  and a checkpoint bucket for its backups.

[Uninstall](/uninstall/) deletes the VMs and buckets. It asks before deleting
the checkpoint bucket, and leaves the role connection's setup for you to
delete in the console.

## Quotas

Spot labels count against each region's "Total Regional Low-priority vCPUs"
quota, and on-demand labels against "Total Regional vCPUs". Install reads both
through `az vm list-usage` and prints them as how many `backmesh-4` jobs fit at
once. A region whose quota can't fit one VM of a label gets none of that
label's runners until you raise it; install and
[`backmesh status`](/status/) name the quota. The on-demand
[GPU label](/labels/#gpu) also counts against "Standard NCASv3_T4 Family
vCPUs", 0 on most new subscriptions; request at least 4 under
[Quotas](https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/myQuotas)
in the portal. [More](/faq/#installing).

## Cost

These are catalog prices in `westus2`, spot in the lowest zone, for a
`backmesh-4` VM while its job runs:

| Type                | Spot $/h | On demand $/h |
| ------------------- | -------- | ------------- |
| `Standard_D4ads_v5` | 0.0381   | 0.206         |
| `Standard_D4as_v5`  | 0.0318   | 0.172         |
| `Standard_D4s_v5`   | 0.0355   | 0.192         |

Other sizes scale with their vCPUs. Each job also pays for its VM's boot and its
100 GB disk. The control plane costs about $111 a month. At those prices,
150,000 minutes a month of `backmesh-4` jobs cost at least $191–$206 with the
control plane, before disks, boots and runners started ahead of jobs; see [the
costs](/#cost). Spot prices change by the hour.
