---
title: 'AWS CodeBuild GitHub Actions runners vs RunsOn vs backmesh'
description: AWS CodeBuild can run GitHub Actions jobs as self-hosted runners at $0.010 a minute for 4 vCPUs on demand in us-east-1. How it works, its compute types and prices, and how it compares with GitHub-hosted runners and spot VM runners from RunsOn and backmesh.
date: 2026-11-26
lastUpdated: 2026-11-26
authors: backmesh
tags:
  - Comparisons
excerpt: CodeBuild-hosted GitHub Actions runners bill per build minute with no always-on VMs, and run Linux, Arm, Windows and GPU jobs. At 4 vCPUs they cost $0.010 a minute on demand against $0.012 on GitHub and about $0.001 on spot VMs. Where each one is the better pick.
head:
  - tag: title
    content: 'AWS CodeBuild GitHub Actions runners vs RunsOn vs backmesh (2026 pricing) | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"AWS CodeBuild GitHub Actions runners vs RunsOn vs backmesh","datePublished":"2026-11-26","dateModified":"2026-11-26","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/codebuild-github-actions-runners-vs-backmesh/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"How much does an AWS CodeBuild GitHub Actions runner cost?","acceptedAnswer":{"@type":"Answer","text":"On demand in US East (N. Virginia), read 2026-11-26: $0.005 a minute for general1.small (2 vCPU), $0.010 for general1.medium (4 vCPU, 8 GiB), $0.020 for general1.large (8 vCPU, 16 GiB). Arm medium is $0.007 and Windows medium $0.018. Each build is rounded up to the nearest minute. Logs, S3 and data transfer bill separately."}},{"@type":"Question","name":"Is CodeBuild cheaper than GitHub-hosted runners?","acceptedAnswer":{"@type":"Answer","text":"A little, per minute. A 4-vCPU Linux job costs $0.010 a minute on CodeBuild general1.medium against $0.012 on GitHub linux_4_core, so 150,000 minutes cost $1,500 against $1,800. The CodeBuild machine has 8 GiB of memory to GitHub 16 GB. A 16 GiB CodeBuild machine is general1.large at $0.020 a minute."}},{"@type":"Question","name":"How do CodeBuild-hosted GitHub Actions runners work?","acceptedAnswer":{"@type":"Answer","text":"You create a CodeBuild runner project connected to a GitHub repository, or to an organization or enterprise through a global webhook. GitHub sends WORKFLOW_JOB_QUEUED events to CodeBuild, which starts one build per job running an ephemeral runner. The workflow sets runs-on to codebuild-<project-name>-${{ github.run_id }}-${{ github.run_attempt }}."}},{"@type":"Question","name":"Does CodeBuild support Windows, Arm and macOS GitHub Actions runners?","acceptedAnswer":{"@type":"Answer","text":"Windows and Arm, yes, on demand and on reserved capacity. macOS runs only on reserved capacity fleets of Apple M2 machines, which bill while provisioned, and the curated runner image list has no macOS image. backmesh runs Linux x86-64 and arm64 (arm64 on AWS and GCP)."}},{"@type":"Question","name":"Does CodeBuild offer spot pricing for GitHub Actions runners?","acceptedAnswer":{"@type":"Answer","text":"No. The CodeBuild price list has on-demand, reserved capacity and Lambda rates and no spot rate. Spot runners on EC2 come from tools that launch instances in your account, such as RunsOn or backmesh."}},{"@type":"Question","name":"What is CodeBuild reserved capacity?","acceptedAnswer":{"@type":"Answer","text":"A fleet of instances that CodeBuild keeps running for your builds, so builds start without provisioning. AWS says the machines are always running and incur costs as long as they are provisioned. A 4 vCPU, 8 GiB Linux instance costs $0.006 an instance minute in US East (N. Virginia), about $259 a month for one instance."}},{"@type":"Question","name":"When is CodeBuild better than backmesh or RunsOn?","acceptedAnswer":{"@type":"Answer","text":"When you run under about 10,000 4-vCPU minutes a month on AWS and want no always-on VMs, when you need Windows, Arm, GPU or macOS jobs, or when you want an AWS-managed service under your existing AWS support. Above that volume, spot VM runners cost less per minute."}},{"@type":"Question","name":"How many CodeBuild runners can run at once?","acceptedAnswer":{"@type":"Answer","text":"It depends on your account. The CodeBuild quotas page lists defaults per compute type, such as 1 concurrent build for Linux/Medium, says internal metrics set the defaults and that some types default to 20. The quotas are adjustable through Service Quotas."}},{"@type":"Question","name":"Do CodeBuild runners keep a cache between jobs?","acceptedAnswer":{"@type":"Answer","text":"CodeBuild has S3 caching and local caching with source, Docker layer and custom modes. A local cache lives on a build host and is available to that host only, Docker layer cache needs privileged mode on Linux, and local caching is not supported with a VPC, GPU or 2XLarge compute."}},{"@type":"Question","name":"Would the GitHub self-hosted runner fee apply to CodeBuild runners?","acceptedAnswer":{"@type":"Answer","text":"As announced, yes. CodeBuild registers its runners with GitHub as self-hosted runners, as RunsOn and backmesh do. GitHub postponed the $0.002 a minute fee in December 2025 and has set no new date, so self-hosted runner usage is free today."}}]}]}'
