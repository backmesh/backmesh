---
title: Why AI coding agents raise your GitHub Actions bill
description: AI coding agents such as Claude Code, Codex, Copilot coding agent and Cursor background agents open more pull requests and push more often, and every push runs CI. Volume data, a cost-per-PR formula, workflow YAML that cuts minutes, runner prices, and a worked monthly example.
date: 2026-11-18
lastUpdated: 2026-11-18
authors: backmesh
tags:
  - AI coding agents
excerpt: Teams that adopt Claude Code, Codex, Copilot coding agent or Cursor background agents often see their GitHub Actions bill jump. Why agent PRs cost more, how to measure cost per PR, the workflow changes that cut minutes, and what runners cost per minute in November 2026.
head:
  - tag: title
    content: 'AI coding agents and GitHub Actions costs: why bills rise and how to cut them | backmesh'
  - tag: script
    attrs:
      type: application/ld+json
    content: '{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","headline":"Why AI coding agents raise your GitHub Actions bill","datePublished":"2026-11-18","dateModified":"2026-11-18","author":{"@type":"Organization","name":"backmesh","url":"https://backmesh.com/"},"publisher":{"@id":"https://backmesh.com/#organization"},"mainEntityOfPage":"https://backmesh.com/blog/ai-coding-agents-github-actions-costs/"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Why did our GitHub Actions bill go up after we started using coding agents?","acceptedAnswer":{"@type":"Answer","text":"Agents open more pull requests and push to each one more often, and each push runs your workflows. Billed minutes grow with PRs times pushes per PR times job-minutes per push. Copilot code review has also used Actions minutes in private repositories since 2026-06-01."}},{"@type":"Question","name":"How much CI does an agent-heavy repository use?","acceptedAnswer":{"@type":"Answer","text":"One vendor-measured example from Sengi: a repository went from 224 PRs in May 2026 to 2,682 from 1 to 26 October, with a median of 147 job-minutes per merged PR, about 370,650 runner minutes in 26 days, or about $2,220 at GitHub''s 2-core price."}},{"@type":"Question","name":"How do I calculate CI cost per pull request?","acceptedAnswer":{"@type":"Answer","text":"Cost per PR equals pushes per PR times billed job-minutes per push times the price per minute, plus minutes from review bots. GitHub rounds each job up to a whole minute, so count each job separately."}},{"@type":"Question","name":"What is the fastest way to cut GitHub Actions minutes from agent PRs?","acceptedAnswer":{"@type":"Answer","text":"Add a concurrency group with cancel-in-progress: true so a new push cancels the run it replaces, skip draft PRs, and have the agent run lint and unit tests locally before it pushes."}},{"@type":"Question","name":"Should CI run on draft pull requests opened by agents?","acceptedAnswer":{"@type":"Answer","text":"Usually only the fast checks. Add the ready_for_review event to your pull_request types and gate the expensive jobs on the PR not being a draft."}},{"@type":"Question","name":"Does Copilot coding agent run my workflows automatically?","acceptedAnswer":{"@type":"Answer","text":"Not by default. GitHub''s docs say workflows do not run automatically when Copilot pushes to a pull request; a person clicks Approve and run workflows. The setting can be changed so they run without approval."}},{"@type":"Question","name":"Does Copilot code review use GitHub Actions minutes?","acceptedAnswer":{"@type":"Answer","text":"Yes, in private repositories since 2026-06-01, on top of its AI credits. Public repositories are not affected, and it also supports self-hosted runners."}},{"@type":"Question","name":"What are the cheapest CI runners for teams using AI coding agents?","acceptedAnswer":{"@type":"Answer","text":"For Linux jobs, self-hosted runners on spot VMs in your own cloud usually cost least per minute: a 4-vCPU spot VM was about $0.0005 to $0.0019 a minute on 2026-11-13, against $0.012 for GitHub''s 4-core runner. Managed services such as Blacksmith, Depot and Namespace list $0.002 to $0.006 a minute for small runners. Self-hosting adds a fixed cost and a VM boot per job."}},{"@type":"Question","name":"Do short agent pushes make self-hosted runners slower?","acceptedAnswer":{"@type":"Answer","text":"They can, because each job on a fresh VM waits for it to boot: about 30 seconds on AWS and 60 to 70 seconds on GCP and Azure with backmesh. backmesh starts runners ahead of a run''s later jobs, and a coding agent can run backmesh cue --in <seconds> when its pre-push checks start so the first jobs find runners too."}},{"@type":"Question","name":"Can a coding agent in a fresh sandbox cue backmesh?","acceptedAnswer":{"@type":"Answer","text":"Yes. A human copies a backmesh sign-in from ~/.backmesh/anycloud/.token on a signed-in machine into the sandbox secrets as BACKMESH_CUE_TOKEN, which backmesh cue uses first. It is that human''s full sign-in, so keep it secret."}}]}]}'
