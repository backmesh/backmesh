---
title: Labels and sizes
description: The runs-on labels backmesh creates, their sizes, and how they map to clouds.
head:
  - tag: title
    content: 'GitHub Actions runner sizes and runs-on labels | backmesh'
---

A label reads left to right: `backmesh-`, then optional parts, then the
number of vCPUs.

| Part             | Means                                                           | Example          |
| ---------------- | --------------------------------------------------------------- | ---------------- |
| `gcp-`, `azure-` | That cloud. Without it, the control plane's cloud               | `backmesh-gcp-4` |
| `od-`            | On-demand instead of spot, for jobs that mustn't be interrupted | `backmesh-od-4`  |
| `kvm-`           | The VM has `/dev/kvm`                                           | `backmesh-kvm-4` |
| the number       | vCPUs, with 4 GiB of memory each                                | `backmesh-8`     |

The [GPU labels](#gpu), `backmesh-gpu-t4` and `backmesh-gpu-od-t4`, end in
their GPU instead of a number.

So `backmesh-4` is a 4-vCPU, 16 GiB spot VM in the control plane's cloud, and
`backmesh-azure-kvm-od-8` an 8-vCPU on-demand Azure VM with `/dev/kvm`.

Every cloud gets the same four sizes, at 4 GiB of memory per vCPU. Each job
gets its own VM of its label's size, which is deleted when the job ends:

| Label                  | vCPU | Memory |
| ---------------------- | ---- | ------ |
| `backmesh-2`           | 2    | 8 GiB  |
| `backmesh-4` (default) | 4    | 16 GiB |
| `backmesh-8`           | 8    | 32 GiB |
| `backmesh-16`          | 16   | 64 GiB |

A job has its whole VM, less what the VM's own system and Docker use. Sizes
aren't configurable.

With [`--public-repos`](/public-repos/), the control plane's cloud also gets
`backmesh-public-2` and `backmesh-public-4`: spot VMs, without KVM, and the
only labels pull requests from a public repository's forks may use.

## One cloud or several

The control plane's cloud has the plain labels, `backmesh-2` to
`backmesh-16`. Each other cloud's labels name it:

```yaml
runs-on: backmesh-4 # the control plane's cloud, say AWS
runs-on: backmesh-gcp-4 # or backmesh-azure-4
```

Adding or removing a cloud never renames a label. Each label runs in exactly
one cloud today; a plain label may later widen to any of your clouds with room,
while a named one keeps its cloud.

## VM types

Each job's VM is the first type in its label's list that has capacity. The types
for `backmesh-4` are below; the other sizes use the same families at their size:

| Cloud | Types for `backmesh-4`, in order                                     |
| ----- | -------------------------------------------------------------------- |
| AWS   | `m8a.xlarge`, `m8i.xlarge`, `m7a.xlarge`, `m7i.xlarge`, `m6a.xlarge` |
| GCP   | `n2-standard-4`, `n2d-standard-4`                                    |
| Azure | `Standard_D4ads_v5`, `Standard_D4as_v5`, `Standard_D4s_v5`           |

When no type has capacity, jobs wait at GitHub and [`backmesh status`](/status/)
shows why runners are short. Each cloud's page lists every size's types:
[AWS](/aws/), [GCP](/gcp/) and [Azure](/azure/).

## On demand

Each size also has an on-demand label, with the same types on on-demand VMs:
`backmesh-od-2` to `backmesh-od-16`, or `backmesh-gcp-od-4` and so on on
another cloud. On demand costs about 2 to 5 times spot, so use it for long jobs
on the critical path, where a reclaim would cost more than it saves.

backmesh also reruns a run's failed jobs on demand when spot reclaims were its
only failures, once the run finishes and at most twice. GitHub picks which
runner takes a job, so a rerun can still land on spot. To rerun on demand every
time, whatever the cause:

```yaml
runs-on: ${{ github.run_attempt == 1 && 'backmesh-4' || 'backmesh-od-4' }}
```

To keep backmesh from rerunning a job's run, add `backmesh-noretry` next to its
size label. Always pair it with one: alone it matches every label.

```yaml
runs-on: [backmesh-4, backmesh-noretry]
```

## KVM

Jobs that start microVMs, emulators or other virtual machines need `/dev/kvm`.
Run them on `backmesh-kvm-2` to `backmesh-kvm-16`, the same sizes on spot VMs
with nested virtualization:

| Cloud | Types for `backmesh-kvm-4`, in order  |
| ----- | ------------------------------------- |
| AWS   | `m8i.xlarge`, `m7i.xlarge`            |
| GCP   | `n2-standard-4`                       |
| Azure | `Standard_D4as_v5`, `Standard_D4s_v5` |

Install keeps only the types a runner region offers with nested
virtualization, and a KVM label's jobs run only in those regions; a cloud whose
regions have none gets no KVM labels.

```yaml
runs-on: backmesh-kvm-8
```

Like the other labels, they have no VM while idle, retry on demand after a spot
reclaim, and have on-demand twins, `backmesh-kvm-od-2` to `backmesh-kvm-od-16`.
On another cloud than the control plane's they name it: `backmesh-azure-kvm-8`. They share their
cloud's spot and on-demand vCPU quotas with the other labels.

## GPU

Jobs that need an NVIDIA GPU run on `backmesh-gpu-t4`, a spot VM with one
Tesla T4 (16 GB of VRAM) and 4 vCPUs, the shape of GitHub's GPU runner. Its
on-demand twin is `backmesh-gpu-od-t4`. On another cloud than the control
plane's they name it: `backmesh-azure-gpu-t4`.

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
and pulling and starting the runner's image takes about 90 seconds more. When
spot T4s are short, a `backmesh-gpu-t4` job waits for one: like every spot
label, it never falls back on demand. `backmesh-gpu-od-t4` runs on demand
instead.

The job sees the GPU as on GitHub's runner: `nvidia-smi` works in a step, and
`docker run --gpus all` works on the VM's Docker through the NVIDIA container
toolkit. The VM's image comes with the NVIDIA driver; CUDA itself comes from
your job's container or a setup action, as on GitHub's runner. As there, a
job's `container:` and its service containers see the GPU only with
`options: --gpus all`.

```yaml
runs-on: backmesh-gpu-t4
steps:
  - run: nvidia-smi
  - run: docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

```yaml
runs-on: backmesh-gpu-t4
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

Workflows that run large Node.js tools on `backmesh-4`, such as ESLint over a big
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
