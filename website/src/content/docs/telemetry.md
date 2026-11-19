---
title: Telemetry
description: Exactly what backmesh sends about the jobs it starts, when, where, and how long it's kept.
---

The listener in your install sends one small event per job it starts to
`api.backmesh.com`, for support and product planning. This page lists
everything it sends.

## What's sent

Each event describes one job's runner, never the job itself:

| Field             | What it is                                                                    |
| ----------------- | ----------------------------------------------------------------------------- |
| `id`              | SHA-256 of your org's ID and GitHub's job ID, so a resent event counts once   |
| `version`         | The backmesh version                                                          |
| `started_at`      | When the job started                                                          |
| `cloud`           | `aws`, `gcp` or `azure`                                                       |
| `region`          | The cloud region the runner ran in                                            |
| `vm_type`         | The VM type, such as `m7a.xlarge`                                             |
| `capacity`        | `spot` or `on-demand`                                                         |
| `label`           | The runner label the job asked for, such as `backmesh-4`                      |
| `queued_ms`       | From GitHub queuing the job to assigning a runner, by GitHub's clock          |
| `boot_ms`         | From backmesh asking for the runner's VM to its container running             |
| `launch_refusals` | How many launches the cloud refused, for quota or capacity, before the VM ran |
| `features`        | backmesh features turned on, such as retrying on demand                       |

A field the listener doesn't know yet is `null`. Your org and install aren't
fields: api.backmesh.com reads them from your install's sign-in, made once with
GitHub during `backmesh install`. The listener sends events in batches, such
as:

```json
{
  "events": [
    {
      "id": "5f0c6a4c1b8e2d3f9a7e6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e",
      "version": "0.3.2",
      "started_at": "2026-11-06T14:03:27Z",
      "cloud": "aws",
      "region": "us-east-2",
      "vm_type": "m7a.xlarge",
      "capacity": "spot",
      "label": "backmesh-4",
      "queued_ms": 2100,
      "boot_ms": 41000,
      "launch_refusals": 0,
      "features": []
    }
  ]
}
```

It never sends repository, workflow, job, branch or commit names, code,
logs, secrets, cloud credentials, or anything from the job's run.

backmesh starts runners ahead of predicted jobs by learning from your
workflows' past runs inside the listener, and sends none of it.

## When and where

- One event per job started, sent in batches about once a minute.
- A GitHub token request about every 30 minutes, which returns an hour-long
  token of backmesh's GitHub App for your org.
- One WebSocket, held open, for [cues](#cues).
- All three go to `https://api.backmesh.com`, the one backmesh address to allow if you
  filter egress.
- Events never hold up a job: when backmesh.com is slow or down, they wait and
  go out once it answers. Scaling needs a token, and rides out an outage of up
  to 30 minutes; see the [security model](/security/#when-backmeshcom-is-down).

The listener logs each batch it sends, in full, as one JSON line, so you can
check the payload with `backmesh logs --org <org>`.

## Cues

`backmesh cue`, run when you start your checks before a push, warns your
listener so it can start runners early. A cue tells api.backmesh.com your org,
your GitHub user and the time. It never sends the repo, branch or commit. The
CLI encrypts them on your machine to your listener's key, and only the listener
can read them. The listener holds one WebSocket open to receive cues and pings
it every 20 seconds.

To check you're a member of the org, the CLI signs in to backmesh's GitHub App
once and trades that sign-in for a cue credential, which lasts 30 days and is
kept on your machine. backmesh.com asks GitHub once, at the trade, which
orgs' App installations you reach, as their members do; it keeps your GitHub
user ID and login, those orgs and a hash of the credential, never a GitHub
token. Later cues send only the credential. It keeps, for at most 10 minutes, your GitHub user ID per
cue for its rate limits, a random tag your CLI makes for each push (each repo
and branch, new every 10 minutes) so a push's cues count once, a hash per cue
that only its repeats match, and the encrypted cue for 60 seconds until your
listener takes it.

## How we use it

- **Per org:** to help with your support requests and to see whether your
  install is running jobs.
- **How many orgs and installs use backmesh**, as two totals.
- **Capacity and product planning:** jobs by cloud, region and VM type,
  and how many installs use retrying on demand.
- **Reliability of spot and on-demand:** the share of jobs on each.
- **Startup times:** the median and 95th-percentile queue and boot times per
  cloud.

Nothing is sold, or shared beyond the processors the
[Privacy policy](/privacy/) lists. That policy covers everything else backmesh
receives, such as sign-in details.

## How it's counted and kept

- A resent event is stored once.
- An event dated in the future or more than 35 days back counts as received
  now.
- Raw events are deleted after 90 days. A count per day, org and install is
  kept.
- Each token backmesh hands out, and each uninstall sign-in and App removal,
  refused or not, writes one audit row: the install, org and App
  installation, the token's permissions and expiry when there is one, and the
  caller's IP address and Cloudflare ray ID. Audit rows are deleted after 90
  days.

## Installs

An org owner, or a member who manages the org's self-hosted runners, signs in
to backmesh's GitHub App once, during `backmesh install`. backmesh.com uses that GitHub token once, to check you can manage
the org's self-hosted runners, and keeps none; it stays on your machine for
your control plane. It ties the install
to your org: no one else can send events or get GitHub tokens for it.
