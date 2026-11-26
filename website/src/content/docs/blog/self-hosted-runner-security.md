---
title: 'Are self-hosted GitHub Actions runners safe in your own cloud?'
description: What GitHub's own hardening guidance says about self-hosted runners, the risks in a private repository and a public one, ephemeral vs persistent runners, how ARC, terraform-aws-github-runner, RunsOn and backmesh isolate jobs, and a checklist.
date: 2026-11-26
lastUpdated: 2026-11-26
authors: backmesh
tags:
  - Guides
excerpt: Self-hosted runners can be safe for private repositories if every job gets a fresh machine, the runner holds no cloud credentials, and its network reaches nothing it doesn't need. GitHub's guidance, the risks one by one, how four tools isolate jobs, and a checklist.
head:
  - tag: title
    content: 'Self-hosted GitHub Actions runner security: risks and a checklist | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"Are self-hosted GitHub Actions runners safe in your own cloud?","datePublished":"2026-11-26","dateModified":"2026-11-26","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/self-hosted-runner-security/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Are self-hosted GitHub Actions runners safe?","acceptedAnswer":{"@type":"Answer","text":"For private repositories they can be, if each job gets a fresh machine deleted after the job, the machine holds no cloud credentials, and its network reaches nothing sensitive. GitHub''s secure use reference says self-hosted runners \"should almost never be used for public repositories\" because anyone can open a pull request and run code on them."}},{"@type":"Question","name":"What are the main security risks of self-hosted runners?","acceptedAnswer":{"@type":"Answer","text":"Persistent runners that carry state between jobs, fork pull requests in public repositories, secrets visible to other jobs on a shared machine, network reach into your VPC, cloud credentials served by the instance metadata service, leaked registration tokens, and the runner manager''s GitHub App key."}},{"@type":"Question","name":"Are self-hosted runners safe for private repositories?","acceptedAnswer":{"@type":"Answer","text":"Safer than for public ones, though GitHub still says to be cautious: anyone who can fork the repository and open a pull request, generally anyone with read access, can compromise a persistent runner and reach secrets and the GITHUB_TOKEN. Ephemeral runners and runner groups per trust level reduce that."}},{"@type":"Question","name":"What is the difference between ephemeral and persistent runners?","acceptedAnswer":{"@type":"Answer","text":"A persistent runner takes job after job on the same machine, so one job can leave files, processes or poisoned caches for the next. An ephemeral runner takes one job and is removed. GitHub recommends ephemeral runners for autoscaling and calls autoscaling with persistent runners \"not recommended\"."}},{"@type":"Question","name":"Can a self-hosted runner access my AWS or GCP account?","acceptedAnswer":{"@type":"Answer","text":"Yes, if the VM has an IAM instance profile, a GCP service account or an Azure managed identity, since any job can ask the metadata service for its credentials. It can also reach other instances in the same network whose firewall rules allow it. backmesh''s runner VMs have no cloud identity on any cloud; on AWS and GCP they share the default network, so use an account or project with nothing else in it."}},{"@type":"Question","name":"How long is a GitHub runner registration token valid?","acceptedAnswer":{"@type":"Answer","text":"One hour, per GitHub''s docs on adding self-hosted runners. A just-in-time (JIT) configuration from GitHub''s REST API is valid for one runner that performs at most one job."}},{"@type":"Question","name":"Does backmesh support public repositories?","acceptedAnswer":{"@type":"Answer","text":"Yes, with --public-repos. Pull requests from forks then run only on backmesh-ubuntu-2404-public-2vcpu and backmesh-ubuntu-2404-public-4vcpu, capped at 32 vCPUs across the org and 60 minutes per job, and they read the cache without saving to it. Their VMs share your runners'' cloud network on AWS and GCP, and GitHub''s \"Require approval for all external contributors\" setting is required."}},{"@type":"Question","name":"What can backmesh''s GitHub App key do in my org?","acceptedAnswer":{"@type":"Answer","text":"backmesh holds the App''s private key outside your accounts. In your org, whoever holds it can register a runner in any runner group and take the jobs routed to it, with their code and secrets, and with Actions write can rerun, cancel or dispatch workflows, approve fork runs and change a repository''s OIDC subject claim. It can''t read code or Secrets through GitHub''s API. Suspending or uninstalling the App in your org''s settings cuts it off at once."}},{"@type":"Question","name":"Is a GitHub-hosted runner more secure than a self-hosted one?","acceptedAnswer":{"@type":"Answer","text":"GitHub-hosted runners run each job in a fresh, isolated VM that GitHub manages, outside your network. A self-hosted ephemeral VM gives the same one-job isolation, but it runs in your network and you are responsible for what it can reach. In both cases a job can leak its own secrets and token."}}]}]}'
