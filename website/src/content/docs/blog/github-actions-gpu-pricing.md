---
title: 'GitHub Actions GPU pricing explained: hosted T4 against your own g4dn or NC T4'
description: GitHub's T4 GPU runner lists at $0.052 a minute. What the same T4 costs as an AWS g4dn.xlarge or Azure NC4as_T4_v3 VM in your own account, spot and on demand, worked through for 10,000 GPU minutes a month.
date: 2026-11-24
lastUpdated: 2026-11-24
authors: backmesh
tags:
  - GPU
  - Costs
excerpt: GitHub's Linux GPU runner is one Tesla T4 at $0.052 a minute. The same T4 in your own AWS or Azure account lists at $0.0029 to $0.0088 a minute. A month of 10,000 GPU minutes worked through, with what the arithmetic leaves out.
head:
  - tag: title
    content: 'GitHub Actions GPU pricing: hosted T4 vs AWS and Azure (2026) | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"GitHub Actions GPU pricing explained: hosted T4 against your own g4dn or NC T4","datePublished":"2026-11-24","dateModified":"2026-11-24","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/github-actions-gpu-pricing/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"How much does a GitHub Actions GPU runner cost?","acceptedAnswer":{"@type":"Answer","text":"GitHub lists its Linux GPU runner, linux_4_core_gpu, at $0.052 a minute ($3.12 an hour) as of 2026-11-24. It has 4 vCPUs, one Tesla T4 with 16 GB of VRAM and 28 GB of RAM."}},{"@type":"Question","name":"What does a T4 cost on AWS or Azure?","acceptedAnswer":{"@type":"Answer","text":"At catalog prices on 2026-11-18: AWS g4dn.xlarge $0.2732 an hour on spot and $0.526 on demand; Azure Standard_NC4as_T4_v3 $0.1766 on spot and $0.526 on demand."}},{"@type":"Question","name":"Is a self-hosted GPU runner cheaper than GitHub''s?","acceptedAnswer":{"@type":"Answer","text":"At list prices, for 10,000 GPU minutes a month in 10-minute jobs: $520 on GitHub against about $62 on AWS spot with boots and disks, before backmesh''s control plane of about $56 a month on AWS. Below about 1,200 GPU minutes a month, a control plane run only for GPU jobs costs more than it saves. This is arithmetic, not a measurement."}}]}]}'
---

GitHub's GPU runner and a T4 VM in your own cloud account are the same GPU,
one NVIDIA T4 with 16 GB of VRAM, at very different list prices. This post
puts the prices side by side and works through one month. Every figure is
list-price arithmetic from the dated sources below, not a measured bill.

## The prices