---

AWS CodeBuild can run GitHub Actions jobs as ephemeral self-hosted runners in
your AWS account, billed per build minute with nothing running between jobs. A
4-vCPU Linux job costs $0.010 a minute on CodeBuild's `general1.medium` in US
East (N. Virginia), against $0.012 on GitHub's 4-core runner and about $0.001
on a spot EC2 VM run by RunsOn or backmesh. CodeBuild is the better pick for
small AWS volumes and for Windows, Arm, GPU or macOS jobs. Above about 10,000
4-vCPU minutes a month, spot VM runners cost less, after their always-on VMs.

All CodeBuild facts below come from AWS's own docs and the
[CodeBuild pricing page](https://aws.amazon.com/codebuild/pricing/), read on
2026-11-26. Per-minute rates are from AWS's
[CodeBuild price list for us-east-1](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/CodeBuild/current/us-east-1/index.json)
(published 2026-09-11, read 2026-11-26). Other regions differ. backmesh
publishes this page.

## At a glance

|                    | AWS CodeBuild runner                                                       | [RunsOn](https://runs-on.com/pricing/)                                                                                                    | [backmesh](https://github.com/backmesh/backmesh)                               | GitHub-hosted                                                                                       |
| ------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Where jobs run     | CodeBuild-managed compute in your AWS account's region                     | EC2 in your AWS account                                                                                                                   | Spot VMs in your AWS, GCP or Azure account                                     | GitHub's machines                                                                                   |
| 4 vCPU Linux price | $0.010/min on demand (`general1.medium`, 8 GiB)                            | $0.0012/min, its figure for spot `m8a.xlarge` with 30 GB gp3, us-east-1, as listed on runs-on.com/pricing on 2026-11-26 (a 7-day average) | $0.00083 to $0.00117/min on AWS spot ([cost](/cost/))                          | $0.012/min ([docs.github.com](https://docs.github.com/en/billing/reference/actions-runner-pricing)) |
| Fixed monthly cost | None on demand; reserved fleets bill per instance minute while provisioned | License €300 to €3,600 a year for commercial use; control plane from about $7/mo                                                          | Always-on VMs, about $86/mo on AWS for one org                                 | None                                                                                                |
| Spot               | No spot rate in the price list                                             | Yes                                                                                                                                       | Yes, default, with [on-demand fallback](/labels/#on-demand-fallback)           | n/a                                                                                                 |
| Operating systems  | Linux x86, Arm, Windows, GPU; macOS on reserved fleets only                | Linux x64 and arm64, Windows, GPU                                                                                                         | Linux x86-64 and arm64 (arm64 on AWS and GCP); NVIDIA T4 GPUs on AWS and Azure | Linux, Windows, macOS, Arm, GPU                                                                     |
| How jobs arrive    | GitHub webhook (`WORKFLOW_JOB_QUEUED`) to a CodeBuild project              | See [backmesh vs RunsOn](/blog/backmesh-vs-runs-on/)                                                                                      | A listener VM long-polls GitHub; no webhook or inbound port                    | n/a                                                                                                 |
| Clouds             | AWS                                                                        | AWS                                                                                                                                       | AWS, GCP, Azure                                                                | GitHub                                                                                              |
| License            | AWS service                                                                | Commercial; free for non-commercial use                                                                                                   | Apache-2.0                                                                     | n/a                                                                                                 |

RunsOn's figures are from its [pricing page](https://runs-on.com/pricing/),
read 2026-11-26. For a full side-by-side of the two spot VM tools, see
[backmesh vs RunsOn](/blog/backmesh-vs-runs-on/).

## How CodeBuild-hosted GitHub Actions runners work

AWS's
[runner tutorial](https://docs.aws.amazon.com/codebuild/latest/userguide/action-runner.html)
sets it up in three steps.

1. Connect CodeBuild to GitHub with a personal access token, a Secrets
   Manager secret, an OAuth app or a GitHub App.
2. Create a CodeBuild project of type "Runner project", with GitHub as the
   runner provider and a repository as its location. CodeBuild creates a
   webhook on the repository that delivers workflow job events. By default a
   project receives `WORKFLOW_JOB_QUEUED` events for one repository; a global
   or organization webhook covers every repository in an org or enterprise.
3. Change each job's `runs-on` to name the project:

```yaml
runs-on: codebuild-<project-name>-${{ github.run_id }}-${{ github.run_attempt }}
```

For each queued job, CodeBuild starts a build that runs an ephemeral runner.
The runner takes that one job, and the runner and its build end when the job
does. The run ID lets CodeBuild stop the build when the workflow run is
cancelled. If the project name in the label doesn't match a project, AWS says
CodeBuild won't process the webhook and the workflow might hang.

The label can override the project's settings per job:

```yaml
runs-on:
  - codebuild-myProject-${{ github.run_id }}-${{ github.run_attempt }}
    image:arm-3.0
    instance-size:small
```

Other overrides pick a reserved capacity fleet (`fleet:<name>`), register the
runner at org or enterprise level (`organization-registration-name:`,
`enterprise-registration-name:`), pick a runner group
(`registration-group-id:`) or run the project's buildspec commands before the
runner starts (`buildspec-override:true`). With a buildspec override, a failed
`INSTALL` or `PRE_BUILD` command means the runner never starts and the job has
to be cancelled by hand.

The job runs on a CodeBuild image. The
[curated images](https://docs.aws.amazon.com/codebuild/latest/userguide/sample-github-action-runners-update-yaml.images.html)
are Amazon Linux 2 and 2023, Ubuntu 20.04 and 22.04 (`ubuntu-5.0` to
`ubuntu-7.0`), Arm Amazon Linux, Windows Server Core 2019 and 2022, and Lambda
images for Node.js, Python, Go, Java, .NET and Ruby. These differ from GitHub's
`ubuntu-latest` image, so jobs may need setup actions for missing tools, as
AWS's tutorial notes. Custom images work too.

## CodeBuild compute types and prices

On-demand EC2 compute, from the
[compute types page](https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-compute-types.html)
and the us-east-1 price list (read 2026-11-26):

| Compute type       | vCPU | Memory  | Disk         | Linux $/min | Arm $/min | Windows $/min |
| ------------------ | ---- | ------- | ------------ | ----------- | --------- | ------------- |
| `general1.small`   | 2    | 4 GiB   | 64 GB        | 0.005       | 0.0034    | n/a           |
| `general1.medium`  | 4    | 8 GiB   | 128 GB       | 0.010       | 0.007     | 0.018         |
| `general1.large`   | 8    | 16 GiB  | 128 GB       | 0.020       | 0.015     | 0.036         |
| `general1.xlarge`  | 36   | 72 GiB  | 256 GB       | 0.0798      | n/a       | 0.160         |
| `general1.2xlarge` | 72   | 144 GiB | 824 GB (SSD) | 0.200       | n/a       | 0.320         |
| `gpu1.small`       | 4    | 16 GiB  | 235 GB (SSD) | 0.050       | n/a       | n/a           |

Arm's XLarge and 2XLarge have different shapes from the x86 ones (32 vCPU and
48 vCPU), at $0.060 and $0.090 a minute. Lambda compute bills per second:
`lambda.x86-64.8GB` (4 vCPU) is $0.00016 a second, $0.0096 a minute, and AWS
says Lambda has lower start-up latency than EC2 compute.

The rest of the pricing, from the
[pricing page](https://aws.amazon.com/codebuild/pricing/):

- On-demand EC2 builds are rounded up to the nearest minute. Lambda builds are
  rounded up to the nearest second.
- The free tier is 100 build minutes a month on `general1.small` or
  `arm1.small`, and 6,000 build seconds on the 1 GB Lambda types. It doesn't
  expire after 12 months. Reserved capacity has no free tier, so a 4-vCPU job
  pays from its first minute.
- CloudWatch Logs, S3, KMS and data transfer bill separately.
- Each compute type has its own concurrency quota.
  [AWS's quotas page](https://docs.aws.amazon.com/codebuild/latest/userguide/limits.html)
  lists a default of 1 concurrent build for Linux/Medium and 0 for Linux GPU,
  says internal metrics set the defaults and that some types default to 20,
  and all are adjustable. Check yours before moving a busy workflow.

`general1.medium` has half the memory of GitHub's 4-core runner (8 GiB against
16 GB). A job that needs 16 GiB goes on `general1.large`, 8 vCPUs at $0.020 a
minute.

### Reserved capacity

A [reserved capacity fleet](https://docs.aws.amazon.com/codebuild/latest/userguide/fleets.html)
is a set of instances CodeBuild keeps running for your builds. AWS says the
machines "remain idle, ready to process builds or tests immediately", and that
"your machines are always running and will continue to incur costs as long as
they're provisioned". Each instance has a 60-minute minimum charge, and each
Mac instance a 24-hour minimum.

A 4 vCPU, 8 GiB Linux reserved instance (`reserved.x86-64.4cpu.8gib`) costs
$0.006 an instance minute in us-east-1, so $259.20 for a 30-day month. The
Windows one is $0.0108 and the Arm one $0.0042. macOS runs only on reserved
fleets, on Apple M2 machines with 8 or 12 vCPUs at $0.020 and $0.036 an
instance minute, and on-demand fleets don't support it. The runner's curated
image list has no macOS image, so check AWS's docs before planning macOS jobs
on a CodeBuild runner.

Reserved fleets can scale when demand exceeds capacity. AWS also notes that
data cached on fleet instances, such as source files and Docker layers, can be
reached by other projects in the same account.

## Cost at 150,000 minutes a month

Same workload as backmesh's [cost page](/cost/): 150,000 minutes a month of
4-vCPU Linux jobs. This is arithmetic at list prices; none of it was measured.

| Option                                 | Rate                        | 150,000 minutes | Fixed                 | Month          |
| -------------------------------------- | --------------------------- | --------------- | --------------------- | -------------- |
| GitHub-hosted `linux_4_core`           | $0.012/min                  | $1,800          | none                  | $1,800         |
| CodeBuild on demand, `general1.medium` | $0.010/min                  | $1,500          | none                  | $1,500         |
| CodeBuild on demand, `general1.large`  | $0.020/min (8 vCPU, 16 GiB) | $3,000          | none                  | $3,000         |
| CodeBuild Lambda, `lambda.x86-64.8GB`  | $0.0096/min                 | $1,440          | none                  | $1,440         |
| CodeBuild reserved, `4cpu.8gib`        | $0.006/instance min         | n/a             | 4 instances × $259.20 | $1,037 or more |
| backmesh on AWS spot                   | $0.00083–$0.00117/min       | $124–$175       | $86 always-on VMs     | $210–$261      |
| backmesh on Azure spot                 | $0.00053–$0.00064/min       | $80–$95         | $111 always-on VMs    | $191–$206      |

The reserved row is a floor: 150,000 minutes need at least 3.5 instances
running all month (150,000 ÷ 43,200), so 4, and peaks at the start of the
workday need more. backmesh's figures are from its [cost page](/cost/), with
spot prices from 2026-11-13 and GitHub's price read 2026-11-05; they leave out
disks and VM boots. RunsOn's own figure for a spot `m8a.xlarge`, $0.0012 a
minute with disk, gives $180 for the minutes, plus its control plane from about
$7 a month and its license for commercial use
([pricing](https://runs-on.com/pricing/)).

### Where the lines cross

backmesh's always-on VMs cost about $86 a month on AWS for one org. Against
CodeBuild's $0.010 a minute, a backmesh spot minute saves about $0.009, so the
fixed cost is paid back at roughly 9,400 to 9,700 minutes a month ($86 ÷
($0.010 − $0.00083) to $86 ÷ ($0.010 − $0.00117)). Below about 10,000
4-vCPU minutes a month, CodeBuild on demand costs less. Every self-hosted
runner tool with a control plane in your account has a fixed cost of this kind;
RunsOn's starts from about $7 a month plus its license.

CodeBuild's 100 free minutes apply only to the 2-vCPU and 1 GB Lambda types, so
they don't change a 4-vCPU estimate.

## Start times and caching

AWS doesn't publish a provisioning time for on-demand CodeBuild runners. It
says reserved fleet machines are ready to process builds immediately, that
Lambda compute starts faster than EC2, and that a pinned image version (such
as `5.0-1.0.0` instead of `5.0`) skips the cached image and can make builds
take longer.

CodeBuild has two cache types,
[S3 and local](https://docs.aws.amazon.com/codebuild/latest/userguide/build-caching.html).
A [local cache](https://docs.aws.amazon.com/codebuild/latest/userguide/caching-local.html)
is stored on a build host and is available to that host only, and AWS says it
isn't the best option for infrequent builds. Its modes are source, Docker layer
and custom. Docker layer cache is Linux only and needs privileged mode. Local
caching isn't supported with a VPC, with GPU compute or with `general1.2xlarge`.

backmesh's runners have no warm machines. Each job waits for its VM to boot;
the [benchmarks](/benchmarks/) have the latest median wait on AWS. backmesh
learns each workflow's shape and starts runners ahead of a run's later jobs,
and a coding agent can run `backmesh cue` to start them before a push. Each job
starts on a new VM, so no Docker image layers carry over between jobs.
backmesh's [cache](/cache/) keeps caches in a bucket in your own cloud, next to
the runners, and caches `setup-*` tools and npm, Yarn and pnpm downloads with no
workflow change.

## Spot reclaims and on demand

CodeBuild has no spot rate, so its jobs aren't reclaimed. A spot VM can be.
On backmesh, a reclaimed job fails, and when reclaims were a run's only
failures, backmesh reruns the failed jobs once the run finishes, preferring an
on-demand runner, at most twice. When a cloud has no spot capacity for a
label, its runners fall back to on-demand VMs, which cost about 1.7 to 5.4
times spot ([labels](/labels/#on-demand)). Jobs that mustn't be interrupted
use the `-od-` labels, such as `backmesh-ubuntu-2404-od-4vcpu`.

## Which to pick

Pick CodeBuild if:

- You run fewer than about 10,000 4-vCPU minutes a month and want no
  always-on VMs at all.
- You need Windows, Arm or GPU jobs on AWS, or macOS on a reserved fleet.
- You want an AWS-managed service, billed on your AWS invoice under your
  existing AWS support, with no extra tool to install or upgrade.
- Your jobs need a warm machine from the first second, and you can pay for a
  reserved fleet while it's idle.

Pick RunsOn if you want spot EC2 runners on AWS with Windows, arm64 or GPU
support, and its license fits your budget
([pricing](https://runs-on.com/pricing/)).

Pick backmesh if your jobs are Linux x86-64 or arm64 and you run enough minutes that
spot prices outweigh the always-on VMs, if your runners belong on GCP, Azure or
several clouds, or if you want an Apache-2.0 tool with no license fee. Its
4-vCPU label has 16 GiB of memory, as GitHub's 4-core runner does. It doesn't
run Windows or macOS, its arm64 labels are on AWS and GCP, its GPU labels are
NVIDIA T4 on AWS and Azure only, it runs private repositories unless you turn
on [public repositories](/public-repos/), a job waits about 40 s for its VM to boot, about 15 s when
cued, and it works with github.com only, with no GitHub Enterprise Server
support yet.

All three take jobs by `runs-on` label, so they can run side by side: Windows
jobs on CodeBuild, Linux jobs on spot VMs, and the rest on GitHub-hosted
runners. [Coming from ubuntu-latest](/from-ubuntu-latest/) lists what changes
when Linux jobs move to backmesh.

## The self-hosted runner fee

CodeBuild registers its runners with GitHub as self-hosted runners, as RunsOn
and backmesh do. GitHub announced a $0.002 a minute fee for self-hosted runners
in private repositories in December 2025 and postponed it the next day, with no
new date. If it returns as announced, it would apply to all three in the same
way. See [GitHub's self-hosted runner fee](/blog/github-self-hosted-runner-fee/).

## Questions

### How much does an AWS CodeBuild GitHub Actions runner cost?

On demand in US East (N. Virginia), read 2026-11-26: $0.005 a minute for
`general1.small` (2 vCPU), $0.010 for `general1.medium` (4 vCPU, 8 GiB) and
$0.020 for `general1.large` (8 vCPU, 16 GiB). Arm medium is $0.007 and Windows
medium $0.018. Each build is rounded up to the nearest minute. Logs, S3 and
data transfer bill separately.

### Is CodeBuild cheaper than GitHub-hosted runners?

A little, per minute. A 4-vCPU Linux job costs $0.010 a minute on CodeBuild
`general1.medium` against $0.012 on GitHub's `linux_4_core`, so 150,000 minutes
cost $1,500 against $1,800. The CodeBuild machine has 8 GiB of memory to
GitHub's 16 GB. A 16 GiB CodeBuild machine is `general1.large` at $0.020 a
minute.

### How do CodeBuild-hosted GitHub Actions runners work?

You create a CodeBuild runner project connected to a GitHub repository, or to
an organization or enterprise through a global webhook. GitHub sends
`WORKFLOW_JOB_QUEUED` events to CodeBuild, which starts one build per job
running an ephemeral runner. The workflow sets `runs-on` to
`codebuild-<project-name>-${{ github.run_id }}-${{ github.run_attempt }}`.

### Does CodeBuild support Windows, Arm and macOS GitHub Actions runners?

Windows and Arm, yes, on demand and on reserved capacity. macOS runs only on
reserved capacity fleets of Apple M2 machines, which bill while provisioned,
and the curated runner image list has no macOS image. backmesh runs Linux
x86-64 and arm64 (arm64 on AWS and GCP).

### Does CodeBuild offer spot pricing for GitHub Actions runners?

No. The CodeBuild price list has on-demand, reserved capacity and Lambda rates
and no spot rate. Spot runners on EC2 come from tools that launch instances in
your account, such as RunsOn or backmesh.

### What is CodeBuild reserved capacity?

A fleet of instances that CodeBuild keeps running for your builds, so builds
start without provisioning. AWS says the machines are always running and incur
costs as long as they're provisioned. A 4 vCPU, 8 GiB Linux instance costs
$0.006 an instance minute in US East (N. Virginia), about $259 a month for one
instance.

### When is CodeBuild better than backmesh or RunsOn?

When you run under about 10,000 4-vCPU minutes a month on AWS and want no
always-on VMs, when you need Windows, Arm, GPU or macOS jobs, or when you want
an AWS-managed service under your existing AWS support. Above that volume,
spot VM runners cost less per minute.

### How many CodeBuild runners can run at once?

It depends on your account. The CodeBuild quotas page lists defaults per
compute type, such as 1 concurrent build for Linux/Medium, says internal
metrics set the defaults and that some types default to 20. The quotas are
adjustable through Service Quotas.

### Do CodeBuild runners keep a cache between jobs?

CodeBuild has S3 caching and local caching with source, Docker layer and
custom modes. A local cache lives on a build host and is available to that
host only, Docker layer cache needs privileged mode on Linux, and local
caching isn't supported with a VPC, GPU or 2XLarge compute.

### Would the GitHub self-hosted runner fee apply to CodeBuild runners?

As announced, yes. CodeBuild registers its runners with GitHub as self-hosted
runners, as RunsOn and backmesh do. GitHub postponed the $0.002 a minute fee in
December 2025 and has set no new date, so self-hosted runner usage is free
today.
