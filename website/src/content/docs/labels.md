---
title: Labels and sizes
description: The runs-on labels backmesh creates, their sizes, and how they map to clouds.
head:
  - tag: title
    content: 'GitHub Actions runner sizes and runs-on labels | backmesh'
---

A label reads left to right: `backmesh-`, an optional cloud, the OS, optional
parts, then the number of vCPUs.

| Part             | Means                                                           | Example                               |
| ---------------- | --------------------------------------------------------------- | ------------------------------------- |
| `gcp-`, `azure-` | That cloud. Without it, the control plane's cloud               | `backmesh-gcp-ubuntu-2404-4vcpu`      |
| `ubuntu-2404`    | The job runs on Ubuntu 24.04, as GitHub's `ubuntu-24.04` does   | `backmesh-ubuntu-2404-4vcpu`          |
| `kvm-`           | The VM has `/dev/kvm`                                           | `backmesh-ubuntu-2404-kvm-4vcpu`      |
| `arm-`           | An arm64 VM, on AWS Graviton or GCP Axion and Ampere            | `backmesh-ubuntu-2404-arm-4vcpu`      |
| `highmem-`       | 8 GiB of memory a vCPU instead of 4                             | `backmesh-ubuntu-2404-highmem-16vcpu` |
| `od-`            | On-demand instead of spot, for jobs that mustn't be interrupted | `backmesh-ubuntu-2404-od-4vcpu`       |
| `<n>vcpu`        | vCPUs, with 4 GiB of memory each                                | `backmesh-ubuntu-2404-8vcpu`          |

