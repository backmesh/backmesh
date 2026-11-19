---
title: Security model
description: What runs where, what reaches backmesh, the GitHub App's permissions, what its key can do, and the trust level jobs share.
---

## What runs where

Everything backmesh runs is in your own accounts:

- **backmesh's control plane**, a small always-on VM in the first cloud you
  install, with a checkpoint bucket for its backups.
- **The listener**, which scales runners, alone on a small always-on VM of its
  own for each org. It long-polls GitHub, so nothing needs an inbound port or a
  webhook. It's never on the control plane's VM, which keeps the control
  plane's keys away from the code that reads GitHub's messages.
- **The runners**: each job gets its own spot or on-demand VM, which is deleted
  when the job ends.

Your cloud credentials, code, secrets, caches, logs and runners stay in your
accounts. Install connects each cloud with a role from your own cloud CLI session, so no
cloud keys are stored. The listener's identity is a control plane token that
only it holds, issued by your control plane for that listener alone and kept on
its VM; `backmesh upgrade` issues a new one whenever the control plane refuses
it.

One credential that reaches your org isn't in your accounts: the private key of
backmesh's GitHub App, which backmesh holds. Whoever holds it can register
runners in your org and take jobs routed to them; [the GitHub App](#the-github-app)
says exactly what it can do.

The control plane's DNS name is outside your accounts: install publishes it
with your GitHub sign-in for the control plane.

## What install needs

The `backmesh` CLI runs on macOS or Linux: one binary per platform, with no
Node.js, for `darwin-arm64`, `darwin-x64`, `linux-x64` and `linux-arm64`.
`curl -fsSL https://backmesh.com/install.sh | sh` installs it: the script
downloads your platform's binary from the public
[backmesh/backmesh-releases](https://github.com/backmesh/backmesh-releases)
and verifies its SHA-256 against that release's `checksums.txt`, installing
nothing on a mismatch. Homebrew's formula checks the same digests. On first use, the CLI downloads
the control-plane tools its release pins into `~/.backmesh` and checks their
SHA-256 digest, so it needs network access to GitHub's release downloads.

Install creates the control plane and each cloud's role through your signed-in
cloud CLI, as you, so that identity needs the rights to create them:

- **AWS:** a CloudFormation stack with an IAM role and OIDC provider.
- **GCP:** a custom role, a service account, and a workload identity pool and
  provider with their IAM bindings, plus turning on the Compute, IAM, IAM
  Credentials and Security Token Service APIs.
- **Azure:** a custom role, a resource group with a managed identity and its
  federated credential, and a role assignment.

No cloud keys are saved, and nothing else needs installing. A re-run that only
adds or changes runners on another cloud needs just that cloud's CLI and
rights: the control plane's cloud is untouched once a run finds its control
plane answering and already running backmesh.

## What reaches backmesh

Your code, secrets, caches and job logs go between GitHub and the runners in
your accounts. None of it reaches backmesh.

On a locked-down network, the control plane needs outbound HTTPS to GitHub and
`api.backmesh.com`, and runners to GitHub. Cloud accounts with default
networking already allow both.

The listener makes three kinds of calls to `api.backmesh.com`, all with your
install's key:

- **One event per job started**, in batches about once a minute. It describes
  the job's runner, such as its cloud, VM type and label, never the job: no
  repository, workflow, job, branch or commit names, code, logs or secrets.
  [Telemetry](/telemetry/) lists every field.
- **A GitHub token about every 30 minutes**: a token of backmesh's GitHub App
  for your org only, which lasts an hour. backmesh keeps no copy, and keeps an
  [audit row](/telemetry/#how-its-counted-and-kept) of each one it hands out.
- **One WebSocket for cues**, held open, which receives what `backmesh cue`
  sends.

`backmesh cue` warns your listener that a push is coming. A cue tells
api.backmesh.com your org, your GitHub user and the time. It never sends the
repo, branch or commit. The CLI encrypts them to your listener's public key,
which the listener makes at start and holds only in memory
([Telemetry](/telemetry/#cues)). The listener acts on a cue only for a user
GitHub says can push to that repository, within its own hourly budget, and a
runner it starts early for a cue is removed after 180 seconds idle. backmesh.com could hand
the CLI a key of its own and read cues sent while it does, so treat a cue's
repository and branch names as no more secret from backmesh than its GitHub
App's reach already makes them.

The CLI calls it too. During `backmesh install`, an org owner (or a member who
manages the org's self-hosted runners) signs in to
backmesh's GitHub App once with GitHub's device flow: the CLI prints a code and
when it expires, and the owner enters it at `https://github.com/login/device`
on any device. That GitHub page is the only check that the code is yours: it
names backmesh, so enter a code only if your own terminal printed it. A code
that expires is replaced by a new one. The sign-in is a GitHub App user token
that lasts 8 hours, and can do only what both [the App](#the-github-app) and
you can: manage the org's self-hosted runners, read workflow runs and their
logs, rerun or cancel them, post check runs, and read repositories' metadata.
It can't read code, secrets or the org's member list. The CLI sends it to
backmesh once, which
checks with it that you can manage the org's self-hosted runners, mints the
install key, and returns the key over HTTPS, keeping neither: the token stays
on your machine as the control plane's sign-in. If backmesh's App isn't on the
org, the CLI first prints GitHub's own install link for it and waits. Every
later sign-in (an install re-run, `upgrade`, `rotate-key`, `cue --sign-in`,
and `status`, `logs` or `uninstall` replacing an expired one) is the same
device flow. `backmesh upgrade` checks backmesh still accepts the install's key. `backmesh uninstall` asks an org owner, or a member who manages the org's
self-hosted runners, to sign in the
same way, then gets an hour-long token that can manage only your org's
self-hosted runners, which it keeps in memory to delete backmesh's runners,
scale sets and runner group, and finally removes the App from your org.

## When backmesh.com is down

Events and cues never hold up a job. When backmesh.com is down, a
cue is dropped, `backmesh cue` gives up within 3 seconds without failing, and
jobs start as they would without one. The listener queues events and sends
them in the background, and they go out once `api.backmesh.com` answers.

Scaling does need GitHub tokens from backmesh.com. The listener asks for a new
one with 30 minutes of the current one left, so an outage shorter than that
changes nothing. In a longer one, running jobs finish, and new jobs wait at
GitHub, which keeps a queued job for up to 24 hours, until backmesh.com
answers; `backmesh status` says since when. Install, uninstall, and an upgrade
that replaces the install key need it to answer too.

## The GitHub App

backmesh uses one public GitHub App, `backmesh`. During install, an org owner
installs it on your org with one click. Its webhook is off, and it has only
these permissions:

| Permission                       | Why backmesh needs it                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-hosted runners: write (org) | Scale sets, runner registration, the runner group, removing idle runners                                                                      |
| Actions: write                   | Read a run's commit for reclaim notes, jobs' runner names, and past runs' jobs to start runners ahead of predicted jobs; rerun reclaimed jobs |
| Checks: write                    | Post a check run when spot reclaims fail jobs                                                                                                 |
| Metadata: read                   | Required by GitHub                                                                                                                            |

It has no Contents, Secrets, Members or Administration permission.

backmesh holds the App's private key, as a secret of the service at
`api.backmesh.com`. It's never in your accounts, and the listener never holds
it: the listener gets hour-long tokens for your org only.

### What the App's key can do

The same key works in every org that installed the App. In your org, whoever
holds it, backmesh or anyone who steals it from backmesh, can:

- **Self-hosted runners: write**: register a runner in any of your org's runner
  groups and take the jobs routed to it, with their code and secrets.
- **Actions: write**: read workflow runs and logs; rerun, cancel or delete runs;
  delete logs, artifacts and caches; approve fork pull requests' runs; dispatch,
  enable or disable workflows; and change the repository's OIDC subject claim,
  which cloud trust policies match on. Together with the runner permission, it
  can dispatch or rerun a job on a backmesh label and take it with its own runner,
  reaching that job's secrets.
- **Checks: write**: write misleading check runs.
- **Metadata: read**: list the installation's repositories.

Through GitHub's API it can't read code or Secrets or change Administration
settings, though a job it takes can read what that job can.

backmesh rotates the key; you do nothing. Everything the App does in your org
shows in its audit log as `backmesh[bot]`: watch it for runners you don't
expect. To cut the App off at once, suspend or uninstall it in your org's
settings, under GitHub Apps; runners stop scaling until you reinstall it. If
backmesh's key leaks, backmesh replaces it, and the leaked key stops working at
once. backmesh then tells every customer, since a token minted with it works
for up to an hour.

### If your install's key leaks

Your install's key gets GitHub tokens for your org, so the listener reads it on
a control plane VM, which runs no job. If you think it leaked, an owner of your
org, or a member who manages its self-hosted runners, runs
`backmesh rotate-key --org <org>`, which signs in with GitHub again,
writes a new key to the listener and only then revokes the old one. A token
already handed out works for up to an hour.

## Which jobs run

Each installation's runners join its own runner group, `backmesh-` and a short
ID, which `backmesh status` names. The group doesn't allow public repositories,
so only private repositories can use the runners. backmesh adds no fork or
actor policy of its own; GitHub's fork pull request settings decide whether a
fork's workflow runs, and after whose approval.

## What a job can reach

A job controls its own VM's Docker, so it can be root on that VM. The VM has no
cloud identity on any cloud and holds no backmesh or control-plane credential:
only the job's own runner registration and its short-lived cache tokens. It
reaches the internet, and it can't reach another runner except on SSH, which
only the control plane holds a key for.

Runners use each cloud's default networking. On AWS they're in the account's
default VPC, and on GCP in the project's `default` network, so a job can reach
your other instances there whose firewall rules admit the network's range. On
GCP it can also read the project's metadata, such as SSH keys or startup
scripts you set there. Use a cloud account or project with nothing else in its
default network for backmesh's runners.

Pull requests from forks read the caches and save none.

## One trust level

Every job that reaches the runner group is trusted the same way: each job gets
its own VM; the job controls that VM's Docker. Jobs from every repository in the
org use the same labels, so only run code you'd trust your org's members to
run. Jobs on the [KVM labels](/labels/#kvm) also get `/dev/kvm`.

The listener runs on its own VM, which runs no job. Per-repository
runner groups are planned.
