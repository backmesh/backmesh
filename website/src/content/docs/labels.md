---
title: Labels and sizes
description: The runs-on labels backmesh creates, their sizes, and how they map to clouds.
head:
  - tag: title
    content: 'GitHub Actions runner sizes and runs-on labels | backmesh'
---

A label reads left to right: `backmesh-`, an optional cloud, the OS, optional
parts, then the number of vCPUs.

| Part             | Means                                                           | Example                          |
| ---------------- | --------------------------------------------------------------- | -------------------------------- |
| `gcp-`, `azure-` | That cloud. Without it, the control plane's cloud               | `backmesh-gcp-ubuntu-2404-4vcpu` |
| `ubuntu-2404`    | The job runs on Ubuntu 24.04, as GitHub's `ubuntu-24.04` does   | `backmesh-ubuntu-2404-4vcpu`     |
| `kvm-`           | The VM has `/dev/kvm`                                           | `backmesh-ubuntu-2404-kvm-4vcpu` |
| `od-`            | On-demand instead of spot, for jobs that mustn't be interrupted | `backmesh-ubuntu-2404-od-4vcpu`  |
| `<n>vcpu`        | vCPUs, with 4 GiB of memory each                                | `backmesh-ubuntu-2404-8vcpu`     |

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
aren't configurable.

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
| GCP   | `n2-standard-4`, `n2d-standard-4`                                    |
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
spot T4s are short, a `backmesh-ubuntu-2404-gpu-t4` job waits for one: like every spot
label, it never falls back on demand. `backmesh-ubuntu-2404-gpu-od-t4` runs on demand
instead.

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
