---
title: Terms of service
description: The terms for backmesh's service, its software's licence, termination, and the limits of our liability.
---

_Effective November 11, 2026_

Thank you for using backmesh. These terms are the agreement between you and
us when you use the backmesh service.

"We", "us" and "our" mean backmesh, the operator of the service. "The service"
means backmesh.com and `api.backmesh.com`: the backmesh GitHub App, and the
sign-ins, tokens, cues and telemetry an installation exchanges with it. The
backmesh software, the CLI and the listener and runner images, is under the
open-source licences below, not these terms.
"You" means the person or organization using the service. If you accept these
terms for an organization, you confirm you're authorized to bind it.

By using the service, including through a backmesh installation, you agree to
these terms and to the [Privacy policy](/privacy/).

## Licence

backmesh's source is published at
[backmesh/backmesh](https://github.com/backmesh/backmesh) under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), and its
cache action under the MIT License. Those licences govern the code and the
published binaries and images; these terms govern only the service.

backmesh's core features are free to use. Premium, for Slack monitoring, logs and runtime
history, is agreed separately: [talk to us](mailto:luis@backmesh.com).

## Your accounts

backmesh runs in your own cloud accounts, which bill you directly. We have no
access to them. You're responsible for those accounts, their costs, the jobs
you run on them, and following your cloud providers' and GitHub's terms.

You sign in with GitHub. You're responsible for keeping your GitHub and cloud
accounts secure, and for what happens under your sign-in and your install's
key.

## Acceptable use

Don't use the service to break the law or anyone's rights, to attack or overload
`api.backmesh.com`, to send events for an org you don't control, or to get
around these terms.

## Telemetry

Each install sends one event per job started, as described in
[Telemetry](/telemetry/). It never includes your code, logs, secrets or the
names of your repositories, workflows or jobs. We use it for support and for
product planning, as that page lists.

## Termination

You can stop using the service at any time. To remove backmesh from your
accounts, run `backmesh uninstall`.

We may suspend or end your use of the service if you break these terms.
Sections that by their nature should survive, such as No warranty and
Liability, do.

## Changes to the service and these terms

We may change or stop parts of the service. Events never hold up a job, but
scaling needs GitHub tokens from backmesh.com: an outage of more than about 30
minutes delays new jobs until it ends, as the
[security model](/security/#when-backmeshcom-is-down) explains.

We may update these terms. When we make a significant change, we'll update the
date at the top and announce it on backmesh.com. Continuing to use the
service after a change means you accept it.

## No warranty

The service is provided as is and as available, without warranty of any kind,
express or implied, to the extent the law allows. We don't promise it will
meet your needs, run without interruption, or be free of bugs.

## Liability

To the extent the law allows, we aren't liable for any indirect, incidental,
special, consequential or punitive damages, or for lost profits, revenue, data
or goodwill, arising from the service or these terms, even if we were told they
were possible. That includes the cost of your cloud accounts and the outcome of
the jobs you run. Our total liability for any claim is limited to the amount
you paid us for the service in the 12 months before the claim.

## Governing law

These terms are governed by the laws of the State of Florida, USA, without
regard to its conflict-of-laws rules. Any dispute under them goes to the state
or federal courts located in Florida, and you and we consent to their
jurisdiction.

## General

These terms and the Privacy policy are the whole agreement between you and us
about the service. If we don't enforce a term, we haven't waived it. If a term is
unenforceable, the rest still applies.

Questions: [support@backmesh.com](mailto:support@backmesh.com).

---

Adapted from the
[Basecamp open-source policies](https://github.com/basecamp/policies) /
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
