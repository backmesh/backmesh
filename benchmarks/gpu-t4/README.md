# GPU T4 time to runner

How long a `backmesh-gpu-t4` job waits for its spot T4 VM, cold: no cue, no
runner idle on the label. It checks the v0.4.3 launch claim of 19 minutes
(rc.1, [backmesh-dryrun/gpu-check run 44415113281](https://github.com/backmesh-dryrun/gpu-check/actions/runs/44415113281))
cut to 5 (rc.2, [run 44420415510](https://github.com/backmesh-dryrun/gpu-check/actions/runs/44420415510))
by the `g4dn.2xlarge` fallback and `REQUEUE_HOLD_MS`, one sample each.

[`target/gpu-t4.yml`](target/gpu-t4.yml) is the job: one step reads the VM's
instance metadata (type, zone, lifecycle and the identity document's
`pendingTime`, when EC2 launched it), one runs `nvidia-smi -L`. It ran from
a throwaway `gpu-t4-bench` branch of this repository, deleted after, as its
`.github/workflows/gpu-t4.yml`: one empty commit a sample, 18 minutes apart,
so no VM from the last sample was left.

## Results

Measured on 2026-11-21, 17:10 to 19:57 UTC, on backmesh's own CI installation
(org `backmesh`, backmesh v0.5.1, anycloud 0.1.79, AWS runner regions
us-east-2, us-east-1 and us-west-2), 10 samples. The median is the mean of the middle two; p90
is the nearest rank (the 9th of 10). Times are whole seconds from GitHub's job and step times and
EC2's `pendingTime`.

| AWS, 10 samples      | Median  | p90   | Min   | Max   |
| -------------------- | ------- | ----- | ----- | ----- |
| Queued to started    | 130.5 s | 138 s | 118 s | 139 s |
| Queued to VM launch  | 8.5 s   | 10 s  | 8 s   | 10 s  |
| VM launch to started | 122 s   | 128 s | 109 s | 131 s |
| Queued to first step | 132 s   | 139 s | 119 s | 140 s |

Every sample got a spot `g4dn.xlarge` in us-west-2b, the first type in the
label's list, in the cheapest of its regions (anycloud places a runner
there first). None met a capacity refusal: EC2 launched each VM 8 to 10 s
after GitHub queued the job, too soon for a refusal and a retry. The wait is
the VM's boot and the runner's start, about 2 minutes. The launch posts'
19-minute rc.1 wait was a spot refusal in every region with no fallback
type; with no refusal, nothing here exercises the fallback or
`REQUEUE_HOLD_MS`, so these figures are the no-refusal case, not a measure
of either fix.

**Azure: not measured.** The Azure CI subscription the e2e test org installs
into has 3 spot vCPUs a region, under one 4-vCPU `Standard_NC4as_T4_v3`.
v0.5.2's install plan
([run 44864091413](https://github.com/backmesh/backmesh/actions/runs/44864091413), Azure leg)
says so: "backmesh-gpu-t4 would start no runners: every runner region's spot
quota is under one 4-vCPU runner". Measuring it needs "Total Regional
Low-priority vCPUs" raised to at least 4 in one of centralus, eastus,
eastus2, southcentralus, westus2 or westus3.

| Sample | Run                                                                          | Queued   | VM launch | Started  | First step | Wait  |
| ------ | ---------------------------------------------------------------------------- | -------- | --------- | -------- | ---------- | ----- |
| 1      | [44928540397](https://github.com/backmesh/backmesh/actions/runs/44928540397) | 17:10:02 | 17:10:10  | 17:12:21 | 17:12:22   | 139 s |
| 2      | [44930453316](https://github.com/backmesh/backmesh/actions/runs/44930453316) | 17:30:53 | 17:31:03  | 17:33:03 | 17:33:04   | 130 s |
| 3      | [44932082307](https://github.com/backmesh/backmesh/actions/runs/44932082307) | 17:48:55 | 17:49:04  | 17:50:53 | 17:50:54   | 118 s |
| 4      | [44933724439](https://github.com/backmesh/backmesh/actions/runs/44933724439) | 18:06:56 | 18:07:05  | 18:09:06 | 18:09:08   | 130 s |
| 5      | [44935402210](https://github.com/backmesh/backmesh/actions/runs/44935402210) | 18:24:58 | 18:25:06  | 18:27:02 | 18:27:03   | 124 s |
| 6      | [44937025514](https://github.com/backmesh/backmesh/actions/runs/44937025514) | 18:42:59 | 18:43:09  | 18:45:17 | 18:45:18   | 138 s |
| 7      | [44938626804](https://github.com/backmesh/backmesh/actions/runs/44938626804) | 19:01:02 | 19:01:10  | 19:03:16 | 19:03:18   | 134 s |
| 8      | [44940274944](https://github.com/backmesh/backmesh/actions/runs/44940274944) | 19:19:03 | 19:19:11  | 19:21:15 | 19:21:16   | 132 s |
| 9      | [44941890320](https://github.com/backmesh/backmesh/actions/runs/44941890320) | 19:37:05 | 19:37:13  | 19:39:16 | 19:39:17   | 131 s |
| 10     | [44943481198](https://github.com/backmesh/backmesh/actions/runs/44943481198) | 19:55:06 | 19:55:15  | 19:57:10 | 19:57:12   | 124 s |

Wait is queued to started. Each ran in us-west-2b on a spot `g4dn.xlarge`.

## Running it

Push `target/gpu-t4.yml` as `.github/workflows/gpu-t4.yml` to a
`gpu-t4-bench` branch of a repository in an org with a backmesh
installation, then one empty commit a sample, at least 15 minutes apart.
Read each job's `created_at` and `started_at` and its `Instance` notice;
delete the branch after. Cost: about 2.5 minutes of a `g4dn.xlarge` spot
VM a sample, about $0.015 at $0.27 to $0.37 an hour with its disk.
