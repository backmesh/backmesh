---
title: GitHub Actions GPU runners in your own AWS or Azure account
description: NVIDIA T4 GPU runners for GitHub Actions on spot or on-demand VMs in your own AWS or Azure account. List prices against GitHub's $0.052 a minute, measured start times, quotas, and a workflow that keeps CPU tests off the GPU.
sidebar:
  label: GPU runners
head:
  - tag: title
    content: 'GitHub Actions GPU runners on AWS and Azure: T4 pricing | backmesh'
  - tag: meta
    attrs:
      property: og:title
      content: 'GitHub Actions GPU runners on AWS and Azure: T4 pricing | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Does GitHub Actions have GPU runners?","acceptedAnswer":{"@type":"Answer","text":"Yes. GitHub-hosted GPU runners are larger runners with 4 vCPUs, one Tesla T4 with 16 GB of VRAM and 28 GB of RAM, at $0.052 a minute on Linux as of 2026-11-24. You can also run GPU jobs on self-hosted runners in your own cloud account, which is what backmesh sets up."}},{"@type":"Question","name":"How much does a GitHub Actions GPU runner cost?","acceptedAnswer":{"@type":"Answer","text":"GitHub lists linux_4_core_gpu at $0.052 a minute, $3.12 an hour, as of 2026-11-24. At list prices on 2026-11-18, a T4 VM in your own account costs $0.2732 an hour on AWS spot (g4dn.xlarge), $0.1766 on Azure spot (Standard_NC4as_T4_v3) and $0.526 on demand on either. That is list-price arithmetic, not a measurement."}},{"@type":"Question","name":"How long does a backmesh GPU job wait for its runner?","acceptedAnswer":{"@type":"Answer","text":"On AWS, a cold backmesh-ubuntu-2404-gpu-t4 job waited a median of 130.5 seconds from queued to started over 10 samples on 2026-11-21, none of which met a spot capacity refusal. Azure was not measured."}},{"@type":"Question","name":"Is it faster than GitHub''s GPU runner?","acceptedAnswer":{"@type":"Answer","text":"We haven''t measured that. The start time above is backmesh''s alone."}},{"@type":"Question","name":"Why do my GPU jobs never start?","acceptedAnswer":{"@type":"Answer","text":"GPU quotas are 0 on most new cloud accounts. On AWS, raise \"All G and VT Spot Instance Requests\" (L-3819A6DF) or \"Running On-Demand G and VT instances\" (L-DB2E81BA), at least 4 vCPUs per region for one T4 VM and 8 for the g4dn.2xlarge fallback. On Azure, spot GPU VMs count against \"Total Regional Low-priority vCPUs\" and on-demand ones against \"Standard NCASv3_T4 Family vCPUs\" and \"Total Regional vCPUs\". backmesh install and backmesh status name the quota to raise."}},{"@type":"Question","name":"Which GPUs does backmesh run?","acceptedAnswer":{"@type":"Answer","text":"One NVIDIA T4 per job, the same GPU as GitHub''s runner. No other GPU types."}},{"@type":"Question","name":"Does backmesh run GPU jobs on GCP?","acceptedAnswer":{"@type":"Answer","text":"Not yet. GCP T4 runners are coming; today the GPU labels run on AWS and Azure."}}]}'
---

`backmesh-ubuntu-2404-gpu-t4` runs a GitHub Actions job on its own VM with one NVIDIA T4,
in your own AWS account or Azure subscription, on the cloud of backmesh's
control plane. On the other cloud, or on both when the control plane is on
GCP, the label names it: `backmesh-azure-ubuntu-2404-gpu-t4`, `backmesh-aws-ubuntu-2404-gpu-t4`. Your
cloud bills you for the VM; backmesh is open source (Apache-2.0) with no
license fee.

```sh
curl -fsSL https://backmesh.com/install.sh | sh
backmesh install --org acme
```