---

AI coding agents raise GitHub Actions bills because they open more pull
requests and push to each one more often, and every push runs your
workflows. A team's billed minutes are roughly PRs × pushes per PR ×
job-minutes per push. Agents push the first two numbers up at the same time.
Teams control it with three changes: cancel superseded runs, run fast checks
before slow ones, and move the minutes that remain onto cheaper runners.

Every price below links to its source and was checked on 2026-11-18.
Vendor-measured data is labeled as vendor data.

## What changed

Activity on GitHub grew sharply in 2026, and CI grew with it.

| Figure                                                                                                  | Source and date                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actions grew from 500M minutes a week in 2023 to 1B a week in 2025, and "2.1B minutes so far this week" | GitHub COO Kyle Daigle, early April 2026 ([post](https://x.com/kdaigle/status/2040164759836778878), quoted by [Simon Willison](https://simonwillison.net/2026/Apr/4/kyle-daigle/)) |
| CI jobs on Blacksmith grew "by 5–10% week over week" since the start of 2026                            | Blacksmith, vendor data, 2026-08-12 ([announcement](https://www.blacksmith.sh/blog/announcing-blacksmiths-series-b-led-by-peak-xv-partners))                                       |
| One repository went from 224 PRs in May 2026 to 2,682 from 1 to 26 October                              | Sengi, vendor data, measured 2026-10-26 ([post](https://sengi.run/blog/ai-coding-agents-github-actions-bill))                                                                      |
| Mastra "now merges over 1,800 PRs a month"                                                              | StarSling Launch HN, 2026-11-17 ([thread](https://news.ycombinator.com/item?id=50536468))                                                                                          |

The Sengi case is the most detailed public example. Its repository is
jacks.med's, a product built by Sengi's founders. In October, 1,740 of its
PRs carried Claude Code's attribution line and 549 mentioned Codex. A sample
of 25 merged PRs had a median of 147 job-minutes per PR. Sengi's estimate is
about 370,650 runner minutes in 26 days, or about $2,220 at GitHub's 2-core price.

Teams describe the same thing in their own words. One Hacker News commenter
wrote in October 2026 that "our Github Actions bill skyrocketed to over $2k /
mo" because "Coding agents were running a massive number of CI jobs"
([comment](https://news.ycombinator.com/item?id=50110118)). Another runs "a
~20-agent dev harness" and called it "Rough on your CI meter"
([comment](https://news.ycombinator.com/item?id=49612773)). StarSling's
founders wrote that "our CI bill got close to our inference bill"
([Launch HN](https://news.ycombinator.com/item?id=50536468)).

## Why agent PRs cost more

An agent PR usually runs more CI than a human PR of the same size. The
reasons are mechanical.

1. Agents push more often. An agent works in small steps, and many push after
   each step to see what CI says. On the seven most recent PRs Sengi checked,
   each had between 39 and 100 workflow runs.
2. Agents retry. When a test fails, the agent pushes a fix and CI runs again.
   A flaky test that a human would rerun once can cost an agent several full
   runs.
3. Every push runs the full suite. Most workflows were written for a few
   pushes a day per developer, so lint, unit tests, integration tests and
   Docker builds all run on every commit.
4. Agents open draft PRs. A draft PR runs the same `pull_request` workflows
   as a ready one unless the workflow checks for drafts.
5. Review bots run on Actions too. Copilot code review has consumed Actions
   minutes in private repositories since 2026-06-01, on top of its AI credits
   ([changelog](https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/)).
6. Short jobs round up. GitHub
   [rounds each job](https://docs.github.com/en/billing/reference/actions-runner-pricing)
   up to the nearest whole minute. A 20-second lint job bills as one minute,
   and an agent that pushes 50 times bills 50.

GitHub also changed what draws from the included allowance. Since 2026-10-28
it's one dollar-based pool shared by standard runners, cloud sandboxes
including Copilot's, and larger runners on Team and Enterprise Cloud. Sandbox
billing started in November 2026
([changelog](https://github.blog/changelog/2026-10-28-work-from-anywhere-with-a-new-connected-copilot-cloud-experience)).
Team includes $18 a month and Enterprise Cloud $300
([billing docs](https://docs.github.com/en/billing/concepts/product-billing/github-actions)),
so a team that uses Copilot cloud sessions runs out of included usage sooner.

Copilot coding agent is the one agent with a default brake. GitHub's docs say
workflows "will not run automatically when Copilot pushes changes to a pull
request"; someone clicks "Approve and run workflows"
([docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/review-copilot-prs)).
Teams that turn approval off get the same volume as with other agents.

## Measure cost per PR

Before changing workflows, find out what a PR costs now. The formula:

```text
cost per PR = pushes per PR × billed job-minutes per push × price per minute
            + review-bot minutes per PR × price per minute

billed job-minutes per push = sum over jobs of ceil(job minutes)
monthly CI cost = PRs per month × cost per PR − included usage
```

Use runner minutes from your org's billing usage report, and count PRs and
workflow runs per PR from the repository. Track it per author, so you can
compare agent PRs with human ones.

For Sengi's example, 147 job-minutes per merged PR on 2-core runners at
$0.006 a minute is about $0.88 per PR. At 2,518 merged PRs in 26 days, that's
about the $2,220 above. Cutting pushes per PR or minutes per push cuts the bill in
direct proportion.

## Workflow controls

Each change below is plain GitHub Actions YAML. They work on any runner.

### Cancel superseded runs

When an agent pushes again, the previous run's result no longer matters.
A [concurrency group](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
with `cancel-in-progress` stops it:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.head_ref || github.run_id }}
  cancel-in-progress: true
```

`github.head_ref` is the PR's branch. On pushes to `main` it's empty, so each
run gets its own group and none is cancelled.

### Skip drafts for expensive jobs

Run the fast checks on drafts and the rest only when the PR is ready. Add
`ready_for_review` so the full suite runs when the agent marks it ready:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  integration:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make integration
```

### Filter by path

A change to docs shouldn't build the backend. `paths` filters skip whole
workflows:

```yaml
on:
  pull_request:
    paths:
      - 'services/api/**'
      - 'go.mod'
      - 'go.sum'
```

A workflow skipped by a path filter leaves its checks pending, and a PR that
requires them can't merge
([docs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)). Keep required checks in workflows without path
filters, or use a job-level filter that reports success when it skips.

### Fast checks first, the rest gated

Put lint and unit tests first and make the slow jobs wait on them with
`needs`. A failing lint then costs one short job. Labels let a human or an
agent opt a PR into the most expensive suite, and the merge queue runs it
before merge:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, labeled]
  merge_group:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make lint unit

  test:
    needs: lint
    if: github.event_name == 'merge_group' || github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make test

  e2e:
    needs: test
    if: >-
      github.event_name == 'merge_group' ||
      contains(github.event.pull_request.labels.*.name, 'run-e2e')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make e2e
```

### Use a merge queue

GitHub's [merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
tests each PR combined with the latest base branch and the PRs ahead of it.
Workflows need the `merge_group` event to run there. With the queue as the
place where the full suite must pass, PR pushes can run a smaller set. The
queue's build concurrency setting, 1 to 100, caps how many queue builds run
at once.

### Run checks in the agent before it pushes

Tell the agent, in
`AGENTS.md` or `CLAUDE.md`, to run the same lint and unit tests locally and
push only when they pass, and to push once per finished change instead of
after every step:

```md
Before every push, run `make lint unit`. Push only when they pass. Push once
when the change is complete, not after each step.
```

The agent's own machine or sandbox then catches the failures that would have
cost a full CI run each.

## Runner choices

Once the minutes are down, the price per minute decides the rest. Prices for
Linux x64, checked 2026-11-18:

| Runner                                                                               | 2 vCPU, $/min                | 4 vCPU, $/min                | Notes                                                        |
| ------------------------------------------------------------------------------------ | ---------------------------- | ---------------------------- | ------------------------------------------------------------ |
| [GitHub-hosted](https://docs.github.com/en/billing/reference/actions-runner-pricing) | 0.006                        | 0.012                        | 8-core 0.022, 16-core 0.042; each job rounded up to a minute |
| [Blacksmith](https://www.blacksmith.sh/pricing)                                      | 0.004 (listed x64 rate)      | not listed separately        | 3,000 free minutes a month                                   |
| [Depot](https://depot.dev/pricing)                                                   | 0.006                        | not listed on the main page  | Plans from $20 a month with 2,000 minutes                    |
| [Namespace](https://namespace.so/pricing)                                            | 0.002 prepaid, 0.003 overage | 0.004 prepaid, 0.006 overage | 4 GB and 8 GB shapes; more memory costs more                 |
| Self-hosted on spot VMs ([backmesh cost inputs](/cost/), 2026-11-13)                 | n/a                          | about 0.0005 to 0.0019       | Plus a fixed control plane and a VM boot per job             |

Managed services run the machines for you, and their minutes bill like
GitHub's. Self-hosted runners in your own cloud use your account's spot
prices and cloud credits, but someone has to run the setup. The free,
open-source options are Actions Runner Controller on Kubernetes,
terraform-aws-github-runner on AWS, and backmesh on AWS, GCP and Azure. They
are compared in
[ARC vs terraform-aws-github-runner vs backmesh](/blog/arc-vs-terraform-aws-github-runner-vs-backmesh/).
GitHub announced a $0.002 a minute fee for self-hosted runners in December
2025 and postponed it; the status is in
[GitHub's self-hosted runner fee](/blog/github-self-hosted-runner-fee/).

backmesh runs each job on its own spot VM in your account and deletes it when
the job ends. It's free and open source under Apache-2.0. It runs Linux
x86-64 jobs in private repositories only, with no macOS, Windows or Arm
runners. When spot reclaims were a run's only failures, it reruns the failed
jobs, preferring an on-demand runner, at most twice ([FAQ](/faq/)).

## Boot time and many short pushes

Agents make one problem of self-hosted runners worse. Each push starts a new
run, and on runners that boot a fresh VM per job, the run's first jobs wait
for that boot. On backmesh that's about 30 seconds on AWS and 60 to 70
seconds on GCP and Azure. For a lint job that takes 20 seconds, the wait is
longer than the job.

backmesh handles a run's later jobs by learning each workflow's shape from
past runs and starting runners ahead of the jobs it predicts. The first jobs
of a run can't be predicted that way, because nothing tells backmesh a push
is coming.

A coding agent can tell it. When its pre-push checks start, the agent runs:

```sh
backmesh cue --in 120
```

with the seconds until it expects to push, from 30 to 600, at least 60
recommended. backmesh then starts runners for the run's first jobs, so they
are booted when the push lands. If the agent decides not to push, it runs
`backmesh cue --cancel`. The agent pushes even if `cue` fails; when
backmesh.com is down, the cue is dropped and CI starts cold, as it would
without one. The [agent instructions](/SKILL.md) include a line to add to
`AGENTS.md` or `CLAUDE.md`.

A cue tells api.backmesh.com your org, your GitHub user and the time, with a
random tag for the push. The repo and branch are sent only encrypted to your
listener's key, and the commit is never sent. A runner started for a cue
that no job takes bills for its boot and a short idle time.

Agents in sandboxes that start fresh each time can't keep a sign-in. For
those, a human copies `~/.backmesh/anycloud/.token` from a machine where
backmesh is signed in into the sandbox's secrets as `BACKMESH_CUE_TOKEN`,
which `backmesh cue` uses first. It's that person's full backmesh sign-in, so
treat it as a secret ([FAQ](/faq/#how-fast-do-jobs-start)).

## A worked monthly example (hypothetical)

This team is hypothetical. Its agents open 1,500 PRs a month. Each PR gets 6
pushes, and each push runs 5 jobs of about 4 minutes on 4-vCPU runners, so 20
job-minutes per push.

Before any changes, on GitHub's 4-core runners:

- 1,500 × 6 × 20 = 180,000 minutes.
- 180,000 × $0.012 = $2,160, before Team's $18 of included usage.

After the workflow changes, suppose 3 of the 6 pushes are cancelled
mid-run, skipped as drafts or stopped by a failed lint, and each costs one
2-minute job instead of 20 minutes. The other 3 run the full 5 jobs.

- Full runs: 1,500 × 3 × 20 = 90,000 minutes.
- Short runs: 1,500 × 3 × 2 = 9,000 minutes.
- Total: 99,000 minutes, or 99,000 × $0.012 = $1,188 on GitHub's 4-core
  runners.

The same 99,000 minutes on backmesh, using the spot prices and control plane
costs from backmesh's [cost inputs](/cost/) (2026-11-13). Jobs: 1,500 × 3 × 5 + 1,500 × 3
× 1 = 27,000, each paying one boot.

| Cloud | Spot $/h      | 99,000 min of compute | 27,000 boots | Control plane | Month     |
| ----- | ------------- | --------------------- | ------------ | ------------- | --------- |
| AWS   | 0.0497–0.07   | $82–$116              | $11–$16      | $86           | $179–$217 |
| Azure | 0.0318–0.0381 | $52–$63               | $14–$20      | $111          | $178–$194 |
| GCP   | 0.0899–0.1165 | $148–$192             | $40–$61      | $74           | $263–$327 |

For example, AWS's low end is $86 + 99,000 × $0.0497 ÷ 60 + 27,000 × 30 s ×
$0.0497 ÷ 3,600 = $179.19. These figures leave out disks, about $0.01 an
hour per runner on AWS, and runners started ahead that no job takes. In this
example the workflow changes cut the bill from $2,160 to $1,188, and the
runner change cut the rest to about $178–$327.

To run your own numbers, use the [cost calculator](/calculator/). More ways
to cut minutes that apply with or without agents are in
[how to reduce GitHub Actions costs](/blog/how-to-reduce-github-actions-costs/).
To set up backmesh, see [install](/install/).

## Questions

**Why did our GitHub Actions bill go up after we started using coding
agents?** Agents open more pull requests and push to each one more often, and
each push runs your workflows. Billed minutes grow with PRs × pushes per PR ×
job-minutes per push. Copilot code review has also used Actions minutes in
private repositories since 2026-06-01.

**How much CI does an agent-heavy repository use?** One vendor-measured
example from [Sengi](https://sengi.run/blog/ai-coding-agents-github-actions-bill):
a repository went from 224 PRs in May 2026 to 2,682 from 1 to 26 October, with a
median of 147 job-minutes per merged PR, about 370,650 runner minutes in 26
days, or about $2,220 at GitHub's 2-core price.

**How do I calculate CI cost per pull request?** Cost per PR equals pushes per
PR × billed job-minutes per push × price per minute, plus minutes from review
bots. GitHub rounds each job up to a whole minute, so count each job
separately.

**What is the fastest way to cut GitHub Actions minutes from agent PRs?** Add
a concurrency group with `cancel-in-progress: true` so a new push cancels the
run it replaces, skip draft PRs, and have the agent run lint and unit tests
locally before it pushes.

**Should CI run on draft pull requests opened by agents?** Usually only the
fast checks. Add the `ready_for_review` event to your `pull_request` types and
gate the expensive jobs on the PR not being a draft.

**Does Copilot coding agent run my workflows automatically?** Not by default.
GitHub's docs say workflows don't run automatically when Copilot pushes to a
pull request; a person clicks "Approve and run workflows". The setting can be
changed so they run without approval.

**Does Copilot code review use GitHub Actions minutes?** Yes, in private
repositories since 2026-06-01, on top of its AI credits. Public repositories
are not affected, and it also supports self-hosted runners.

**What are the cheapest CI runners for teams using AI coding agents?** For
Linux jobs, self-hosted runners on spot VMs in your own cloud usually cost
least per minute: a 4-vCPU spot VM was about $0.0005 to $0.0019 a minute on
2026-11-13, against $0.012 for GitHub's 4-core runner. Managed services such
as Blacksmith, Depot and Namespace list $0.002 to $0.006 a minute for small
runners. Self-hosting adds a fixed cost and a VM boot per job.

**Do short agent pushes make self-hosted runners slower?** They can, because
each job on a fresh VM waits for it to boot: about 30 seconds on AWS and 60 to
70 seconds on GCP and Azure with backmesh. backmesh starts runners ahead of a
run's later jobs, and a coding agent can run `backmesh cue --in <seconds>`
when its pre-push checks start so the first jobs find runners too.

**Can a coding agent in a fresh sandbox cue backmesh?** Yes. A human copies a
backmesh sign-in from `~/.backmesh/anycloud/.token` on a signed-in machine
into the sandbox's secrets as `BACKMESH_CUE_TOKEN`, which `backmesh cue` uses
first. It's that human's full sign-in, so keep it secret.
