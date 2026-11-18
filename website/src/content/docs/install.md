---
title: Install
description: Install backmesh across your AWS, GCP and Azure accounts with one command.
head:
  - tag: title
    content: Install self-hosted GitHub Actions runners | backmesh
  - tag: meta
    attrs:
      property: og:title
      content: Install self-hosted GitHub Actions runners | backmesh
---

## Install the CLI

On macOS or Linux:

```sh
curl -fsSL https://backmesh.com/install.sh | sh
```

Or with Homebrew: `brew install backmesh/tap/backmesh`.

## Before you start

You need:

- A GitHub org owner, who signs in and installs backmesh's GitHub App during
  install. An org that restricts OAuth apps
  [approves backmesh first](/faq/#installing).
- A signed-in cloud CLI on your `PATH` for each cloud: `aws`, `gcloud` with
  a project, or `az` with a subscription, with
  [the rights install needs](/security/#what-install-needs). What install
  creates in each cloud: [AWS](/aws/), [GCP](/gcp/), [Azure](/azure/).

## Run install

```sh
backmesh install --org acme
```

Without `--org`, install offers the org of the current repo's GitHub remote,
else signs you in and lists the orgs you're an admin of to pick from. Without a
terminal it asks nothing and names your orgs and the command to run instead.

With nothing else, the control plane and runners go on the cloud your CLI is
signed in to, near GitHub's US East. The control plane is a small always-on
VM in your account, and each org's listener, which starts runners for your
jobs, another (together about $74–$111 a month for one org).
To choose, see [Control plane and runners](#control-plane-and-runners). To see
the plan first:

```sh
backmesh install --org acme --plan
backmesh install --org acme --control-plane aws:us-east-1 --runners aws --yes --plan-id p-3f9a1c2b7e4d
```

`--plan` prints what install would create and cost, the plan's ID and the full
install command, without signing in or changing anything (`--json` for JSON).
`--yes --plan-id` runs that plan with no terminal, and stops for a new plan if
anything changed since, such as the cloud account or the control plane's orgs.

Install then:

1. **Checks and plans.** It prints a fix for each missing sign-in,
   project or subscription (`--verbose` adds the CLI's error), then each cloud's
   regions, `backmesh-4` spot and on-demand prices, the [quotas](#quotas) read
   through your cloud CLI, and the control plane's monthly cost, and asks once.
2. **Prints a code.** The org owner opens `https://github.com/login/device` on
   any device and enters the code. If backmesh's GitHub App isn't on the org
   yet, install then prints GitHub's install link for it
   ([its permissions](/security/#the-github-app)) and waits until it's there.
   That sign-in also owns the control plane and is saved in `~/.backmesh`.
3. **Creates the control plane and cloud roles.** Through each cloud's CLI, it
   creates the control plane and, in the plan's account, a role that trusts only
   it. You own both; no cloud keys are stored.
4. **Starts backmesh,** prints the label and runs
   [`backmesh status`](/status/).

```text
Done. Use `runs-on: backmesh-4` (a 4-vCPU spot VM) in a workflow; other sizes: https://backmesh.com/labels/
```

To change an installation's runners,
[run install again](/upgrade/#run-install-again).

## Add another org

```sh
backmesh install --org acme-labs --control-plane aws:us-east-2 --runners aws --runners gcp
```

Same owner only; orgs share the 500-runner cap. [More](/faq/#installing).

## Control plane and runners

The control plane lives in one cloud and region. Runners, one VM per job that is
deleted when it ends, can be in other clouds; the control plane's cloud gets plain [labels](/labels/) like
`backmesh-4`, others named ones like `backmesh-gcp-4`.

| You pass                       | backmesh uses                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing                        | The control plane on the cloud whose CLI is signed in, in its US East region (AWS `us-east-1`, GCP `us-east4`, Azure `eastus`), and runners on that cloud |
| `--control-plane gcp:us-east1` | The control plane there, and runners on GCP                                                                                                               |
| `--runners azure`              | Runners on Azure too                                                                                                                                      |

`--control-plane` still takes `<cloud>:<region>`. `--runners` takes a cloud
only — `--runners aws:us-west-2` is refused, since runner regions aren't
chosen (below).

## Regions

Each runner cloud's regions are fixed, not something you choose: every US
region whose catalog offers every VM type backmesh's labels use, narrowed to
the ones your account allows (a region your organization's policy denies is
skipped, printed, and install goes on with the rest). Each job tries the
cheapest of them, then falls back to another when the cloud refuses for
capacity or quota; labels stay the same.

## Quotas

Each region's spot and on-demand vCPU quotas cap how many jobs run at once; jobs
past them wait. Install prints them as `backmesh-4` jobs and stops before
anything is billed if they can't fit one. GCP's default `CPUS_ALL_REGIONS` is 32
vCPUs, 8 `backmesh-4` jobs, so raise it before big bursts.
[More](/faq/#installing).

## Cache size

Each repository keeps at most 10 GB of [cache](/cache/) in each runner region.
`--cache-cap <GB>` sets another limit; a re-run of install with a new value
changes it, and one without the flag keeps the current one.

```bash
backmesh install --org acme --cache-cap 25
```

## Use it in a workflow

Set `runs-on` to a [label](/labels/):

```yaml
jobs:
  test:
    runs-on: backmesh-4
    steps:
      - uses: actions/checkout@v5
      - run: make test
```

Only private repositories can use the runners. Moving jobs off
`ubuntu-latest`? See [what differs](/from-ubuntu-latest/).
