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
- **Pull requests from forks run only on `backmesh-public-2` and
  `backmesh-public-4`.** These are spot VMs in the control plane's cloud, one
  job per VM, deleted when the job ends, with no KVM. Together they hold at
  most 32 vCPUs across the org; more fork jobs wait at GitHub.
- **A fork run that asks for another backmesh label is cancelled**, with a
  note on the run naming the labels it may use. backmesh.com makes the cancel
  with the App's Actions write ([Security](/security/#the-github-app)).
- **A fork run that has run 60 minutes on a public label is cancelled**, and
  its runners are ended 5 minutes later if still running.
- **Fork runs read the [cache](/cache/) and never save to it.**

backmesh counts a run as a fork's when its event is `pull_request`,
`pull_request_review` or `pull_request_review_comment`, the repository is
public, and the pull request's head is in another repository.

## What it doesn't do

- **The public runners share your cloud network.** `backmesh-public-*` VMs
  run in the same account, project or subscription and the same default
  network as your other runners. A fork's job can reach your other instances
  there whose firewall rules admit the network's range, and the internet.
- **They have the same metadata access as other runners.** No runner VM has
  a cloud identity: no IAM instance profile on AWS, no service account on GCP,
  no managed identity on Azure, so the metadata service hands out no cloud
  credentials. It is still reachable, and on GCP it serves the project's
  metadata, such as SSH keys or startup scripts set there
  ([Security](/security/#what-a-job-can-reach)).
- **The label gate acts after GitHub assigns the job.** backmesh can't hold
  a job back; it hears of it once GitHub hands it to a runner. If a runner on
  another label is idle when a fork's job asks for that label, the job starts
  there and runs until backmesh has read the run from GitHub, cancelled it
  and ended that runner.
- **Runs started by `pull_request_target`, `issue_comment`, `workflow_run` or
  other events aren't fork runs.** They run in your repository's context with
  its secrets and a write token, on any label. Never check out or run a fork's
  code in them on a backmesh label; GitHub's
  [guidance](https://docs.github.com/en/actions/reference/security/secure-use)
  says the same for any runner.
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
3. **Send forks to `backmesh-public-*` in `runs-on`**, so their runs aren't
   cancelled:

   ```yaml
   jobs:
     test:
       runs-on: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository && 'backmesh-public-4' || 'backmesh-4' }}
   ```

   The `event_name` check matters: on a push there is no pull request, and the
   comparison alone would pick `backmesh-public-4`.

4. **Consider a cloud account, project or subscription of its own** for an
   org with public repositories, with nothing else in its network.

## Why ephemeral VMs help, and where they stop

GitHub's warning is mostly about long-lived runners: code from one pull
request can persist on the machine and read the next job's secrets or poison
its builds. backmesh gives every job a fresh VM that is deleted when the job
ends, keeps forks on their own labels and off the cache's writes, and caps
their vCPUs and runtime. What a fork's job can still do is use its VM for up
to an hour: reach your cloud network and the internet, and read its cloud's
metadata service.
