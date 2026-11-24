---
title: Getting T4 GPU quota on AWS and Azure for CI
description: New AWS accounts and Azure subscriptions usually can't start a single T4 VM. The exact quota names to request for g4dn and NC4as_T4_v3 runners, spot and on demand, how many vCPUs to ask for, and how to check them.
date: 2026-11-24
lastUpdated: 2026-11-24
authors: backmesh
tags:
  - GPU
excerpt: GPU quota is 0 on most new cloud accounts, so a GPU job waits forever. Which quota to raise on AWS (G and VT) and Azure (low-priority and NCASv3_T4), in which regions, and how many vCPUs a CI runner needs.
head:
  - tag: title
    content: 'T4 GPU quota on AWS and Azure for GitHub Actions runners | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"Getting T4 GPU quota on AWS and Azure for CI","datePublished":"2026-11-24","dateModified":"2026-11-24","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/t4-gpu-quota-aws-azure/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Which AWS quota covers g4dn instances?","acceptedAnswer":{"@type":"Answer","text":"Spot g4dn instances count against \"All G and VT Spot Instance Requests\" (L-3819A6DF), on-demand ones against \"Running On-Demand G and VT instances\" (L-DB2E81BA). Both are in vCPUs per region."}},{"@type":"Question","name":"Which Azure quota covers Standard_NC4as_T4_v3?","acceptedAnswer":{"@type":"Answer","text":"On demand, \"Standard NCASv3_T4 Family vCPUs\" and \"Total Regional vCPUs\". Spot VMs count against \"Total Regional Low-priority vCPUs\" instead, shared with every other spot VM in the region."}},{"@type":"Question","name":"How many vCPUs of GPU quota does a CI runner need?","acceptedAnswer":{"@type":"Answer","text":"4 per T4 job running at once for g4dn.xlarge or Standard_NC4as_T4_v3. On AWS, backmesh falls back to g4dn.2xlarge, 8 vCPUs, when no g4dn.xlarge is free."}}]}]}'
---

A GPU job on your own cloud account needs GPU quota, and most new AWS
accounts and Azure subscriptions have none. Until it's raised, the cloud
refuses the VM and the job waits. Here are the quotas a T4 CI runner counts
against, how much to ask for, and where.

## How much to ask for

Both clouds count GPU quota in vCPUs, per region. One T4 runner, AWS's
`g4dn.xlarge` or Azure's `Standard_NC4as_T4_v3`, uses 4. Ask for 4 times the
GPU jobs you want running at once. On AWS, backmesh uses `g4dn.2xlarge`, the
same T4 with 8 vCPUs, when no `g4dn.xlarge` is free, so ask for 8 per job to
leave room for it.

Ask in each region your runners use. backmesh's `backmesh install --plan`
and [`backmesh status`](/status/) list the regions, print each GPU quota, and
name the one to raise.

## AWS

| Runner           | Quota                                | Code         |
| ---------------- | ------------------------------------ | ------------ |
| Spot `g4dn`      | All G and VT Spot Instance Requests  | `L-3819A6DF` |
| On-demand `g4dn` | Running On-Demand G and VT instances | `L-DB2E81BA` |

In the [Service Quotas console](https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas),
pick the region, search for "G and VT", open the quota and choose **Request
increase at account level**. Or with the AWS CLI, for example 16 vCPUs, room
for four `g4dn.xlarge` jobs or two `g4dn.2xlarge`, in `us-west-2`:

```sh
aws service-quotas request-service-quota-increase \
  --service-code ec2 --quota-code L-3819A6DF \
  --desired-value 16 --region us-west-2
```

Request the spot and on-demand quotas separately; a spot label
(`backmesh-ubuntu-2404-gpu-t4`) never falls back on demand, and the on-demand label
(`backmesh-ubuntu-2404-gpu-od-t4`) uses only the on-demand quota.

## Azure

| Runner                           | Quotas                                                    |
| -------------------------------- | --------------------------------------------------------- |
| Spot `Standard_NC4as_T4_v3`      | Total Regional Low-priority vCPUs                         |
| On-demand `Standard_NC4as_T4_v3` | Standard NCASv3_T4 Family vCPUs, and Total Regional vCPUs |

Spot VMs have no family quota on Azure: they count against "Total Regional
Low-priority vCPUs" with every other spot VM in the region, so a spot GPU
runner shares it with your CPU spot runners. Ask for enough for both. On
demand, a T4 VM needs room in both its family quota and the regional total.

In the portal, open
[Quotas → Compute](https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/myQuotas),
filter by region, search for "NCASv3_T4" or "Low-priority", select the
quota and request a new limit. To see where you stand:

```sh
az vm list-usage --location westus2 -o table
```

backmesh's Azure T4 runners use the regions that offer the type:
`eastus`, `centralus`, `eastus2`, `southcentralus`, `westus2` and `westus3`.

## After the increase

Once the quota is there, a waiting GPU job starts on its own; on AWS a cold
`backmesh-ubuntu-2404-gpu-t4` job took a median of about 2 minutes 10 seconds from
queued to started in our
[benchmark](https://github.com/backmesh/backmesh/tree/main/benchmarks/gpu-t4).
Quota is only permission: spot capacity can still run short, and then a spot
job waits for a T4 while an on-demand one doesn't.

The [GPU runners](/gpu/) page has the labels and prices;
[How to run CUDA and PyTorch tests in GitHub Actions](/blog/run-cuda-tests-github-actions/)
has a workflow to run on them.

## FAQ

**Which AWS quota covers g4dn instances?** Spot `g4dn` instances count against
"All G and VT Spot Instance Requests" (`L-3819A6DF`), on-demand ones against
"Running On-Demand G and VT instances" (`L-DB2E81BA`). Both are in vCPUs per
region.

**Which Azure quota covers Standard_NC4as_T4_v3?** On demand, "Standard
NCASv3_T4 Family vCPUs" and "Total Regional vCPUs". Spot VMs count against
"Total Regional Low-priority vCPUs" instead, shared with every other spot VM in
the region.

**How many vCPUs of GPU quota does a CI runner need?** 4 per T4 job running at
once for `g4dn.xlarge` or `Standard_NC4as_T4_v3`. On AWS, backmesh falls back
to `g4dn.2xlarge`, 8 vCPUs, when no `g4dn.xlarge` is free.
