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

| Label                         | vCPU | Memory | Types, in order                                               |
| ----------------------------- | ---- | ------ | ------------------------------------------------------------- |
| `backmesh-ubuntu-2404-2vcpu`  | 2    | 8 GiB  | `Standard_D2ads_v5`, `Standard_D2as_v5`, `Standard_D2s_v5`    |
| `backmesh-ubuntu-2404-4vcpu`  | 4    | 16 GiB | `Standard_D4ads_v5`, `Standard_D4as_v5`, `Standard_D4s_v5`    |
| `backmesh-ubuntu-2404-8vcpu`  | 8    | 32 GiB | `Standard_D8ads_v5`, `Standard_D8as_v5`, `Standard_D8s_v5`    |
| `backmesh-ubuntu-2404-16vcpu` | 16   | 64 GiB | `Standard_D16ads_v5`, `Standard_D16as_v5`, `Standard_D16s_v5` |

The [KVM labels](/labels/#kvm) use `as_v5` and `s_v5` only, since `ads_v5`
doesn't nest. When Azure is the control plane's cloud, its labels are plain,
as above, and its [GPU labels](/labels/#gpu) are `backmesh-ubuntu-2404-gpu-t4`, on spot,
and `backmesh-ubuntu-2404-gpu-od-t4`, on demand; otherwise they name it, such as
`backmesh-azure-ubuntu-2404-4vcpu`. Install prints the labels it made.

The [high-memory labels](/labels/#high-memory) use the E-series twins,
`Standard_E<n>ads_v5`, `Standard_E<n>as_v5` then `Standard_E<n>s_v5`, 8 GiB a
vCPU: `backmesh-ubuntu-2404-highmem-16vcpu` is 16 vCPUs and 128 GiB. Their
spot VMs count against "Total Regional Low-priority vCPUs" with the others.

## Regions

Runners use a fixed list of US regions, or with `--runner-geo eu` of the EU
member states' ones, not discovered through your cloud CLI or chosen on the
command line: every one whose catalog offers every type above — every US and
EU region qualifies — narrowed to the ones your account allows.
Each job tries the cheapest region first, then another when Azure refuses for
capacity or quota. [More](/install/#regions).

## The control plane's region

Install creates two always-on VMs: the control plane's, when it's new, and
the org's listener's, when it has none yet. Some Azure offers, such as
sponsorship and trial ones, refuse a size in a region
(`NotAvailableForSubscription`), and some refuse `Standard_B2s` in every
region, so each VM takes the first of its sizes that your subscription may
create in the region:

| VM            | vCPU | Sizes, in order                                                                                                                                                        |
| ------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control plane | 2    | `Standard_D2s_v5`, `Standard_D2as_v5`, `Standard_D2s_v4`: 8 GiB                                                                                                        |
| Listener      | 2    | `Standard_B2s`, `Standard_B2als_v2`, `Standard_B2ls_v2`: 4 GiB; `Standard_B2as_v2`, `Standard_B2s_v2`, `Standard_D2as_v5`, `Standard_D2s_v5`, `Standard_D2s_v4`: 8 GiB |

Before any sign-in, the plan reads `az vm list-skus` for those sizes, and
prints the size each VM takes and its price. A region that offers one of them
none of its sizes is passed over: the plan says so and puts both VMs in the
first of the regions above that offers each a size, such as `centralus`. With
`--control-plane azure:<region>` outside them, the plan reads that region's
sizes alone, which is quicker. For a new control plane, it also lists the
regions after it: if Azure has no capacity for the control plane's VM when
install creates it, install deletes that cluster's resource group and
checkpoint bucket and tries the next, at its size there, without signing in
again. The `anycloud-storage` resource group and storage account that your
subscription's first control plane made stay, as other control planes use
them. A control plane named `backmesh` that already exists in the
subscription is resumed in its own region, once this machine uses it or
`--control-plane-id` names it
([More](/install/#a-control-plane-that-already-exists)). A listener VM keeps
its size: when `backmesh upgrade` replaces a lost one, the new VM takes the
old one's.

## What install creates

Install works through your `az` CLI, signed in with a subscription, and
creates:

- **A role connection:** a custom role, a resource group with a managed
  identity and its federated credential, and a role assignment. The identity
  trusts only your control plane, so no Azure keys are stored.
- **Cache buckets**, through that connection: one per runner region,
  `bm-cache-<id>-<region>`, for the [cache](/cache/).
- **The control plane**, when Azure is its cloud: a `Standard_D2s_v5` VM, or
  the size above its region offers, with its disk and public address, and a
  checkpoint bucket for its backups; and each org's listener on its own
  `Standard_B2s` VM, or the size above its region offers, with its disk and
  public address.

[Uninstall](/uninstall/) deletes the VMs and buckets. It asks before deleting
the checkpoint bucket, and leaves the role connection's setup for you to
delete in the console.

## Quotas

Spot labels count against each region's "Total Regional Low-priority vCPUs"
quota, and on-demand labels against "Total Regional vCPUs". Install reads both
through `az vm list-usage` and prints them as how many `backmesh-ubuntu-2404-4vcpu` jobs fit at
once, counting each region on its own: 3 spot vCPUs in every region run no
`backmesh-ubuntu-2404-4vcpu` job, only `backmesh-ubuntu-2404-2vcpu`. A region whose quota can't fit one VM of a
label gets none of that label's runners until you raise it; install and
[`backmesh status`](/status/) name the quota. The spot GPU label,
`backmesh-ubuntu-2404-gpu-t4`, counts against the spot vCPUs with the others; the
on-demand one, `backmesh-ubuntu-2404-gpu-od-t4`, also counts against "Standard NCASv3_T4
Family vCPUs", 0 on most new subscriptions; request at least 4 under
[Quotas](https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/myQuotas)
in the portal. The always-on VMs count against their size's family quota too,
such as "Standard DSv5 Family vCPUs" and "Standard BS Family vCPUs", or
"Standard BASv2 Family vCPUs" for `Standard_B2als_v2`, the listener's size on
a subscription refused `Standard_B2s`. The plan checks them before any
sign-in, and takes a VM's next size when its family has no room. [More](/faq/#installing).

## Cost

These are catalog prices in `westus2`, spot in the lowest zone, for a
`backmesh-ubuntu-2404-4vcpu` VM while its job runs:

| Type                | Spot $/h | On demand $/h |
| ------------------- | -------- | ------------- |
| `Standard_D4ads_v5` | 0.0381   | 0.206         |
| `Standard_D4as_v5`  | 0.0318   | 0.172         |
| `Standard_D4s_v5`   | 0.0355   | 0.192         |

Other sizes scale with their vCPUs. Each job also pays for its VM's boot and its
100 GB disk. The always-on VMs cost about $111 a month: $79 for the control
plane's VM and $32 for each org's listener VM, with their disks and addresses,
at their first sizes. Another size costs, in `westus2` on 2026-11-21: $72 for
`Standard_D2as_v5` and $79 for `Standard_D2s_v4`; for the listener, $29 for
`Standard_B2als_v2`, $32 for `Standard_B2ls_v2`, $57 for `Standard_B2as_v2`,
$63 for `Standard_B2s_v2`, $65 for `Standard_D2as_v5` and $72 for
`Standard_D2s_v5` or `Standard_D2s_v4`. The plan prints the sizes and prices
it picks.
At those prices, 150,000 minutes a month of `backmesh-ubuntu-2404-4vcpu` jobs cost at least
$191–$206 with one org's always-on VMs, before disks, boots and runners started ahead of
jobs; see [the
costs](/#cost). Spot prices change by the hour.
