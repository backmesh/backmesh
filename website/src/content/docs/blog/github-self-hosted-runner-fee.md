---
title: "GitHub's self-hosted runner fee: where it stands"
description: GitHub announced a $0.002 per minute fee for self-hosted runners in private repos, then postponed it. What is in effect in November 2026, what GitHub-hosted runners cost now, what the fee would add at different volumes, and how to prepare.
date: 2026-11-18
lastUpdated: 2026-11-18
authors: backmesh
tags:
  - GitHub pricing
excerpt: GitHub announced a $0.002 per minute fee on self-hosted runners in December 2025 and postponed it a day later. Where it stands in November 2026, what GitHub-hosted runners cost now, what the fee would add by runner size, and who it would reach.
head:
  - tag: title
    content: 'GitHub self-hosted runner fee ($0.002/min): status in 2026 | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"GitHub''s self-hosted runner fee: where it stands","datePublished":"2026-11-18","dateModified":"2026-11-18","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/github-self-hosted-runner-fee/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Does GitHub charge for self-hosted runners in 2026?","acceptedAnswer":{"@type":"Answer","text":"No. As of 2026-11-18 GitHub''s billing docs list self-hosted runner usage as free. GitHub announced a $0.002 per minute charge for self-hosted runners in private repositories on 2025-12-16, to start on 2026-03-01, and postponed it on 2025-12-17. It has not announced a new date."}},{"@type":"Question","name":"Was the self-hosted runner fee cancelled?","acceptedAnswer":{"@type":"Answer","text":"It was postponed, not cancelled. GitHub said it would take time to re-evaluate its approach and that it has real costs in running the Actions control plane."}},{"@type":"Question","name":"How much would the self-hosted runner fee cost?","acceptedAnswer":{"@type":"Answer","text":"$0.002 for every minute a self-hosted runner works on a job in a private repository, whatever the runner''s size: $40 a month for 20,000 minutes, $300 for 150,000 minutes and $2,000 for 1,000,000 minutes."}},{"@type":"Question","name":"Would the fee apply to third-party runners such as Blacksmith or Namespace?","acceptedAnswer":{"@type":"Answer","text":"As announced, yes. Third-party runner services register their machines with GitHub as self-hosted runners, so the per-minute charge would apply to jobs on them in private repositories. Blacksmith and Namespace both wrote about the change on the day it was announced."}},{"@type":"Question","name":"Did GitHub-hosted runner prices change?","acceptedAnswer":{"@type":"Answer","text":"Yes. From 2026-01-01 GitHub-hosted runners cost less: Linux 2-core went from $0.008 to $0.006 a minute, Linux 4-core from $0.016 to $0.012, and Windows 2-core from $0.016 to $0.010."}},{"@type":"Question","name":"Do public repositories pay for self-hosted runners?","acceptedAnswer":{"@type":"Answer","text":"No. The announcement left public repositories free, and standard GitHub-hosted runners stay free in public repositories."}},{"@type":"Question","name":"Is self-hosting GitHub Actions runners still cheaper than GitHub-hosted runners?","acceptedAnswer":{"@type":"Answer","text":"Usually, for Linux jobs at volume. A 4-vCPU spot VM costs roughly $0.0005 to $0.0019 a minute on AWS, GCP or Azure, against $0.012 for GitHub''s 4-core runner. Even with a $0.002 fee added, spot compute stays below GitHub''s 4-core price, but the fixed cost of running the self-hosted setup has to be counted."}}]}]}'
---

As of 2026-11-18, GitHub doesn't charge for self-hosted runners. It announced
a $0.002 per minute fee for them on 2025-12-16, to start on 2026-03-01, and
postponed it the next day. There's no new date. GitHub's billing docs list
self-hosted runner usage as usage that
"[remains free](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
independently and does not reduce the included compute usage".

The rest of this post covers what was announced, what did take effect, what
the fee would cost at different volumes, who it would reach, and what to do
about it now. Every price links to its source and was checked on 2026-11-18.