---

Self-hosted GitHub Actions runners in your own AWS, GCP or Azure account can be
safe for private repositories, on three conditions: every job gets a fresh
machine that is deleted when the job ends, the runner holds no cloud
credentials, and the runner's network reaches nothing you wouldn't hand to
anyone who can push code. For public repositories the risk is higher, because
anyone can open a pull request. GitHub's own guidance says self-hosted runners
"should almost never be used for public repositories". What's left after you
meet those conditions is the trust you place in the code your org's members
push and in whatever manages your runners.

Every quote and setting below links to its source, read on 2026-11-26.

## What GitHub says

GitHub's [secure use reference](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners)
has a section on hardening self-hosted runners. It starts with the difference
from GitHub's own machines:

> GitHub-hosted runners execute code within ephemeral and clean isolated
> virtual machines, meaning there is no way to persistently compromise this
> environment [...] Self-hosted runners for GitHub do not have guarantees around
> running in ephemeral clean virtual machines, and can be persistently
> compromised by untrusted code in a workflow.

On public repositories it says self-hosted runners "should almost never be
used for public repositories on GitHub, because any user can open pull
requests against the repository and compromise the environment."

Private repositories aren't exempt. The same section says to "be cautious when
using self-hosted runners on private or internal repositories, as anyone who
can fork the repository and open a pull request (generally those with read
access to the repository) are able to compromise the self-hosted runner
environment, including gaining access to secrets and the `GITHUB_TOKEN`".

It asks two questions about each runner machine: "What sensitive information
resides on the machine configured as a self-hosted runner?" and "Does the
machine have network access to sensitive services? For example, Azure or AWS
metadata services."

For org-level runners it warns that "GitHub can schedule workflows from
multiple repositories onto the same runner", and suggests runner groups to
limit which repositories reach which runners. For cloud access it recommends
OpenID Connect "to create short-lived, well-scoped access tokens for your
workflow runs".