The [GPU labels](#gpu), `backmesh-ubuntu-2404-gpu-t4` and `backmesh-ubuntu-2404-gpu-od-t4`, end in
their GPU instead of a number.

So `backmesh-ubuntu-2404-4vcpu` is a 4-vCPU, 16 GiB spot VM in the control plane's cloud, and
`backmesh-azure-ubuntu-2404-kvm-od-8vcpu` an 8-vCPU on-demand Azure VM with `/dev/kvm`.

Every cloud gets the same four sizes, at 4 GiB of memory per vCPU. Each job
gets its own VM of its label's size, which is deleted when the job ends:

| Label                                  | vCPU | Memory |
| -------------------------------------- | ---- | ------ |
| `backmesh-ubuntu-2404-2vcpu`           | 2    | 8 GiB  |
| `backmesh-ubuntu-2404-4vcpu` (default) | 4    | 16 GiB |
| `backmesh-ubuntu-2404-8vcpu`           | 8    | 32 GiB |
| `backmesh-ubuntu-2404-16vcpu`          | 16   | 64 GiB |

A job has its whole VM, less what the VM's own system and Docker use. Sizes
aren't configurable; for more memory, see [High memory](#high-memory).

With [`--public-repos`](/public-repos/), the control plane's cloud also gets
`backmesh-ubuntu-2404-public-2vcpu` and `backmesh-ubuntu-2404-public-4vcpu`: spot VMs, without KVM, and the
only labels pull requests from a public repository's forks may use.

## One cloud or several

The control plane's cloud has the plain labels, `backmesh-ubuntu-2404-2vcpu` to
`backmesh-ubuntu-2404-16vcpu`. Each other cloud's labels name it:

```yaml
runs-on: backmesh-ubuntu-2404-4vcpu # the control plane's cloud, say AWS
runs-on: backmesh-gcp-ubuntu-2404-4vcpu # or backmesh-azure-ubuntu-2404-4vcpu
```

Adding or removing a cloud never renames a label. Each label runs in exactly
one cloud today; a plain label may later widen to any of your clouds with room,
while a named one keeps its cloud.

## VM types

Each job's VM is the first type in its label's list that has capacity. The types
for `backmesh-ubuntu-2404-4vcpu` are below; the other sizes use the same families at their size:

| Cloud | Types for `backmesh-ubuntu-2404-4vcpu`, in order                     |
| ----- | -------------------------------------------------------------------- |
| AWS   | `m8a.xlarge`, `m8i.xlarge`, `m7a.xlarge`, `m7i.xlarge`, `m6a.xlarge` |
| GCP   | `c4d-standard-4`, `n2-standard-4`, `n2d-standard-4`                  |
| Azure | `Standard_D4ads_v5`, `Standard_D4as_v5`, `Standard_D4s_v5`           |

When no type has capacity, jobs wait at GitHub and [`backmesh status`](/status/)
shows why runners are short. Each cloud's page lists every size's types:
[AWS](/aws/), [GCP](/gcp/) and [Azure](/azure/).

## On demand

Each size also has an on-demand label, with the same types on on-demand VMs:
`backmesh-ubuntu-2404-od-2vcpu` to `backmesh-ubuntu-2404-od-16vcpu`, or `backmesh-gcp-ubuntu-2404-od-4vcpu` and so on on
another cloud. On GCP, on-demand labels from 4 vCPUs try AMD's `c4d` and `c3d`
first, which built faster for less per job at 4 vCPUs, then the types above: `backmesh-ubuntu-2404-od-4vcpu` tries
`c4d-standard-4`, `c3d-standard-4`, `n2-standard-4` and `n2d-standard-4`. A
`c4d` VM has 3.875 GiB a vCPU, so 15 GiB at 4 vCPUs, against GitHub's 4-core
runner's 16 GiB ([GCP](/gcp/#vm-types)). On demand costs about 2 to 5 times spot, so use it for long jobs
on the critical path, where a reclaim would cost more than it saves.

backmesh also reruns a run's failed jobs on demand when spot reclaims were its
only failures, once the run finishes and at most twice. GitHub picks which
runner takes a job, so a rerun can still land on spot. To rerun on demand every
time, whatever the cause:

```yaml
runs-on: ${{ github.run_attempt == 1 && 'backmesh-ubuntu-2404-4vcpu' || 'backmesh-ubuntu-2404-od-4vcpu' }}
```

To keep backmesh from rerunning a job's run, add `backmesh-noretry` next to its
size label. Always pair it with one: alone it matches every label.

```yaml
runs-on: [backmesh-ubuntu-2404-4vcpu, backmesh-noretry]
```

### On-demand fallback

A spot label falls back on demand by itself when the cloud has no spot capacity
for it, so its jobs don't wait at GitHub for capacity to come back. A spot
runner falls back when its launch is still refused 75 s after its submit, once
anycloud has tried every VM type and zone of a region that refused it and
backmesh has tried the label's other regions: its replacement is an on-demand
VM of the same types, in any runner region. After 3 such refusals in a region
within 15 minutes, the region is [avoided](/status/) for spot for 30 minutes,
and while every spot region of the label is avoided, its jobs' runners start on
demand at once; after the 30 minutes they start on spot again. Runners started
ahead of predicted or cued jobs don't fall back: they wait for spot. With a
[`--runner-region`](/install/#regions), the order is spot in that region,
then spot in the geo's others, then on demand in that region first. A job that fell back bills at the on-demand rate,
about 1.7 to 5.4 times spot ([Cost](/cost/#whats-left-out)). The listener logs
each with `"fallback": true` on its `job completed` line, and
[`backmesh status`](/status/) counts a label's jobs that fell back today. Public
labels have no on-demand pair, so they never fall back.

## KVM

Jobs that start microVMs, emulators or other virtual machines need `/dev/kvm`.
Run them on `backmesh-ubuntu-2404-kvm-2vcpu` to `backmesh-ubuntu-2404-kvm-16vcpu`, the same sizes on spot VMs
with nested virtualization:

| Cloud | Types for `backmesh-ubuntu-2404-kvm-4vcpu`, in order |
| ----- | ---------------------------------------------------- |
| AWS   | `m8i.xlarge`, `m7i.xlarge`                           |
| GCP   | `n2-standard-4`                                      |
| Azure | `Standard_D4as_v5`, `Standard_D4s_v5`                |

Install keeps only the types a runner region offers with nested
virtualization, and a KVM label's jobs run only in those regions; a cloud whose
regions have none gets no KVM labels.

```yaml
runs-on: backmesh-ubuntu-2404-kvm-8vcpu
```

Like the other labels, they have no VM while idle, retry on demand after a spot
reclaim, and have on-demand twins, `backmesh-ubuntu-2404-kvm-od-2vcpu` to `backmesh-ubuntu-2404-kvm-od-16vcpu`.
On another cloud than the control plane's they name it: `backmesh-azure-ubuntu-2404-kvm-8vcpu`. They share their
cloud's spot and on-demand vCPU quotas with the other labels.

## High memory

Jobs that run out of memory at 4 GiB a vCPU, such as a large Rust or C++
link, run on `backmesh-ubuntu-2404-highmem-2vcpu` to
`backmesh-ubuntu-2404-highmem-16vcpu`: the same four sizes with 8 GiB a vCPU,
on each cloud's memory-optimized twin of the families above.

| Label                                 | vCPU | Memory  |
| ------------------------------------- | ---- | ------- |
| `backmesh-ubuntu-2404-highmem-2vcpu`  | 2    | 16 GiB  |
| `backmesh-ubuntu-2404-highmem-4vcpu`  | 4    | 32 GiB  |
| `backmesh-ubuntu-2404-highmem-8vcpu`  | 8    | 64 GiB  |
| `backmesh-ubuntu-2404-highmem-16vcpu` | 16   | 128 GiB |

| Cloud | Types for `backmesh-ubuntu-2404-highmem-16vcpu`, in order                 |
| ----- | ------------------------------------------------------------------------- |
| AWS   | `r8a.4xlarge`, `r8i.4xlarge`, `r7a.4xlarge`, `r7i.4xlarge`, `r6a.4xlarge` |
| GCP   | `n2-highmem-16`, `n2d-highmem-16`                                         |
| Azure | `Standard_E16ads_v5`, `Standard_E16as_v5`, `Standard_E16s_v5`             |

```yaml
runs-on: backmesh-ubuntu-2404-highmem-16vcpu
```

Their on-demand twins are `backmesh-ubuntu-2404-highmem-od-2vcpu` to
`backmesh-ubuntu-2404-highmem-od-16vcpu`, with the same types (GCP's don't try
`c4d` or `c3d` first), and on another cloud than the control plane's they name
it: `backmesh-gcp-ubuntu-2404-highmem-16vcpu`. A spot reclaim pauses only the
high-memory labels' spot, and retries go to the high-memory on-demand label of
the same size. They share their cloud's spot and on-demand vCPU quotas with
the other labels, and cost about 1.3 times the same size's general label on
demand ([Cost](/cost/#high-memory)). There are no KVM, GPU or public
high-memory labels.

## GPU

Jobs that need an NVIDIA GPU run on `backmesh-ubuntu-2404-gpu-t4`, a spot VM with one
Tesla T4 (16 GB of VRAM) and 4 vCPUs, the shape of GitHub's GPU runner. Its
on-demand twin is `backmesh-ubuntu-2404-gpu-od-t4`. On another cloud than the control
plane's they name it: `backmesh-azure-ubuntu-2404-gpu-t4`.

| Cloud | Type                               | vCPU | Memory     | Regions                                                                                                    |
| ----- | ---------------------------------- | ---- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| AWS   | `g4dn.xlarge`, then `g4dn.2xlarge` | 4, 8 | 16, 32 GiB | the runner regions that offer them                                                                         |
| Azure | `Standard_NC4as_T4_v3`             | 4    | 28 GiB     | the runner regions that offer it: `eastus`, `centralus`, `eastus2`, `southcentralus`, `westus2`, `westus3` |

GitHub's GPU runner has 28 GB of memory; AWS's `g4dn.xlarge` has 16 GiB, so a
job that needs more than about 14 GiB of RAM runs on Azure's. AWS's
`g4dn.2xlarge` has the same T4 and is tried when no `g4dn.xlarge` is free, at
about 1.4 times the price. GCP has no GPU labels yet: anycloud can't launch a
T4 VM there.

A GPU job starts slower than a CPU one: its VM boots NVIDIA's larger image,
and pulling and starting the runner's image takes longer, as the
[GPU benchmark](https://github.com/backmesh/backmesh/tree/main/benchmarks/gpu-t4)
measured. When
spot T4s are short, a `backmesh-ubuntu-2404-gpu-t4` job
[falls back on demand](#on-demand-fallback), like every spot label's.
`backmesh-ubuntu-2404-gpu-od-t4` always runs on demand.

The job sees the GPU as on GitHub's runner: `nvidia-smi` works in a step, and
`docker run --gpus all` works on the VM's Docker through the NVIDIA container
toolkit. The VM's image comes with the NVIDIA driver; CUDA itself comes from
your job's container or a setup action, as on GitHub's runner. As there, a
job's `container:` and its service containers see the GPU only with
`options: --gpus all`.

```yaml
runs-on: backmesh-ubuntu-2404-gpu-t4
steps:
  - run: nvidia-smi
  - run: docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

```yaml
runs-on: backmesh-ubuntu-2404-gpu-t4
container:
  image: nvidia/cuda:12.4.1-base-ubuntu22.04
  options: --gpus all
```

GPU VMs count against their own quotas, which are 0 on most new accounts:
AWS's "All G and VT Spot Instance Requests" (`L-3819A6DF`) and "Running
On-Demand G and VT instances" (`L-DB2E81BA`), and Azure's "Standard NCASv3_T4
Family vCPUs" on demand (its spot GPU VMs count against "Total Regional
Low-priority vCPUs" with the other spot labels). Install and
[`backmesh status`](/status/) print them and name the one to raise; until it's
raised, the GPU labels' jobs wait at GitHub. See [Cost](/cost/#gpu) for their
prices.

## arm64

Jobs that build or test for Linux arm64 run on `backmesh-ubuntu-2404-arm-2vcpu` to
`backmesh-ubuntu-2404-arm-16vcpu`: spot VMs on AWS Graviton, GCP Axion or, from backmesh v0.7.3, Azure Cobalt, at the same
sizes and 4 GiB a vCPU. `backmesh-ubuntu-2404-arm-highmem-2vcpu` to
`backmesh-ubuntu-2404-arm-highmem-16vcpu` have 8 GiB a vCPU, as the
[high-memory labels](#high-memory) do. Each has an on-demand twin:
`backmesh-ubuntu-2404-arm-od-4vcpu`, `backmesh-ubuntu-2404-arm-highmem-od-16vcpu`. On another cloud than
the control plane's they name it: `backmesh-gcp-ubuntu-2404-arm-4vcpu`. In a public repository they're for the
repository's own runs: fork pull requests run only on `backmesh-ubuntu-2404-public-2vcpu` and
`backmesh-ubuntu-2404-public-4vcpu`, which are x86-64.

| Label                                     | vCPU | Memory  | AWS, in order                | GCP, in order                        |
| ----------------------------------------- | ---- | ------- | ---------------------------- | ------------------------------------ |
| `backmesh-ubuntu-2404-arm-2vcpu`          | 2    | 8 GiB   | `m8g.large`, `m7g.large`     | `c4a-standard-2`, `t2a-standard-2`   |
| `backmesh-ubuntu-2404-arm-4vcpu`          | 4    | 16 GiB  | `m8g.xlarge`, `m7g.xlarge`   | `c4a-standard-4`, `t2a-standard-4`   |
| `backmesh-ubuntu-2404-arm-8vcpu`          | 8    | 32 GiB  | `m8g.2xlarge`, `m7g.2xlarge` | `c4a-standard-8`, `t2a-standard-8`   |
| `backmesh-ubuntu-2404-arm-16vcpu`         | 16   | 64 GiB  | `m8g.4xlarge`, `m7g.4xlarge` | `c4a-standard-16`, `t2a-standard-16` |
| `backmesh-ubuntu-2404-arm-highmem-2vcpu`  | 2    | 16 GiB  | `r8g.large`, `r7g.large`     | `c4a-highmem-2`                      |
| `backmesh-ubuntu-2404-arm-highmem-4vcpu`  | 4    | 32 GiB  | `r8g.xlarge`, `r7g.xlarge`   | `c4a-highmem-4`                      |
| `backmesh-ubuntu-2404-arm-highmem-8vcpu`  | 8    | 64 GiB  | `r8g.2xlarge`, `r7g.2xlarge` | `c4a-highmem-8`                      |
| `backmesh-ubuntu-2404-arm-highmem-16vcpu` | 16   | 128 GiB | `r8g.4xlarge`, `r7g.4xlarge` | `c4a-highmem-16`                     |

AWS's `m8g` and `r8g` are Graviton4 and `m7g` and `r7g` Graviton3; GCP's
`c4a` is Google's Axion and `t2a` Ampere Altra, which has no high-memory shape.
Unlike the other labels' types, these aren't in every runner region: GCP's
`t2a` is in `us-central1` and `europe-west4` only, so an arm64 label's jobs
launch in the runner regions that offer one of its types, and a cloud whose
regions offer none gets no arm64 labels.

An arm64 vCPU is a whole core, not a hyperthread. anycloud measured backmesh's
builds on `m8g` at 0.94 of `m8i`'s time at 4 vCPUs and 1.03 at 16, and `m8a`,
which `backmesh-ubuntu-2404-4vcpu` tries first, about 1.3 times as fast as `m8g`
([anycloud#36](https://github.com/anycloud-sh/anycloud/pull/36)). So use them
for arm64 work, not for speed on x86 work. A job that builds arm64 images under
QEMU on `backmesh-ubuntu-2404-4vcpu` (`docker/setup-qemu-action`) builds them natively here.

```yaml
runs-on: backmesh-ubuntu-2404-arm-4vcpu
steps:
  - run: docker build --tag app:arm64 .
```

Spot Graviton is scarcer than spot x86 at 4 vCPUs: in three samples on
2026-11-23 and 24, a spot `m8g.xlarge` launched in 42 % of zones against
`m8i.xlarge`'s 81 %, and `m8g.4xlarge` in 75 % against `m8i.4xlarge`'s 72 %
([anycloud#36](https://github.com/anycloud-sh/anycloud/pull/36)). When spot
arm64 capacity is short, an arm64 job [falls back on demand](#on-demand-fallback)
onto arm64, never x86, and an arm64 label's spot reclaims pause only the
arm64 labels' spot.

The jobs run the [runner image](/runner-image/)'s arm64 build, with the same
tools at the same versions, and the first-use installs fetch arm64 releases.
setup actions such as `actions/setup-node` pick arm64 builds by themselves. An
image without an arm64 build won't run in a `docker run` or a `container:`, as
on GitHub's arm64 runner. AWS's count against the same Standard spot and
on-demand vCPU quotas as the other AWS labels ([AWS](/aws/#quotas)); GCP's
on-demand ones against their family's, `C4A_CPUS` or `T2A_CPUS`, and its spot
ones against `PREEMPTIBLE_CPUS` where a region sets it. See
[Cost](/cost/#arm64) for their prices.

## Large Node.js tools

Workflows that run large Node.js tools on `backmesh-ubuntu-2404-4vcpu`, such as ESLint over a big
repository, set a larger heap:

```yaml
env:
  NODE_OPTIONS: --max-old-space-size=6144
```

## The runner image

Every label runs one image with the GitHub Actions runner, the Docker CLI,
which uses the VM's Docker, and the apt packages GitHub's `ubuntu-24.04` runners
have, not their language toolchains, cloud CLIs or browsers; languages come
from setup actions, and a job that needs other tools uses GitHub's per-job
`container:`. See [The runner image](/runner-image/). The
runner's own container is on the same Docker but hidden from the job, so
`docker ps`, `kill` and `rm -f $(docker ps -aq)` never touch it. Each job
starts on a new VM, so no image layers carry over between jobs. See
[Cache](/cache/) for caches kept in your own cloud.
[Coming from ubuntu-latest](/from-ubuntu-latest/) lists what differs from
GitHub's runners.