## The short version

| Question                               | Answer, 2026-11-18                                            |
| -------------------------------------- | ------------------------------------------------------------- |
| Is there a fee on self-hosted runners? | No                                                            |
| Was it cancelled?                      | No, postponed on 2025-12-17 with no new date                  |
| How much was announced?                | $0.002 per minute, any runner size, private repositories only |
| Did GitHub-hosted prices change?       | Yes, down by up to 39% from 2026-01-01, per GitHub            |
| What's included each month?            | $12 on Free, $18 on Pro and Team, $300 on Enterprise Cloud    |
| Are public repositories affected?      | No                                                            |
| Is GitHub Enterprise Server affected?  | No, per the announcement                                      |

## What GitHub announced

On 2025-12-16, GitHub published
"[Coming soon: simpler pricing and a better experience for GitHub Actions](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/)".
It made two changes at once:

1. GitHub-hosted runners would cost up to 39% less from 2026-01-01, per
   GitHub.
2. A new "Actions cloud platform charge" of $0.002 per minute would apply to
   self-hosted runner usage in private repositories from 2026-03-01. Those
   minutes would also count against a plan's included usage.

GitHub's [pricing FAQ](https://github.com/resources/insights/2026-pricing-changes-for-github-actions)
gave its reasoning and its estimate of who would notice. It said 96% of
customers would see no change in their bill. Of the 4% who would, it said 85%
would pay less and 15% would pay more, with a median increase of about $13 a
month. It also said the new GitHub-hosted prices already included the $0.002
platform charge, so the charge was new only for self-hosted runners.

