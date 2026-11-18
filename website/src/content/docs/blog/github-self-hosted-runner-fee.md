---
title: "GitHub's self-hosted runner fee: where it stands"
description: GitHub announced a $0.002 per minute fee for self-hosted runners in private repos, then postponed it. What is in effect in November 2026, what GitHub-hosted runners cost now, and what the fee would add.
lastUpdated: 2026-11-18
head:
  - tag: title
    content: 'GitHub self-hosted runner fee ($0.002/min): status in 2026 | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"GitHub''s self-hosted runner fee: where it stands","datePublished":"2026-11-18","dateModified":"2026-11-18","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/github-self-hosted-runner-fee/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Does GitHub charge for self-hosted runners in 2026?","acceptedAnswer":{"@type":"Answer","text":"No. As of 2026-11-18 GitHub''s billing docs list self-hosted runner usage as free. GitHub announced a $0.002 per minute charge for self-hosted runners in private repositories on 2025-12-16, to start on 2026-03-01, and postponed it on 2025-12-17. It has not announced a new date."}},{"@type":"Question","name":"Was the self-hosted runner fee cancelled?","acceptedAnswer":{"@type":"Answer","text":"It was postponed, not cancelled. GitHub said it would take time to re-evaluate its approach and that it has real costs in running the Actions control plane."}},{"@type":"Question","name":"What would the fee cost?","acceptedAnswer":{"@type":"Answer","text":"$0.002 for every minute a self-hosted runner works on a job in a private repository: $300 a month for 150,000 minutes, whatever the runner''s size."}},{"@type":"Question","name":"Did GitHub-hosted runner prices change?","acceptedAnswer":{"@type":"Answer","text":"Yes. From 2026-01-01 GitHub-hosted runners cost less: Linux 2-core went from $0.008 to $0.006 a minute and Linux 4-core from $0.016 to $0.012."}}]}]}'
---

As of 2026-11-18, GitHub doesn't charge for self-hosted runners. It announced
a $0.002 per minute fee for them in December 2025 and postponed it a day
later. There's no new date. GitHub's billing docs list self-hosted runner usage
as usage that
"[remains free](https://docs.github.com/en/billing/concepts/product-billing/github-actions)".

## What happened

| Date       | Change                                                                                                                                                                                                                                                                                    | In effect?            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 2025-12-16 | GitHub [announces](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/) lower GitHub-hosted prices from 2026-01-01, and a $0.002 per minute "cloud platform charge" on self-hosted runners in private repos from 2026-03-01. | Fee: no               |
| 2025-12-17 | GitHub [postpones](https://github.com/orgs/community/discussions/182186) the self-hosted charge "to take time to re-evaluate our approach".                                                                                                                                               | Still the latest word |
| 2026-01-01 | [Lower GitHub-hosted prices](https://github.blog/changelog/2026-01-01-reduced-pricing-for-github-hosted-runners-usage/) take effect.                                                                                                                                                      | Yes                   |
| 2026-10-28 | [Included usage becomes a dollar pool](https://github.blog/changelog/2026-10-28-work-from-anywhere-with-a-new-connected-copilot-cloud-experience) shared with cloud sandboxes and, on Team and Enterprise Cloud, larger runners.                                                          | Yes                   |

The postponement post says GitHub has "real costs in running the Actions
control plane". The fee was postponed, not withdrawn, so plan for it coming
back.

## What GitHub-hosted runners cost now

Private repositories, Linux x64, per minute, from
[GitHub's runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing),
read 2026-11-18:

| Runner         | Before 2026-01-01 | Now    |
| -------------- | ----------------- | ------ |
| Linux 2-core   | $0.008            | $0.006 |
| Linux 4-core   | $0.016            | $0.012 |
| Linux 8-core   | $0.032            | $0.022 |
| Linux 16-core  | $0.064            | $0.042 |
| Windows 2-core | $0.016            | $0.010 |

Included usage per month is now a dollar amount: $12 on Free, $18 on Pro and
Team, and $300 on Enterprise Cloud, the same as 2,000, 3,000 and 50,000
minutes of Linux 2-core.

## What the fee would add

The announced fee is per minute a self-hosted runner works on a job, the same
for every runner size. It would apply to every self-hosted runner, backmesh's
included, since they register with GitHub as self-hosted.

| Minutes a month | Fee at $0.002 | GitHub-hosted 4-core at $0.012 |
| --------------- | ------------- | ------------------------------ |
| 20,000          | $40           | $240                           |
| 150,000         | $300          | $1,800                         |
| 1,000,000       | $2,000        | $12,000                        |

At 150,000 minutes of 4-vCPU jobs, backmesh's
[cost comparison](/cost/) puts spot VMs and the control plane at about
$191–$365 a month, prices from 2026-11-13. With the fee, that becomes about
$491–$665, still below $1,800 on GitHub-hosted runners. The fee costs the same
whichever runner does the work, so it narrows the gap for small runners more
than for large ones.

To check your own numbers, use the [cost calculator](/calculator/).

## Questions

**Does GitHub charge for self-hosted runners in 2026?** No. Self-hosted runner
usage is free as of 2026-11-18, per GitHub's billing docs.

**Was the fee cancelled?** No, postponed. GitHub hasn't posted a new date in
the [announcement discussion](https://github.com/orgs/community/discussions/182186).

**Do public repositories pay?** No. The announcement left public repositories
free, and GitHub-hosted standard runners stay free in public repositories.

**Does GitHub Enterprise Server pay?** The announcement said GitHub Enterprise
Server customers weren't affected.

We update this page when GitHub changes its pricing. Last checked 2026-11-18.
