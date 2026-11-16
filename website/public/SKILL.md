---
name: backmesh
description: Set up backmesh, self-hosted GitHub Actions runners on spot VMs in the user's own AWS, GCP or Azure accounts, then use it. Use when asked to install, use, check or remove backmesh, to move GitHub Actions jobs onto backmesh runners, or at least a minute ahead of every `git push`, when the pre-push checks start, in a repo whose workflows use `runs-on: backmesh-*`.
---

# backmesh

backmesh runs each GitHub Actions job on its own VM in the user's own clouds.
One `backmesh install` sets it up for one GitHub org. Where this file and the
CLI disagree, follow the CLI's messages and `backmesh <command> --help`.

## Rules

- Stop and ask the human at every point marked **Human**. Never answer a
  prompt for them, pipe input into one, or work around one.
- Never pass `--yes` unless the human has read the plan it agrees to and told
  you to.
- Never ask for, paste, print or commit secrets: cloud keys, GitHub tokens, or
  what is in `~/.backmesh`.

## 1. Install the CLI

On macOS or Linux:

```sh
curl -fsSL https://backmesh.com/install.sh | sh
```

Or `brew install backmesh/tap/backmesh`. Then run `backmesh --version`.

## 2. Prerequisites

1. **Human:** confirm who owns the GitHub org. During install, the org owner
   enters a code on GitHub, and installs the App if it isn't on the org yet.
   Only the org's private repositories can use the runners. An org that
   restricts OAuth apps approves backmesh first
   (https://backmesh.com/faq/#installing).
2. Each cloud the human wants needs its CLI signed in: `aws`, `gcloud` with
   a project, or `az` with a subscription. The plan in section 3
   prints a fix for anything missing; ask the human to run it. The signed-in
   identity needs the rights at
   https://backmesh.com/security/#what-install-needs.

## 3. Install

Ask the human for the org, the control plane's cloud and region, and the
runners' clouds. Always pass `--org`; without a terminal, install won't ask
for one. Show them the plan first; it signs in to nothing and changes
nothing:

```sh
backmesh install --org <org> --control-plane aws:us-east-2 --runners aws --runners gcp --plan
```

`--runners` repeats, one cloud each — never a region, which backmesh fixes
per cloud and narrows to what the account allows. Without either flag, both
go on the signed-in cloud in US East. The plan shows prices, quotas and the
full install command.

**Human:** the human reads the plan and runs install, without `--plan`, in a
terminal they can type into. If they tell you to run the printed
`--yes --plan-id` command instead, run it and show them every line. Install
stops for them twice:

1. **Human:** `Proceed?`, before anything is billed, and, when adding an org
   to a shared control plane, whether all its orgs have the same owner.
2. **Human:** install prints a code. The org owner enters it at
   `https://github.com/login/device` on any device. If the App isn't on the org
   yet, install prints GitHub's install link; the owner opens it and installs
   the App. Nothing is copied back.

Install prints the label to use and runs `backmesh status`. If it stops, fix
the cause it names and run the same command again.

## 4. Use the labels

Set a job's `runs-on` to a label. Ask before changing workflows others use.

```yaml
jobs:
  test:
    runs-on: backmesh-4
```

- Sizes: `backmesh-2`, `backmesh-4` (the default), `backmesh-8` and
  `backmesh-16`, at 4 GiB of memory per vCPU.
- The control plane's cloud has the plain labels; others name their cloud,
  such as `backmesh-gcp-4`.
- Spot is the default. On-demand labels, such as `backmesh-od-4`, cost about 2
  to 5 times spot. When spot reclaims were a run's only failures, backmesh
  reruns its failed jobs on demand, at most twice; add `backmesh-noretry` to
  `runs-on` to turn that off.
- `backmesh-kvm-4` and the like give a job `/dev/kvm`.

Full list: https://backmesh.com/labels/.

## 5. Cue each push

In a repo whose workflows use backmesh labels, when your pre-push checks
start, run this with the seconds until you expect to push:

```sh
backmesh cue --in 120
```

The CLI accepts 30 to 600; use at least 60. Push even if it fails. If you
won't push soon after all, run `backmesh cue --cancel`. Pass
`--branch <branch>` when you'll push another branch than the current one, and
`--repo <owner/name>` when `origin` isn't the GitHub repo.

When it says it isn't signed in, run `backmesh cue --sign-in --in <seconds>`.
**Human:** a GitHub user who can push to the repo enters the printed code at
`https://github.com/login/device`. For sandboxes that start fresh each time,
see https://backmesh.com/faq/#how-fast-do-jobs-start.

Ask the human whether to add this line to the repo's `AGENTS.md` or
`CLAUDE.md`, and add it only if they agree:

```md
Run `backmesh cue --in <seconds until the push>` (at least 60, at most 600) when your pre-push checks start; push even if it fails.
```

## 6. Check

- `backmesh status` shows runners, queue, cost, checks and why runners are
  short.
- `backmesh logs --org <org>` shows the listener's log, and
  `backmesh logs <runner>` a runner's; `-f` follows.
- **Human:** run `backmesh upgrade` only when the human asks
  (https://backmesh.com/upgrade/).

## 7. Uninstall

**Human:** only when the human asks. Give them `backmesh uninstall` to run in
a terminal; it asks before deleting anything, and an org admin enters a
printed code at `https://github.com/login/device`. Never add `--yes`,
`--delete-checkpoint-bucket` or `--confirm` unless the human tells you to. See
https://backmesh.com/uninstall/.