The reaction was large. The Hacker News thread on the change had
[802 points and 819 comments](https://news.ycombinator.com/item?id=46291156)
as of 2026-11-18. Much of it came from teams that already pay for their own
machines and objected to paying per minute for hardware they run.

## The postponement

On 2025-12-17, GitHub posted in its
[community discussion](https://github.com/orgs/community/discussions/182186):
"We're postponing the announced billing change for self-hosted GitHub Actions
to take time to re-evaluate our approach." The same post said GitHub had
"missed the mark" and also that "we have real costs in running the Actions
control plane".

That second sentence is why the fee is best read as postponed, not withdrawn.
Self-hosted runners still use GitHub's queue, scheduling, logs and artifacts,
and GitHub runs that control plane at a large and growing scale:

- In 2025, public projects used 11.5 billion Actions minutes, up 35% on the
  year before ([Octoverse](https://github.blog/news-insights/octoverse/what-986-million-code-pushes-say-about-the-developer-workflow-in-2025/)).
- GitHub said Actions jobs per day went from about 23 million in early 2024 to
  about 71 million after its re-architecture
  ([pricing FAQ](https://github.com/resources/insights/2026-pricing-changes-for-github-actions)).
- GitHub's COO said Actions went from about 1 billion minutes a week in 2025
  to 2.1 billion in the first days of one week in April 2026
  ([post](https://x.com/kdaigle/status/2040164759836778878)).

As of 2026-11-18, the discussion has no staff update after the postponement,
and GitHub's runner pricing reference lists no self-hosted charge.

## What did change

The price cut went ahead on 2026-01-01
([changelog](https://github.blog/changelog/2026-01-01-reduced-pricing-for-github-hosted-runners-usage/)).
Private repositories, per minute, from
[GitHub's runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing):

| Runner              | Before 2026-01-01 | Now    | Change |
| ------------------- | ----------------- | ------ | ------ |
| Linux 1-core (slim) | $0.002            | $0.002 | none   |
| Linux 2-core x64    | $0.008            | $0.006 | -25%   |
| Linux 2-core arm64  | $0.005            | $0.005 | none   |
| Linux 4-core x64    | $0.016            | $0.012 | -25%   |
| Linux 8-core x64    | $0.032            | $0.022 | -31%   |
| Linux 16-core x64   | $0.064            | $0.042 | -34%   |
| Linux 32-core x64   | $0.128            | $0.082 | -36%   |
| Linux 64-core x64   | $0.256            | $0.162 | -37%   |
| Windows 2-core      | $0.016            | $0.010 | -38%   |
| macOS 3 or 4-core   | $0.080            | $0.062 | -23%   |
| macOS 12-core       | $0.120            | $0.077 | -36%   |

Other changes to what Actions costs, in order:

| Date       | Change                                                                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-01-22 | The 1-vCPU `ubuntu-slim` runner became [generally available](https://github.blog/changelog/2026-01-22-1-vcpu-linux-runner-now-generally-available-in-github-actions) at $0.002 a minute.                                                      |
| 2026-03-03 | [Email alerts](https://github.blog/changelog/2026-03-03-email-notifications-for-included-usage-thresholds/) at 90% and 100% of included usage.                                                                                                |
| 2026-06-01 | Copilot code review in private repositories started [consuming Actions minutes](https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/), on top of its AI credits.   |
| 2026-10-28 | Included usage became [one dollar-based pool](https://github.blog/changelog/2026-10-28-work-from-anywhere-with-a-new-connected-copilot-cloud-experience) shared by builds, cloud sandboxes and, on Team and Enterprise Cloud, larger runners. |

Included usage is now stated in dollars. $18 a month on Team buys 3,000
minutes of Linux 2-core, and $300 on Enterprise Cloud buys 50,000, the same as
the old minute quotas. What has changed is that more products now draw from
that pool, so it runs out sooner for teams that use Copilot code review or
cloud sandboxes.

## What the fee would cost

The announced charge is per minute a self-hosted runner works on a job. It's
the same for a 2-vCPU runner and a 64-vCPU runner.

| Minutes a month | Fee at $0.002 | GitHub-hosted 2-core ($0.006) | GitHub-hosted 4-core ($0.012) | GitHub-hosted 16-core ($0.042) |
| --------------- | ------------- | ----------------------------- | ----------------------------- | ------------------------------ |
| 20,000          | $40           | $120                          | $240                          | $840                           |
| 150,000         | $300          | $900                          | $1,800                        | $6,300                         |
| 1,000,000       | $2,000        | $6,000                        | $12,000                       | $42,000                        |

Two things follow from a flat per-minute fee:

- It weighs most on small runners. On a 2-core runner, $0.002 is a third of
  GitHub's own hosted price. On a 16-core runner it's under 5%.
- It weighs most on teams with many short jobs, such as lint and unit tests
  split into many parallel jobs, because the fee counts runner minutes, not
  the compute inside them.

For a concrete case, backmesh's [cost comparison](/cost/) puts 150,000 minutes
a month of 4-vCPU jobs on spot VMs at about $191–$365 including its control
plane, at spot prices on 2026-11-13. With the fee, that would be about
$491–$665, against $1,800 on GitHub's 4-core runners. The gap narrows by $300
and stays large. On 2-core runners the same arithmetic leaves less room: the
fee alone would be a third of the GitHub-hosted price.

## Who the fee would reach

As announced, the charge applies to any runner that registers with GitHub as
self-hosted and runs jobs in a private repository. That covers more setups
than "a server under a desk":

| Setup                                                                                                   | Would the fee apply?                                                  |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Runners you install on your own servers                                                                 | Yes                                                                   |
| [Actions Runner Controller](https://github.com/actions/actions-runner-controller) on Kubernetes         | Yes                                                                   |
| [terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner) on AWS | Yes                                                                   |
| Runner managers in your cloud account: backmesh, RunsOn, WarpBuild BYOC, Cirun                          | Yes                                                                   |
| Third-party runner services: Blacksmith, Depot, Namespace, Ubicloud and others                          | Yes, since their machines join as self-hosted runners                 |
| GitHub-hosted runners                                                                                   | No separate fee; GitHub says the charge is included in the new prices |
| Public repositories                                                                                     | No                                                                    |
| GitHub Enterprise Server                                                                                | No                                                                    |

The third-party services said so at the time.
[Blacksmith](https://www.blacksmith.sh/blog/actions-pricing) titled its post
"The GitHub Actions control plane is no longer free".
[Namespace](https://namespace.so/blog/github-pricing-dec16-2025) estimated a
25% cost increase for its average customer before adding an update about the
postponement.

## How to prepare

You don't need to change anything today. If you run self-hosted runners, or
are about to, these steps make a return of the fee a known number instead of a
surprise.

1. **Measure your self-hosted minutes.** Your org's billing page shows Actions
   usage by runner type. Multiply the self-hosted minutes in private
   repositories by $0.002. That's the monthly fee you'd plan for.
2. **Compare by runner size.** For each size you use, compare GitHub-hosted
   price with your runner's cost plus $0.002. Large runners stay well below
   GitHub-hosted. For 2-core jobs, run the numbers before assuming
   self-hosting still wins.
3. **Count your fixed costs.** Self-hosting has a fixed part: a Kubernetes
   cluster for ARC, Lambda and queues for the Terraform module, or a control
   plane such as backmesh's control plane VM and listener VM per org
   (t3.large and t3.small on AWS), about $74–$111 a month for one org. Add it to
   the per-minute numbers.
4. **Cut minutes you don't need.** The fee counts minutes, so minutes saved
   are fee saved. Two changes cost nothing:
   - Cancel superseded runs on the same branch with a `concurrency` group and
     `cancel-in-progress: true`.
   - Skip workflows that a change can't affect, with `paths` filters on
     `push` and `pull_request`.
5. **Merge tiny jobs.** Many one-minute jobs pay for setup each time. Fewer,
   larger jobs use fewer runner minutes for the same work.
6. **Keep the runner choice in one place.** If `runs-on` comes from a
   repository variable or a reusable workflow, moving jobs between
   GitHub-hosted and self-hosted runners is a one-line change when prices
   move.

To try your own numbers on GitHub-hosted runners and spot VMs in AWS, GCP and
Azure, use the [cost calculator](/calculator/). To compare the free,
open-source ways to run self-hosted runners, see
[ARC vs terraform-aws-github-runner vs backmesh](/blog/arc-vs-terraform-aws-github-runner-vs-backmesh/).

## Questions

**Does GitHub charge for self-hosted runners in 2026?** No. Self-hosted runner
usage is free as of 2026-11-18, per
[GitHub's billing docs](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

**Was the fee cancelled?** No, postponed. GitHub hasn't posted a new date in
the [announcement discussion](https://github.com/orgs/community/discussions/182186).

**How much would it cost?** $0.002 per minute of self-hosted runner use in
private repositories, at any runner size: $40 a month at 20,000 minutes, $300
at 150,000 and $2,000 at 1,000,000.

**Would it apply to Blacksmith, Depot or Namespace?** As announced, yes. Their
machines register with GitHub as self-hosted runners.

**Would it apply to backmesh?** Yes. backmesh's runners register as
self-hosted runners in your org, so the fee would apply to their minutes in
private repositories, the same as any other self-hosted runner.

**Do self-hosted minutes count against included usage?** Not today. Under the
announced change they would have.

**Do public repositories pay?** No. The announcement left public repositories
free, and standard GitHub-hosted runners stay free in them.

**Does GitHub Enterprise Server pay?** The announcement said GitHub
Enterprise Server customers weren't affected.

**Is self-hosting still cheaper?** Usually, for Linux jobs at volume. A 4-vCPU
spot VM costs roughly $0.0005 to $0.0019 a minute on AWS, GCP or Azure,
against $0.012 for GitHub's 4-core runner (backmesh's
[cost inputs](/cost/), 2026-11-13). Adding $0.002 keeps spot compute below
GitHub's 4-core price, but count the fixed cost of the setup too.

**Where can I check for updates?** GitHub's
[changelog](https://github.blog/changelog/) and the
[announcement discussion](https://github.com/orgs/community/discussions/182186).
We update this page when GitHub changes Actions pricing. Last checked
2026-11-18.