```yaml
jobs:
  cuda-tests:
    runs-on: backmesh-ubuntu-2404-gpu-t4
    steps:
      - uses: actions/checkout@v6
      - run: nvidia-smi
```

`backmesh-ubuntu-2404-gpu-t4` runs on spot; `backmesh-ubuntu-2404-gpu-od-t4` runs on demand. See
[GPU labels](/labels/#gpu). GCP T4
runners are coming, not available yet.

## Price against GitHub's GPU runner

GitHub's Linux GPU runner, `linux_4_core_gpu` (4 vCPUs, one Tesla T4 with 16 GB
of VRAM, 28 GB of RAM,
[docs.github.com](https://docs.github.com/en/actions/reference/runners/larger-runners)),
lists at $0.052 a minute
([docs.github.com](https://docs.github.com/en/billing/reference/actions-runner-pricing),
read 2026-11-24), $3.12 an hour. backmesh's are the catalog's prices on
2026-11-18, spot in the lowest zone. The ratios are list-price arithmetic,
not measured.

| Runner                                   | $ an hour | $ a minute | GitHub's ÷ this |
| ---------------------------------------- | --------- | ---------- | --------------- |
| GitHub `linux_4_core_gpu`                | 3.12      | 0.052      | 1×              |
| AWS `g4dn.xlarge`, spot                  | 0.2732    | 0.0046     | 11.4×           |
| AWS `g4dn.xlarge`, on demand             | 0.526     | 0.0088     | 5.9×            |
| AWS `g4dn.2xlarge`, spot (fallback)      | 0.3696    | 0.0062     | 8.4×            |
| AWS `g4dn.2xlarge`, on demand (fallback) | 0.752     | 0.0125     | 4.1×            |
| Azure `Standard_NC4as_T4_v3`, spot       | 0.1766    | 0.0029     | 17.7×           |
| Azure `Standard_NC4as_T4_v3`, on demand  | 0.526     | 0.0088     | 5.9×            |

AWS tries `g4dn.2xlarge`, the same T4 with 8 vCPUs, when no `g4dn.xlarge` is
free.

Left out: each VM's disk, its boot, and backmesh's control plane, about $86 a
month on AWS and $111 on Azure, which the GPU labels share with the CPU ones.
[Cost](/cost/#gpu) has the method;
[GitHub Actions GPU pricing explained](/blog/github-actions-gpu-pricing/)
works through a month.

## How long a job waits

A cold `backmesh-ubuntu-2404-gpu-t4` job on AWS waited a median of 130.5 seconds, about
2 minutes 10 seconds, from queued to started (p90 138 s), over 10 samples on
2026-11-21 with no runner waiting on the label. Each got a spot `g4dn.xlarge`
and none met a spot capacity refusal, so this is the no-refusal case. When spot
T4s are short, a spot job [falls back on demand](/labels/#on-demand-fallback). Azure
wasn't measured. The samples and method are in
[benchmarks/gpu-t4](https://github.com/backmesh/backmesh/tree/main/benchmarks/gpu-t4).

## What's on the VM

The VM boots an image with the NVIDIA driver and the NVIDIA container toolkit;
on AWS, Amazon's Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04).
`nvidia-smi` works in a step, and `docker run --gpus all` works on the VM's
Docker. The CUDA toolkit isn't preinstalled: it comes from your job's
container, such as `nvidia/cuda` or `pytorch/pytorch`, or from pip wheels such
as PyTorch's, which bundle it. A job's `container:` sees the GPU with
`options: --gpus all`. The runner itself is the
[same image as every label](/runner-image/). AWS's `g4dn.xlarge` has 16 GiB of
RAM to GitHub's 28; a job that needs more runs on Azure's 28 GiB
`Standard_NC4as_T4_v3`: `backmesh-azure-ubuntu-2404-gpu-t4` when the control plane is on
AWS.

## Keep CPU tests off the GPU

A GPU minute costs more than a CPU one, so run only the GPU tests on
`backmesh-ubuntu-2404-gpu-t4` and the rest on `backmesh-ubuntu-2404-4vcpu`. Here the GPU job runs only on
pull requests labelled `gpu`, and adding the label runs it without rerunning
the CPU tests:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled]

jobs:
  cpu-tests:
    if: github.event.action != 'labeled'
    runs-on: backmesh-ubuntu-2404-4vcpu
    steps:
      - uses: actions/checkout@v6
      - run: make test-cpu
  gpu-tests:
    if: >-
      contains(github.event.pull_request.labels.*.name, 'gpu') &&
      (github.event.action != 'labeled' || github.event.label.name == 'gpu')
    runs-on: backmesh-ubuntu-2404-gpu-t4
    steps:
      - uses: actions/checkout@v6
      - run: make test-gpu
```

To run the GPU tests when GPU code changes instead, put the GPU job in a
workflow of its own with a `paths` filter, so the CPU tests still run on
every change.

[How to run CUDA and PyTorch tests in GitHub Actions](/blog/run-cuda-tests-github-actions/)
has a full workflow.

## Your quota, your bill

GPU VMs run in your account, so their quota is yours, and it's 0 on most new
accounts. On AWS, request vCPUs in "All G and VT Spot Instance Requests"
(`L-3819A6DF`) and "Running On-Demand G and VT instances" (`L-DB2E81BA`); on
Azure, spot GPU VMs count against "Total Regional Low-priority vCPUs" and
on-demand ones against "Standard NCASv3_T4 Family vCPUs" and "Total Regional
vCPUs". Install and
[`backmesh status`](/status/) name the one to raise.
[Getting T4 GPU quota on AWS and Azure](/blog/t4-gpu-quota-aws-azure/) walks
through the requests.

## FAQ

**Does GitHub Actions have GPU runners?** Yes. GitHub-hosted GPU runners are
larger runners with 4 vCPUs, one Tesla T4 with 16 GB of VRAM and 28 GB of RAM,
at $0.052 a minute on Linux as of 2026-11-24. You can also run GPU jobs on
self-hosted runners in your own cloud account, which is what backmesh sets up.

**How much does a GitHub Actions GPU runner cost?** GitHub lists
`linux_4_core_gpu` at $0.052 a minute, $3.12 an hour, as of 2026-11-24. At list
prices on 2026-11-18, a T4 VM in your own account costs $0.2732 an hour on AWS
spot (`g4dn.xlarge`), $0.1766 on Azure spot (`Standard_NC4as_T4_v3`) and
$0.526 on demand on either. That is list-price arithmetic, not a measurement.

**How long does a backmesh GPU job wait for its runner?** On AWS, a cold
`backmesh-ubuntu-2404-gpu-t4` job waited a median of 130.5 seconds from queued to started
over 10 samples on 2026-11-21, none of which met a spot capacity refusal. Azure
was not measured.

**Is it faster than GitHub's GPU runner?** We haven't measured that. The start
time above is backmesh's alone.

**Why do my GPU jobs never start?** GPU quotas are 0 on most new cloud
accounts. On AWS, raise "All G and VT Spot Instance Requests" (`L-3819A6DF`) or
"Running On-Demand G and VT instances" (`L-DB2E81BA`), at least 4 vCPUs per
region for one T4 VM and 8 for the `g4dn.2xlarge` fallback. On Azure, spot GPU
VMs count against "Total Regional Low-priority vCPUs" and on-demand ones
against "Standard NCASv3_T4 Family vCPUs" and "Total Regional vCPUs".
`backmesh install` and
`backmesh status` name the quota to raise.

**Which GPUs does backmesh run?** One NVIDIA T4 per job, the same GPU as
GitHub's runner. No other GPU types.

**Does backmesh run GPU jobs on GCP?** Not yet. GCP T4 runners are coming;
today the GPU labels run on AWS and Azure.
