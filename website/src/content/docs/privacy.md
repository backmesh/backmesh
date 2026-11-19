---
title: Privacy policy
description: What backmesh collects, why, who processes it, how long it's kept, and your rights.
---

_Effective November 11, 2026_

backmesh is built to know as little about you as it can. It runs in your own
cloud accounts, so your code, jobs, logs, secrets and cloud credentials stay
there. This policy lists the little that reaches us, what we do with it, and
your rights. We never sell your data.

"We", "us" and "our" mean backmesh, the operator of the service. "backmesh"
also names the service itself: the CLI, the listener and runner images,
backmesh.com and `api.backmesh.com`.

## What we collect and why

### Telemetry from your install

The listener in your install sends one event per job started.
[Telemetry](/telemetry/) lists every field, with an
example. In short: a hashed job ID, the backmesh version, when the job
started, and the cloud, region, VM type, capacity, label, queue and boot times,
refused launches and features of its runner. It never sends repository, workflow, job,
branch or commit names, code, logs, secrets, cloud credentials, or anything
from the job's run.

### GitHub sign-in

You sign in with GitHub to backmesh's GitHub App with `backmesh install` and
`backmesh upgrade`, with a GitHub device code. The sign-in is a GitHub App user
token that lasts 8 hours, and can do only what both the App and you can:
manage the org's self-hosted runners, read, rerun or cancel workflow runs and
read their logs, post check runs, and read repositories' metadata; not code,
secrets or the org's member list. Your machine keeps it for your control plane, and
sends it to `api.backmesh.com` once to check you can manage the org's
self-hosted runners; we keep no token. Uninstall's check is the same. We store the
org's numeric GitHub ID, an install ID, when the install was created, and a
SHA-256 hash of the install's key, never the key itself.

For your orgs, we store their numeric GitHub IDs and names.

### backmesh's GitHub App

Your install gets its GitHub access from backmesh's GitHub App, installed on
your org. For each org we keep the App installation's ID, the org's login and
the permissions the installation grants. Your listener asks `api.backmesh.com`
for an hour-long installation token about every 30 minutes; we hand it over
and keep none. Each token issued, and each uninstall call, refused or not,
writes one audit row: the install, org and installation, the token's
permissions and expiry, and the caller's IP address and Cloudflare ray ID.

### Cookies

backmesh.com stores your light or dark theme choice in your browser. There are no analytics,
advertising or tracking cookies.

### Request logs

backmesh.com and `api.backmesh.com` run on Cloudflare, which sees each
request's IP address to serve, secure and rate-limit it. The API's logs, which
we use for debugging and security, are kept in Cloudflare for up to 7 days.

### Email

When you write to us, we keep the correspondence so we can refer back to it.

## How we use it

- Per org, to help with your support requests and to see whether your
  install is running jobs.
- For product planning and reliability, as totals across all installs, as
  [Telemetry](/telemetry/) describes.
- To keep backmesh secure and to answer you when you contact us.

## Who we share it with

We use these processors to run backmesh:

| Processor  | What for                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| Cloudflare | Hosting backmesh.com and `api.backmesh.com`, and the database behind them |
| GitHub     | Sign-in, runner-management and org checks                                 |

Otherwise we share your information only when the law requires it, and we
disclose only the minimum needed. If backmesh is acquired or merges with
another company, we'll tell you before your information becomes subject to a
different privacy policy.

## How long we keep it

| Data                                          | Kept                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Telemetry events                              | 90 days, then folded into a count of jobs per day, org and install |
| Daily job counts                              | Kept                                                               |
| Install sign-ins' and App installation tokens | Not kept                                                           |
| Token and uninstall audit rows                | 90 days                                                            |
| App installation records                      | Until the App is uninstalled or GitHub reports it gone             |
| Org and install records                       | Kept, so an org's installs survive renames; ask us to delete them  |
| API request logs                              | Up to 7 days, at Cloudflare                                        |

## Your rights

Wherever you are, you can ask us to tell you what we hold about you, give you
a copy, correct it, delete it, or stop using it. We may need to keep some
records to meet legal obligations. We'll ask you to sign in with GitHub to confirm the request is
yours. You can also complain to your data protection authority.

You can stop telemetry by uninstalling backmesh with `backmesh uninstall`.

## Security

Everything between your install, your browser and backmesh travels over TLS.
We store hashes of install keys, not the keys. See the
[security model](/security/) for how backmesh works inside your accounts.

## Changes and questions

We may update this policy. When we make a significant change, we'll update the
date at the top and announce it on backmesh.com. Questions or requests:
[support@backmesh.com](mailto:support@backmesh.com).

---

Adapted from the
[Basecamp open-source policies](https://github.com/basecamp/policies) /
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