- **GitHub-hosted:** `linux_4_core_gpu`, 4 vCPUs, one Tesla T4 with 16 GB of
  VRAM and 28 GB of RAM
  ([docs.github.com](https://docs.github.com/en/actions/reference/runners/larger-runners)),
  at $0.052 a minute, $3.12 an hour
  ([docs.github.com](https://docs.github.com/en/billing/reference/actions-runner-pricing),
  read 2026-11-24). GitHub bills from the job's start, per minute.
- **Your own T4:** backmesh's catalog prices on 2026-11-18, spot in the
  lowest zone. A VM bills from its launch until its job ends.

| T4 runner                                | Spot $/h | On-demand $/h | Spot a minute | On demand a minute |
| ---------------------------------------- | -------- | ------------- | ------------- | ------------------ |
| GitHub `linux_4_core_gpu`                | –        | –             | –             | $0.052             |
| AWS `g4dn.xlarge` (4 vCPUs, 16 GiB)      | 0.2732   | 0.526         | $0.0046       | $0.0088            |
| Azure `Standard_NC4as_T4_v3` (4, 28 GiB) | 0.1766   | 0.526         | $0.0029       | $0.0088            |

AWS's `g4dn.2xlarge` has the same T4 with 8 vCPUs and 32 GiB, at $0.3696
spot and $0.752 on demand; backmesh uses it only when no `g4dn.xlarge` is
free. Spot prices move by the hour and by zone.

## A month, worked through

Say 500 pull requests a month each run two 10-minute GPU jobs: 1,000 jobs,
10,000 GPU minutes.

- **GitHub:** 10,000 × $0.052 = **$520**.
- **AWS spot, `g4dn.xlarge`:** the jobs' minutes, 10,000 ÷ 60 × $0.2732 =
  $45.53. Each VM also bills while it boots: about 122 s from launch to the
  job's start, the median of our
  [GPU start benchmark](https://github.com/backmesh/backmesh/tree/main/benchmarks/gpu-t4),
  so 1,000 × 122 s = 33.9 hours × $0.2732 = $9.26. Each VM's 100 GB disk adds
  about $0.0384 an hour: (166.7 + 33.9) hours × $0.0384 = $7.70. Together
  **$62.49**.
- **AWS on demand:** the same arithmetic at $0.526 an hour comes to $113.19.
- **Azure spot, `Standard_NC4as_T4_v3`:** the jobs' minutes,
  10,000 ÷ 60 × $0.1766 = $29.43, plus boots and disks, which we haven't
  measured on Azure.
- **Azure on demand:** 10,000 ÷ 60 × $0.526 = $87.67 for the jobs' minutes.

Left out: spot reclaims, which fail the job and rerun it, and runners started
ahead of jobs that no job takes.

## The fixed part

A self-hosted runner needs something to start VMs for jobs. backmesh's
control plane and one org's listener cost about $56 a month on AWS and $68
on Azure, whatever the volume. If you already run your CPU jobs on backmesh,
the GPU labels share it and add nothing. If GPU jobs are all you'd move, add
it: $62.49 + $56 = $118.49 on AWS spot against $520 on GitHub.

That fixed cost sets a floor. At AWS spot with 10-minute jobs, each GPU
minute costs about $0.0062 with boots and disks, $0.0458 less than GitHub's,
so $56 a month pays for itself above about 1,200 GPU minutes a month.
Shorter jobs pay more boot per minute and move that point up.

## What the arithmetic doesn't say

- **Speed.** We haven't compared GitHub's GPU runner and a backmesh T4 on the
  same tests. A cold `backmesh-ubuntu-2404-gpu-t4` job on AWS waited a median of about
  2 minutes 10 seconds for its VM, in 10 samples with no spot refusal.
- **Spot capacity.** When spot T4s are short, a spot job waits.
  `backmesh-ubuntu-2404-gpu-od-t4` runs on demand instead.
- **Quota.** New AWS accounts and Azure subscriptions usually have 0 GPU
  quota; see [Getting T4 GPU quota on AWS and Azure for CI](/blog/t4-gpu-quota-aws-azure/).

To keep the GPU minutes low in the first place, run only GPU tests on the GPU:
[How to run CUDA and PyTorch tests in GitHub Actions](/blog/run-cuda-tests-github-actions/).
The [GPU runners](/gpu/) page has the labels and prices in one place.

## FAQ

**How much does a GitHub Actions GPU runner cost?** GitHub lists its Linux GPU
runner, `linux_4_core_gpu`, at $0.052 a minute ($3.12 an hour) as of
2026-11-24. It has 4 vCPUs, one Tesla T4 with 16 GB of VRAM and 28 GB of RAM.

**What does a T4 cost on AWS or Azure?** At catalog prices on 2026-11-18: AWS
`g4dn.xlarge` $0.2732 an hour on spot and $0.526 on demand; Azure
`Standard_NC4as_T4_v3` $0.1766 on spot and $0.526 on demand.

**Is a self-hosted GPU runner cheaper than GitHub's?** At list prices, for
10,000 GPU minutes a month in 10-minute jobs: $520 on GitHub against about $62
on AWS spot with boots and disks, before backmesh's control plane of about $56
a month on AWS. Below about 1,200 GPU minutes a month, a control plane run only
for GPU jobs costs more than it saves. This is arithmetic, not a measurement.
