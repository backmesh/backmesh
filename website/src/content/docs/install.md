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
  install. A member who manages the org's self-hosted runners can sign in
  too, once the App is on the org.
- A signed-in cloud CLI on your `PATH` for each cloud: `aws`, `gcloud` with
  a project, or `az` with a subscription, with
  [the rights install needs](/security/#what-install-needs). What install
  creates in each cloud: [AWS](/aws/), [GCP](/gcp/), [Azure](/azure/).
- `curl`, `tar`, and `sha256sum` or `shasum`, for the install script.

## Run install

```sh
backmesh install --org acme
```

Without `--org`, install offers the org of the current repo's GitHub remote,
else signs you in and lists your orgs backmesh's GitHub App is already on to
pick from; for a new org, pass `--org`. Without a terminal it asks nothing and
names those orgs and the command to run instead.

With nothing else, the control plane and runners go on the cloud your CLI is
signed in to, near GitHub's US East. The control plane is an always-on VM
(t3.large on AWS) in your account, and each org's listener, which starts runners
for your jobs, a small one (t3.small on AWS) of its own: together about
$74–$111 a month for one org, up to $151 on Azure when a region doesn't offer
your subscription the first sizes, and $15–$72 more for each further org.
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
   regions, `backmesh-ubuntu-2404-4vcpu` spot and on-demand prices, the [quotas](#quotas) read
   through your cloud CLI, and the control plane's monthly cost, and asks once.
2. **Prints a code.** The org owner opens `https://github.com/login/device` on
   any device and enters the code; one that expires is replaced by a new one,
   printed with when it expires. If backmesh's GitHub App isn't on the org
   yet, install then prints GitHub's install link for it
   ([its permissions](/security/#the-github-app)) and waits until it's there.
   That sign-in also owns the control plane and is saved in `~/.backmesh`.
3. **Creates the control plane and cloud roles.** Through each cloud's CLI, it
   creates the control plane and, in the plan's account, a role that trusts only
   it. You own both; no cloud keys are stored.
4. **Starts backmesh,** prints this installation's labels and the largest
   one up to `backmesh-ubuntu-2404-4vcpu` that your quotas start a runner for, and runs
   [`backmesh status`](/status/).

```text
Labels for runs-on: backmesh-ubuntu-2404-2vcpu, backmesh-ubuntu-2404-4vcpu, backmesh-ubuntu-2404-8vcpu, backmesh-ubuntu-2404-16vcpu, backmesh-ubuntu-2404-od-2vcpu, ..., backmesh-ubuntu-2404-gpu-od-t4 (aws's carry no "aws-": it runs the control plane).
Done. Use `runs-on: backmesh-ubuntu-2404-4vcpu` (a 4-vCPU spot VM) in a workflow; other sizes: https://backmesh.com/labels/
```

The plan prints the same `Labels for runs-on:` line. Use those labels exactly:
one that isn't there, such as `backmesh-azure-ubuntu-2404-gpu-t4` on an Azure control
plane, waits at GitHub for a runner that never comes.

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
`backmesh-ubuntu-2404-4vcpu`, others named ones like `backmesh-gcp-ubuntu-2404-4vcpu`.

| You pass                       | backmesh uses                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing                        | The control plane on the cloud whose CLI is signed in, in its US East region (AWS `us-east-1`, GCP `us-east4`, Azure `eastus`), and runners on that cloud |
| `--control-plane gcp:us-east1` | The control plane there, and runners on GCP                                                                                                               |
| `--runners azure`              | Runners on Azure too                                                                                                                                      |

`--control-plane` still takes `<cloud>:<region>`. `--runners` takes a cloud
only — `--runners aws:us-west-2` is refused, since runner regions aren't
chosen (below).

On Azure, the plan first checks that your subscription may create the VM
sizes of the always-on VMs install creates in that region, since some offers,
such as sponsorships, can't. If it can't, the plan names each refused size and
puts them in the first of backmesh's [Azure regions](/azure/#regions) that
offers every one. [More](/azure/#the-control-planes-region).

### A control plane that already exists

The control plane is named `backmesh`, and the plan looks for one by that name
before any sign-in: in the AWS account's region, or anywhere in the Azure
subscription or GCP project. One this machine doesn't use may be another
installation's, so the plan stops and names its ID. If it isn't yours, pass
`--control-plane aws:<another region>` to create a separate one on AWS, or use
another subscription or project on Azure or GCP. If it's yours, such as one you
installed from another machine or an install that stopped partway, pass
`--control-plane-id <id>` to resume it. When it holds no VM, as an install that
stopped before its control plane ran leaves it, the plan says so and prints the
command that deletes it, such as `az group delete --name anycloud-<id>`:

```sh
backmesh install --org acme --control-plane aws:us-east-1 --control-plane-id backmesh-1763553600000-x7k2p9
```

## Regions

Each runner cloud's regions are fixed, not something you choose: every US
region whose catalog offers every VM type backmesh's labels use, narrowed to
the ones your account allows (a region your organization's policy denies is
skipped, printed, and install goes on with the rest). Each job tries the
cheapest of them, then falls back to another when the cloud refuses for
capacity or quota; labels stay the same.

## Quotas

Each region's spot and on-demand vCPU quotas cap how many jobs run at once; jobs
past them wait. Install prints them as how many `backmesh-ubuntu-2404-4vcpu` jobs fit at once,
each region counted on its own. It stops before anything is billed when the
regions' quotas together are under one `backmesh-ubuntu-2404-4vcpu` VM; otherwise each label
whose VM no region's quota fits gets a line that it `would start no runners`,
naming the quota to raise. On Azure, the plan also
checks the always-on VMs' family quotas, such as "Standard DSv5 Family vCPUs". GCP's default `CPUS_ALL_REGIONS` is 32
vCPUs, 8 `backmesh-ubuntu-2404-4vcpu` jobs, so raise it before big bursts.
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
    runs-on: backmesh-ubuntu-2404-4vcpu
    steps:
      - uses: actions/checkout@v5
      - run: make test
```

Only private repositories can use the runners, unless you install with
[`--public-repos`](/public-repos/). Moving jobs off
`ubuntu-latest`? See [what differs](/from-ubuntu-latest/).