On autoscaling, GitHub's
[self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#ephemeral-runners-for-autoscaling)
says: "GitHub recommends implementing autoscaling with ephemeral self-hosted
runners; autoscaling with persistent self-hosted runners is not recommended."
The secure use page adds that just-in-time (JIT) runners "perform at most one
job before being automatically removed", and that "Re-using hardware to host
JIT runners can risk exposing information from the environment."

## The risks, one by one

| Risk                            | What can go wrong                                                                                       | What reduces it                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Persistent runners              | One job leaves a process, a modified tool or a poisoned cache on the machine; the next job runs with it | A fresh VM per job, deleted when the job ends                                                       |
| Fork pull requests              | Anyone with a GitHub account runs code on your runner in a public repository                            | Keep public repositories off self-hosted runners, or require approval for every outside contributor |
| Secrets exposure                | A job reads another job's secrets on a shared machine, or a privileged trigger runs a fork's code       | One job per machine; no `pull_request_target` that checks out fork code                             |
| Network reach                   | A job reaches databases, internal services or other instances in the same VPC or network                | A cloud account or network that holds nothing but runners                                           |
| Cloud credentials on the runner | The metadata service hands the job the instance's IAM role, service account or managed identity         | Runners with no cloud identity, or a role scoped to almost nothing; OIDC for deploys                |
| Runner registration tokens      | A leaked token registers a runner that takes your jobs                                                  | JIT configurations, valid for one job                                                               |
| The runner manager's own access | Whoever holds the manager's GitHub App key can register runners and take jobs                           | Know where that key lives, watch the org's audit log, know how to suspend the App                   |

### Persistent runners carry state between jobs

A runner that takes more than one job is shared mutable state. A job can leave
a background process, replace a binary on the `PATH`, edit the runner's tool
cache or write to a directory the next job reads. GitHub's page gives an
example that needs no persistence at all: "Some jobs will use secrets as
command-line arguments which can be seen by another job running on the same
runner, such as `ps x -w`."

GitHub also warns that destroying a runner after each job is weaker than it
sounds, since "there is no way to guarantee that a self-hosted runner only runs
one job." Ephemeral or JIT registration closes that gap: GitHub assigns the
runner one job and removes it.

### Pull requests from forks

In a public repository, anyone can fork it and open a pull request, and the
`pull_request` workflow then runs the fork's code. GitHub gives that run no
secrets and a read-only token, but on a self-hosted runner the code still runs
on your machine, in your network. GitHub's
[runner setup page](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
says: "We recommend that you only use self-hosted runners with private
repositories." It also notes that "public repositories can't use runners in a
runner group by default."

GitHub's default approval setting only asks for approval from first-time
contributors. Its
[Actions settings page](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#controlling-changes-from-forks-to-workflows-in-public-repositories)
warns that a user with any commit or pull request merged into the repository
skips that check, for example with "a simple typo or other innocuous change". Security
researchers used that route to reach the self-hosted runners of
[GitHub's runner-images repository](https://adnanthekhan.com/2023/12/20/one-supply-chain-attack-to-rule-them-all/)
in 2023 and
[PyTorch](https://johnstawinski.com/2024/01/11/playing-with-fire-how-we-executed-a-critical-supply-chain-attack-on-pytorch/)
in 2024.

### Secrets and privileged triggers

Some triggers run your default branch's workflow with its secrets, even when an
outsider starts them. GitHub's
[good practices](https://docs.github.com/en/actions/reference/security/secure-use#good-practices)
say to "Avoid using the `pull_request_target` and `workflow_run` workflow
triggers with untrusted pull requests or code content", and that "Workflows
that use these triggers must not explicitly check out untrusted code". This
applies on any runner. On a self-hosted one, a compromise also lands inside
your cloud account.

### Network reach into your VPC

A runner in your cloud sits in a network. If that is the default VPC on AWS or
the `default` network on GCP, and other instances there admit traffic from the
network's range, a job can reach them. On GCP, a default network carries the
`default-allow-internal` firewall rule unless you removed it. Any job your
org's members can push becomes a client of those services.

### Cloud credentials on the runner

If the runner VM has an IAM instance profile, a GCP service account or an
Azure managed identity, any job can ask the metadata service for its
credentials. A role broad enough to start and stop VMs, read buckets or pull
images is then available to every job. GitHub names the AWS and Azure metadata
services in its hardening list for this reason. Deploys are better served by
[OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect),
which gives each workflow run a short-lived token from a role you scope per
repository.

### Runner registration tokens

A classic registration token, per GitHub's setup page, "expires after one
hour". A JIT configuration is valid for one runner and one job. The
[terraform-aws-github-runner security page](https://github-aws-runners.github.io/terraform-aws-github-runner/security/)
explains the gap for its non-ephemeral mode: the registration token is deleted
from SSM after use, "But the token remains valid and is potential available in
memory on the runner."

### The runner manager's own access

Every autoscaler needs GitHub credentials to register runners, usually a GitHub
App. Whoever holds that App's private key can register a runner in your org and
take jobs routed to it, with their code and secrets. Where that key lives, and
who else can reach it, is part of your risk.

## Ephemeral vs persistent runners

| Question                                   | Persistent runner                                  | Ephemeral runner (one job, then removed)         |
| ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------ |
| Can one job affect the next?               | Yes, through files, processes and caches it leaves | No, if the machine is also new and deleted after |
| Can a compromise persist?                  | Yes, until someone rebuilds the machine            | Only for the length of the job                   |
| Secrets visible to other jobs on the host? | Possible (`ps x -w`, files, env dumps)             | No other job shares the machine                  |
| Registration                               | Registration token, valid one hour                 | JIT configuration, one job                       |
| Warm state (Docker layers, tool caches)    | Kept between jobs                                  | Lost, unless restored from a cache               |
| Start time                                 | None, the runner is waiting                        | A boot per job, unless runners are started ahead |
| GitHub's view                              | "not recommended" for autoscaling                  | Recommended                                      |

An ephemeral container
on a shared Kubernetes node is one job per runner, but the pod shares the
node's kernel with other pods. An ephemeral VM shares only the hypervisor.

## How four tools isolate jobs

All four run runners in your own cloud, and all four have a fixed cost for the
parts that stay on: a cluster, a set of Lambda functions and queues, a control
plane on Fargate, or always-on VMs. Each claim links to that tool's own docs,
read 2026-11-26.

|                              | [ARC](https://docs.github.com/en/actions/concepts/runners/actions-runner-controller)                                                                                              | [terraform-aws-github-runner](https://github-aws-runners.github.io/terraform-aws-github-runner/configuration/)                                 | [RunsOn](https://runs-on.com/docs/control-plane/security/)     | backmesh ([security](/security/))                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Unit per job                 | An ephemeral runner pod on a shared Kubernetes node                                                                                                                               | An EC2 instance; reused until idle by default                                                                                                  | Its own EC2 instance, terminated when the job ends             | Its own VM, deleted when the job ends                                  |
| Ephemeral by default         | Yes, runner scale sets register JIT runners                                                                                                                                       | No, [`enable_ephemeral_runners`](https://github.com/github-aws-runners/terraform-aws-github-runner/blob/main/variables.tf) defaults to `false` | Yes, single-use JIT registration                               | Yes                                                                    |
| Docker in jobs               | Docker-in-Docker [requires privileged mode](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets), or Kubernetes mode | The instance's Docker                                                                                                                          | The instance's Docker                                          | The VM's Docker; a job can be root on its own VM                       |
| Cloud identity on the runner | Set by your cluster and pod spec                                                                                                                                                  | An IAM role limited to its registration token, its own tags and terminating itself                                                             | A runner IAM role that can't read Secrets Manager; IMDSv2 only | None on any cloud                                                      |
| Inbound network              | Your cluster's network policy                                                                                                                                                     | Your VPC and security groups                                                                                                                   | No inbound rule unless you allow SSH                           | SSH only, with a key only the control plane holds                      |
| Where the GitHub App key is  | A Kubernetes secret, as recommended                                                                                                                                               | SSM Parameter Store in your AWS account                                                                                                        | AWS Secrets Manager in your account, in an App you create      | With backmesh, outside your accounts                                   |
| Public repositories          | Your configuration                                                                                                                                                                | Your configuration                                                                                                                             | A separate environment recommended                             | Off by default; with `--public-repos`, forks run only on public labels |

### Actions Runner Controller (ARC)

ARC is GitHub's Kubernetes operator. Its
[architecture page](https://docs.github.com/en/actions/concepts/runners/actions-runner-controller)
describes an EphemeralRunner controller that requests a JIT configuration for
each runner and deletes the runner when its job completes. Runners are pods, so
isolation between jobs is whatever your cluster gives pods on the same node.
GitHub's
[deployment guide](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets)
says "The Docker-in-Docker container requires privileged mode", recommends
creating runner pods in a different namespace from the operator, and says
"using a shared Kubernetes cluster for production workloads could pose a
security risk." Use ARC on a cluster that runs nothing but runners.

### terraform-aws-github-runner

This module runs runners on EC2 through Lambda functions. Its
[configuration docs](https://github-aws-runners.github.io/terraform-aws-github-runner/configuration/)
say "By default runners are reused, until detected idle", and that ephemeral
runners, which "are only used for one job", register with a JIT
configuration. Its
[security page](https://github-aws-runners.github.io/terraform-aws-github-runner/security/)
says instance permissions "are limited to retrieve and delete the registration
token, access the instance's own tags, and terminate the instance itself",
"we strongly suggest to use ephemeral runners", and that the example AMIs are
"not hardened, and sudo operations are not blocked." Turn on
`enable_ephemeral_runners` and build your own AMI.

### RunsOn

RunsOn runs jobs on EC2 in your AWS account. Its
[security page](https://runs-on.com/docs/control-plane/security/) says every
job gets "Its own instance. No other job has run on it, and it is terminated
when the job ends", a single-use JIT registration, a runner IAM role that
"cannot read Secrets Manager", no inbound rule unless you allow SSH, and IMDSv2
only. RunsOn's GitHub App is one you create in your own org, and "Its key is
stored in AWS Secrets Manager in your account, and RunsOn never sees it."

The same page says repositories on one stack share its cache bucket and runner
IAM role, recommends turning on cache isolation, which is off by default, and
says "For public repositories, use a separate environment." If you want no
third party to hold a GitHub App key for your org and you're on AWS only,
RunsOn's model is the better fit. See
[backmesh vs RunsOn](/blog/backmesh-vs-runs-on/) for the rest of the
comparison.

## How backmesh handles it

backmesh's [security model](/security/) puts everything it runs in your own
accounts: a control plane VM (t3.medium on AWS), one listener VM per org
(t3.small on AWS) that long-polls GitHub, so no inbound port or webhook is
needed, and a spot or on-demand VM for each job, deleted when the job ends.
Install connects each cloud with a role from your own cloud CLI session, so no
cloud keys are stored. Your code, secrets, caches and job logs go between
GitHub and the runners in your accounts and never reach backmesh.

### What a job can reach

From the [security page](/security/#what-a-job-can-reach):

- The runner VM has no cloud identity on any cloud: no IAM instance profile on
  AWS, no service account on GCP, no managed identity on Azure. The metadata
  service hands out no cloud credentials.
- The VM holds no backmesh or control-plane credential, only the job's own
  runner registration and its short-lived cache tokens.
- A job controls its VM's Docker, so it can be root on that VM for the length
  of the job.
- A runner admits only SSH, with a key only the control plane holds, so one job
  can't reach another job's VM.
- Egress to the internet is open.

The network is where backmesh leaves work to you. On AWS, runners use the
account's default VPC; on GCP, the project's `default` network. A job can reach
your other instances there whose firewall rules admit the network's range. On
GCP it can also read the project's metadata, such as SSH keys or startup
scripts set there. On Azure each runner gets a VNet of its own. backmesh's
advice is to use a cloud account or project with nothing else in its default
network. A separate network for runners is planned.

### One trust level per org

Every job that reaches backmesh's runner group is trusted the same way. Jobs
from every repository in the org use the same labels, so any repository in the
org can send jobs to the same runners as any other. Per-repository runner
groups are planned. Until then, run only code you'd trust your org's members to
run.

### The GitHub App key backmesh holds

This is the one credential that reaches your org from outside your accounts.
backmesh uses one public GitHub App with three permissions: Self-hosted
runners write, Actions write and Metadata read. It has no Contents, Secrets,
Members, Checks or Administration permission. backmesh holds the App's private
key as a secret of the service at `api.backmesh.com`. The listener never holds
it. It gets hour-long tokens for your org that are narrower than the App:
Self-hosted runners write, Actions read and Metadata read.

The [security page](/security/#the-github-app) spells out what the key can do
in your org, for backmesh or for anyone who stole it from backmesh. It can
register a runner in any of your org's runner groups and take the jobs routed
to it, with their code and secrets. With Actions write it can read runs and
logs; rerun, cancel or delete runs; approve fork pull requests' runs; dispatch,
enable or disable workflows; and change a repository's OIDC subject claim,
which cloud trust policies match on. Combined, it could dispatch or rerun a job
on a backmesh label and take it with its own runner. Through GitHub's API it
can't read code or Secrets or change Administration settings.

backmesh rotates the key. Everything the App does shows in your org's audit log
as `backmesh[bot]`, so watch for runners you don't expect. Suspending or
uninstalling the App in your org's settings cuts it off at once, and runners
stop scaling until you reinstall it. If the key leaks, backmesh replaces it and
tells every customer, since a token minted with it works for up to an hour.

What backmesh receives is listed on the [telemetry page](/telemetry/): one
event per job started describing the runner (cloud, VM type, label), with no
repository, workflow, branch or commit names.

### Public repositories and forks

By default only an org's private repositories can use backmesh's runners.
[`--public-repos`](/public-repos/) lets public repositories in, with these
limits:

- Pull requests from forks run only on `backmesh-ubuntu-2404-public-2vcpu` and
  `backmesh-ubuntu-2404-public-4vcpu`: spot VMs in the control plane's cloud,
  one job per VM, with no KVM and at most 32 vCPUs across the org.
- A fork run that asks for another backmesh label is cancelled.
- A fork's job that has run 60 minutes on a public label gets its run
  cancelled, and its runners are ended 5 minutes later if still running.
- Fork runs read the [cache](/cache/) and never save to it.

The same page lists what it doesn't do. On AWS and GCP the public runners share
your cloud network with your other runners. The label gate acts after GitHub
assigns the job, so an idle runner already up on another label can take a
fork's job until backmesh ends it. Events anyone can trigger in a public
repository, such as `issue_comment` or `pull_request_target`, aren't fork runs:
they run your default branch's workflow with its secrets, on any label. Fork
runs can restore what the default branch cached, so keep secrets out of cache
entries. backmesh requires GitHub's "Require approval for all external
contributors" setting for any org that turns this on.

### Limits that come with it

backmesh runs Linux x86-64 and arm64 jobs (arm64 on AWS and GCP), with no
macOS or Windows runners. Each job waits about 40 s for its VM to boot, about 10 s when cued; the
[benchmarks](/benchmarks/) carry the latest median wait. A spot VM can be reclaimed, which fails the job; when
reclaims were a run's only failures, backmesh reruns them, preferring an
on-demand runner ([labels](/labels/#on-demand)). The control plane and listener
VMs run all the time, about $56 a month on AWS, $50 on GCP and $68 on Azure
for one org ([cost](/cost/)).

## What risk remains

A fresh VM per job with no cloud identity removes the two worst cases on
GitHub's list: a compromise that persists into the next job, and cloud
credentials served from the metadata service. What stays:

- A job runs as root on its own VM for as long as it runs, with internet
  egress. It can exfiltrate anything that job was given: its secrets, its
  `GITHUB_TOKEN`, the code it checked out.
- Anyone who can push a workflow to any repository in the org can run code on
  the same labels as everyone else.
- On a shared default network, a job can reach other instances whose rules
  admit the network's range.
- Caches cross job boundaries by design. A poisoned dependency saved to a
  branch's cache is restored by later jobs on that branch, and on backmesh a
  pull request also reads its base branch's and the default branch's caches.
- The runner manager's GitHub credentials can register runners in your org.
  With backmesh, that key is held by backmesh. With ARC,
  terraform-aws-github-runner or RunsOn, it is in your account, and so is the
  job of protecting it.

None of this is specific to self-hosting. A GitHub-hosted job can also leak its
own secrets and token to the internet. The difference is that a self-hosted
runner sits in your network, so its reach is your responsibility.

## Checklist

1. Use ephemeral runners: one job per machine, a JIT registration, and a
   machine deleted when the job ends.
2. Keep public repositories off self-hosted runners. If they must use them,
   send fork pull requests to separate labels with no secrets and a capped
   size and runtime.
3. Set "Require approval for all external contributors" in the org's Actions
   settings, and read each outside pull request before you approve its run.
4. Don't check out or run a fork's code in `pull_request_target` or
   `workflow_run` workflows.
5. Give runner VMs no cloud identity, or one scoped to what the runner itself
   needs. Deploy with OIDC roles scoped per repository and branch.
6. Put runners in a cloud account, project or subscription that holds nothing
   else, or in a network no other instance shares.
7. Block or restrict the instance metadata service where your setup allows
   it, and on AWS require IMDSv2.
8. Split runners into runner groups by trust level, and limit which
   repositories reach each group.
9. Keep secrets out of caches, and don't let forks save caches.
10. Find where your runner manager's GitHub App key is stored, who can read
    it, and how to suspend the App. Watch the org's audit log for runners you
    didn't start.

## Questions

### Are self-hosted GitHub Actions runners safe?

For private repositories they can be, if each job gets a fresh machine deleted
after the job, the machine holds no cloud credentials, and its network reaches
nothing sensitive. GitHub's secure use reference says self-hosted runners
"should almost never be used for public repositories" because anyone can open a
pull request and run code on them.

### What are the main security risks of self-hosted runners?

Persistent runners that carry state between jobs, fork pull requests in public
repositories, secrets visible to other jobs on a shared machine, network reach
into your VPC, cloud credentials served by the instance metadata service,
leaked registration tokens, and the runner manager's GitHub App key.

### Are self-hosted runners safe for private repositories?

Safer than for public ones, though GitHub still says to be cautious: anyone who
can fork the repository and open a pull request, generally anyone with read
access, can compromise a persistent runner and reach secrets and the
`GITHUB_TOKEN`. Ephemeral runners and runner groups per trust level reduce
that.

### What is the difference between ephemeral and persistent runners?

A persistent runner takes job after job on the same machine, so one job can
leave files, processes or poisoned caches for the next. An ephemeral runner
takes one job and is removed. GitHub recommends ephemeral runners for
autoscaling and calls autoscaling with persistent runners "not recommended".

### Can a self-hosted runner access my AWS or GCP account?

Yes, if the VM has an IAM instance profile, a GCP service account or an Azure
managed identity, since any job can ask the metadata service for its
credentials. It can also reach other instances in the same network whose
firewall rules allow it. backmesh's runner VMs have no cloud identity on any
cloud; on AWS and GCP they share the default network, so use an account or
project with nothing else in it.

### How long is a GitHub runner registration token valid?

One hour, per GitHub's docs on adding self-hosted runners. A just-in-time (JIT)
configuration from GitHub's REST API is valid for one runner that performs at
most one job.

### Does backmesh support public repositories?

Yes, with `--public-repos`. Pull requests from forks then run only on
backmesh-ubuntu-2404-public-2vcpu and backmesh-ubuntu-2404-public-4vcpu, capped
at 32 vCPUs across the org and 60 minutes per job, and they read the cache
without saving to it. Their VMs share your runners' cloud network on AWS and
GCP, and GitHub's "Require approval for all external contributors" setting is
required.

### What can backmesh's GitHub App key do in my org?

backmesh holds the App's private key outside your accounts. In your org, whoever
holds it can register a runner in any runner group and take the jobs routed to
it, with their code and secrets, and with Actions write can rerun, cancel or
dispatch workflows, approve fork runs and change a repository's OIDC subject
claim. It can't read code or Secrets through GitHub's API. Suspending or
uninstalling the App in your org's settings cuts it off at once.

### Is a GitHub-hosted runner more secure than a self-hosted one?

GitHub-hosted runners run each job in a fresh, isolated VM that GitHub manages,
outside your network. A self-hosted ephemeral VM gives the same one-job
isolation, but it runs in your network and you are responsible for what it can
reach. In both cases a job can leak its own secrets and token.
