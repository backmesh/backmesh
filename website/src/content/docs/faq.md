---
title: FAQ
description: What backmesh is, and its platforms, installing, start times, isolation, capacity and cost.
head:
  - tag: title
    content: 'backmesh FAQ: open source, platforms, start times, security and cost'
---

## What is backmesh?

**What is backmesh?** backmesh runs self-hosted GitHub Actions runners on spot VMs in
your own AWS, GCP and Azure accounts. One `backmesh install` sets it up for a
GitHub org. Each job then gets its own VM, which is deleted when the job ends.

**Is backmesh open source?** Yes. backmesh is free and open source under the
Apache License 2.0, and its cache action is under the MIT License. The source
is at [backmesh/backmesh](https://github.com/backmesh/backmesh). backmesh
charges no license or per-minute fee; your clouds bill you for the VMs.

**Did backmesh have paid plans?** Early releases did: v0.2.0 announced paid
plans, and v0.3.0 charged for them after a trial. v0.3.2 removed them, and v0.4.0 made backmesh open
source. The [changelog](/changelog/) has each release.

**Was backmesh an LLM API proxy?** Earlier, yes. Before it ran GitHub Actions
runners, the backmesh name was used for a backend that protected LLM API keys
in apps, now archived at
[backmesh/llm-proxy](https://github.com/backmesh/llm-proxy). backmesh now runs
GitHub Actions runners.

**How does backmesh compare with GitHub-hosted runners?** A workflow changes
only its `runs-on`. Its jobs run on spot VMs in your accounts. In our [build
benchmarks](/benchmarks/), builds ran up to 2× faster and 5× cheaper, and your cloud credits apply. Each job waits for its VM to boot, and only
Linux x86-64 jobs in private repositories can use the runners.

**Which clouds does backmesh run on?** AWS, Google Cloud (GCP) and Azure. One installation can use
several, and each [label](/labels/) runs in exactly one cloud: `backmesh-4` in
the control plane's, `backmesh-gcp-4` in GCP.

## Will it work?

**Which platforms does backmesh support?** Linux x86-64 only. There are no macOS, Windows or Arm
runners. Jobs that need `/dev/kvm` use the
[KVM labels](/labels/#kvm), and jobs that need an NVIDIA GPU the
[GPU labels](/labels/#gpu) on AWS and Azure.

**How do backmesh's GPU runners compare with GitHub's?** Same shape: one Tesla
T4 and 4 vCPUs, with 16 GiB of memory on AWS to GitHub's 28 GB. At list prices
(arithmetic, not measured; read 2026-11-18), GitHub's Linux GPU runner costs
$0.052 a minute. `backmesh-gpu-t4` costs about $0.0046 a minute on AWS spot
and $0.0029 on Azure spot, and `backmesh-gpu-od-t4` $0.0088 on demand: 6 to 18
times less, before disks and boots. See [Cost](/cost/#gpu).

**Can public repositories use backmesh?** Not yet. Only private repositories can use the runners. In a public repository, anyone can open a pull request whose workflow runs on a runner, and a runner's VM can reach your other instances in its cloud network. Support waits for runners with a network of their own.

**Will my `ubuntu-latest` jobs work on backmesh?** Most do with only a new `runs-on`. The
image is Ubuntu 24.04, has no systemd or swap, and lacks some of GitHub's
preinstalled toolchains, which setup actions add. See
[Coming from ubuntu-latest](/from-ubuntu-latest/).

**Does a backmesh job move to another cloud when its cloud is short of spot capacity?** No. Each
[label](/labels/) runs in one cloud. When a VM type has no spot capacity, the
job's VM is the next VM type in the same cloud.

**What happens when a backmesh job's spot VM is reclaimed?** The job fails, and a check run on
the commit lists every reclaimed job. When reclaims were the run's only
failures, backmesh reruns its failed jobs once the run finishes, preferring an
on-demand runner, at most twice. When it can't rerun them (the job uses
`backmesh-noretry`, the run is already on its third attempt, or the App lacks
Actions: write), the check run says to rerun them from the Actions tab. When
another job failed too, backmesh reruns nothing; rerun the failed jobs as
usual. See [on demand](/labels/#on-demand).

**Can I add a cloud to backmesh later?** Yes: run `backmesh install` again with
`--runners <cloud>` for each cloud, the new one included.
[More](/upgrade/#run-install-again).

**Does backmesh keep a Docker layer cache between jobs?** No: each job starts on a new
VM, so no image layers carry over.

## Installing

**Can I install backmesh when my org restricts OAuth apps?** Yes. An org with
OAuth app access restrictions, the default for a new org, refuses install's
sign-in until backmesh is allowed. On GitHub's sign-in page, an org owner clicks
**Grant** next to the org. Anyone else clicks **Request**, and an org owner
approves it at
`https://github.com/organizations/<org>/settings/oauth_application_policy`;
backmesh isn't listed there until someone has requested it. Then run install
again.

**Where does backmesh put its control plane?** With several cloud CLIs signed in and no
`--control-plane`, install picks the first of AWS, GCP and Azure, and the plan
says so. At a terminal, install asks for each choice you didn't pass, its
default filled in, then shows the plan and asks to proceed; `--yes` and
`--plan` never ask. Without a terminal, pass `--control-plane`; `--plan` shows
where install would put it. The control plane stays in its region.

**Which regions does backmesh run jobs in by default?** A fixed list per
cloud, not discovered or chosen: every US region whose catalog offers every
VM type backmesh's labels use, narrowed to the ones your account allows.
[More](/install/#regions).

**Can several orgs share one backmesh control plane?** Yes, when they have the same owner:
run install with the other org and the same `--control-plane`. An admin of that
org signs in, and install adds only that org's listener. Its plan says the org
joins the others' control plane, and that every org on it must have the same
owner: their runners use the same cloud connections, and each org's listener
can read the others' install keys. Agreeing to the plan agrees to that. Run it
from the machine that installed the first org, so the plan can see them. From
another machine, install finds them only once it reaches the control plane, and
stops before adding the org, for a new plan; at a terminal, it asks instead.
Orgs with different owners need separate installations. The orgs share the
control plane's cap of 500 runners at a time, first come, first served.

**What happens when a cloud quota is too low for backmesh?** If your cloud CLI can't read the install
region's quotas, install says why, shows them as unread, and goes on. It can't
read GCP's quotas, so it names the ones to raise. Runners past a quota wait,
sometimes for many minutes, until earlier VMs end, and `backmesh status` shows
that wait. A region whose quota can't fit one VM of a label, such as an AWS
region at its default 5 vCPUs for `backmesh-8`, stays in the install but gets
none of that label's runners. Install's plan names it and the quota to raise,
and so does `backmesh status`. Once you raise the quota, the region is used
within about 10 minutes, with nothing to reinstall.

## How fast do jobs start?

**How long does a backmesh job wait for its VM?** Each job gets a new VM, which takes
about 30 seconds to boot on AWS and 60 to 70 seconds on GCP and Azure. For a
run's later jobs, backmesh learns each workflow's shape and starts runners ahead
of predicted jobs, which mostly hides that. This has no settings,
and [`backmesh status`](/status/) shows only counts: the runners started ahead
and the workflows learned. A runner started ahead that no job takes is soon
removed.

**Can a workflow run's first jobs start sooner on backmesh?** Yes, when your coding agent cues
backmesh. The [agent instructions](/SKILL.md) have it run
`backmesh cue --in <seconds>` when its pre-push checks start, with the seconds
until it expects to push, 30 to 600 (60 or more recommended), and
`backmesh cue --cancel` if it won't push soon. backmesh then starts
runners for the run's first jobs too. A cue
tells api.backmesh.com your org, your GitHub user and the time, with a random
tag for the push that names no repo or branch ([Telemetry](/telemetry/#cues)).
It sends the repo and branch only encrypted to your listener's key, so
api.backmesh.com can't read them, and never the commit. The agent pushes even
if `cue` fails: when backmesh.com is down, the cue is dropped and CI runs cold,
as it would without one.

**Can a coding agent in a sandbox cue backmesh?** Yes, with a copied sign-in. A sandbox that starts fresh each time can't
keep a sign-in. A human can copy one from a machine where backmesh is signed
in, `~/.backmesh/anycloud/.token`, into the sandbox's secrets as
`BACKMESH_CUE_TOKEN`, which `backmesh cue` uses first. It is that human's full
backmesh sign-in, not a cue-only key, so keep it secret; a later sign-in on
that machine can revoke it.

## Is it safe?

See the [security model](/security/): what runs where, the GitHub App's
permissions, what its key can do, and the one trust level that jobs from
every repository share.

## What does it cost?

**backmesh's price:** backmesh is free and open source, with no credit card
required and no cap on jobs.
Premium adds Slack monitoring, logs and runtime history; see
[pricing](/#pricing).

**Your clouds** bill you directly for the VMs, disks and the checkpoint bucket.
Install prints what they cost before it creates anything.

**Before any job runs:** runners have no VM while idle, so an idle installation
pays only for the control plane's two VMs: about $86 a month on AWS, $74
on GCP and $111 on Azure, with their disks and public addresses. Each job's VM
bills from its boot until the job ends, so every job also pays for its boot:
about 30 seconds on AWS and 60 to 70 seconds on GCP and Azure. A runner
started ahead of predicted jobs that no job takes bills for its boot and a short
idle time.
These are estimates from cloud list prices; spot prices change by the hour.
[Cost](/cost/) shows how the landing page's comparison is computed.
