---
title: Public repositories
description: What --public-repos lets public repositories do, what it doesn't protect against, and the setup it needs.
---

By default only an org's private repositories can use backmesh's runners.
`--public-repos` lets its public repositories use them too:

```sh
backmesh install --org <org> --public-repos
backmesh upgrade --public-repos
```

`--no-public-repos` takes it away again. `backmesh status` warns when the org
has public repositories whose jobs wait because the flag is off.

GitHub's own advice is that ["self-hosted runners should almost never be used
for public repositories"](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners),
because anyone who can open a pull request can run code on them. backmesh
narrows that risk but doesn't remove it. Read this page before you turn it on.

## What it does

- **The runner group allows public repositories.** A public repository's own
  runs, such as pushes and pull requests from its own branches, use every
  label, as a private repository's do.
- **Pull requests from forks run only on `backmesh-ubuntu-2404-public-2vcpu` and
  `backmesh-ubuntu-2404-public-4vcpu`.** These are spot VMs in the control plane's cloud, one
  job per VM, deleted when the job ends, with no KVM. Together they hold at
  most 32 vCPUs across the org; more fork jobs wait at GitHub.
- **A fork run that asks for another backmesh label is cancelled**, with a
  note on the run naming the labels it may use. backmesh.com makes the cancel
  with the App's Actions write ([Security](/security/#the-github-app)).
- **A fork's job that has run 60 minutes on a public label**, counted from
  its runner's start, gets its run cancelled, and the run's runners are ended
  5 minutes later if still running.
- **Fork runs read the [cache](/cache/) and never save to it.**

backmesh counts a run as a fork's when its event is `pull_request`,
`pull_request_review` or `pull_request_review_comment`, the repository is
public, and the pull request's head is in another repository or its head
repository was deleted.

## What it doesn't do

- **On AWS and GCP, the public runners share your cloud network.**
  `backmesh-ubuntu-2404-public-*` VMs run in the same account or project as your other
  runners: on AWS in the default VPC, in the shared `anycloud-vm` security
  group, and on GCP in the `default` network. A fork's job can reach your
  other instances there whose rules admit the network's range. On GCP that
  includes any instance covered by `default-allow-internal`, which a default
  network has unless you removed it. On Azure each runner gets a VNet of its
  own. On every cloud, a runner admits only SSH, with a key only backmesh's
  control plane holds, so one job can't reach another's VM, and egress to the
  internet is open. A separate network for runners is planned.
- **They have the same metadata access as other runners.** No runner VM has
  a cloud identity: no IAM instance profile on AWS, no service account on GCP,
  no managed identity on Azure, so the metadata service hands out no cloud
  credentials. It is still reachable, and on GCP it serves the project's
  metadata, such as SSH keys or startup scripts set there
  ([Security](/security/#what-a-job-can-reach)).
- **The label gate acts after GitHub assigns the job.** backmesh hears of a
  job when GitHub assigns it. It starts no runner for a fork's job on another
  label, or for one it hasn't classified yet, but a runner on that label that
  is already up and idle, started ahead of predicted jobs, for a cue, or for a
  trusted job, can take it. That job runs until backmesh has read the run
  from GitHub and ended the runner, which doesn't wait for the cancel.
- **Events anyone can trigger aren't fork runs.** In a public repository,
  anyone can start `issues`, `issue_comment`, `discussion`, `fork`, `watch`
  and `pull_request_target` runs, and a `workflow_run` that follows a fork's run.
  These run your default branch's workflow with its secrets and its
  `GITHUB_TOKEN`, on any label, with no vCPU cap or runtime limit, and GitHub's
  approval setting doesn't apply to them. Keep such jobs off backmesh labels,
  put them on `backmesh-ubuntu-2404-public-*`, or gate them with a job-level `if`, which
  GitHub checks before it assigns a runner. Never check out or run a fork's
  code in them; GitHub's
  [guidance](https://docs.github.com/en/actions/reference/security/secure-use)
  says the same for any runner.
- **Fork runs read what the default branch caches.** Any fork's job can
  restore the default branch's cache entries, so keep secrets out of them:
  no private dependencies fetched with a secret, no build outputs that hold
  credentials.
- **A job controls its own VM's Docker**, so it can be root on that VM, for
  the length of the job.

## Required setup

1. **Require approval for every outside pull request.** In the org's
   settings, under Actions → General → "Approval for running fork pull
   request workflows from contributors", pick **Require approval for all
   external contributors**, and check each pull request's changes before you
   approve its run. GitHub's default only asks for first-time contributors,
   which a merged typo fix gets around: that is how researchers reached the
   self-hosted runners of
   [GitHub's runner-images repository](https://adnanthekhan.com/2023/12/20/one-supply-chain-attack-to-rule-them-all/)
   in 2023 and
   [PyTorch](https://johnstawinski.com/2024/01/11/playing-with-fire-how-we-executed-a-critical-supply-chain-attack-on-pytorch/)
   in 2024. See GitHub's
   [settings for fork pull requests](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#controlling-changes-from-forks-to-workflows-in-public-repositories).
2. **Keep secrets out of fork-triggered workflows.** GitHub gives a fork's
   `pull_request` run no secrets and a read-only token; don't work around that
   with `pull_request_target`.
3. **Send forks to `backmesh-ubuntu-2404-public-*` in `runs-on`**, so their runs aren't
   cancelled:

   ```yaml
   jobs:
     test:
       runs-on: ${{ github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'backmesh-ubuntu-2404-public-4vcpu' || 'backmesh-ubuntu-2404-4vcpu' }}
   ```

   The `github.event.pull_request` check matters: on a push there is no pull
   request, and the comparison alone would pick `backmesh-ubuntu-2404-public-4vcpu`. It covers
   `pull_request_review` and `pull_request_review_comment` runs too, and a
   pull request whose fork was deleted.

4. **Use a cloud account, project or subscription of its own** for an org
   with public repositories, or keep nothing else in the runners' network,
   until runners get a network of their own.

## Why ephemeral VMs help, and where they stop

GitHub's warning is mostly about long-lived runners: code from one pull
request can persist on the machine and read the next job's secrets or poison
its builds. backmesh gives every job a fresh VM that is deleted when the job
ends, keeps forks on their own labels and off the cache's writes, and caps
their vCPUs and runtime. What a fork's job can still do is use its VM for
about an hour, longer while the listener is down: its runner is ended about 5
minutes after the cancel, and the cancel depends on backmesh.com answering. It
can reach the internet and, on AWS and GCP, your other instances in
the runners' network, and read its cloud's metadata service.
