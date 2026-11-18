# Public-repos live check

For maintainers: `--public-repos` is not supported for customers yet.

The paid live check for public-repository support. It runs on a public repo whose org has an install with `--public-repos`, from a
second GitHub account's fork. It needs a second account, so it's a runbook,
not an E2E member.

## Setup

1. Install, or re-run install, with `--public-repos` on the org.
2. Set GitHub's "Require approval for all external contributors" for the org.
3. Create a public repo in the org, such as `public-repos-check`. Push
   [`target/`](target/)'s three workflows to its `.github/workflows/` on
   `main`. `seed.yml` runs on that push and saves the entry the fork's cache
   job reads.
4. Confirm each repo being turned on has no job that outsiders can trigger
   (`issues`, `issue_comment`, `discussion`, `fork`, `watch`,
   `pull_request_target`, or a `workflow_run` after a fork's run) on a backmesh
   label other than `backmesh-public-*`.

## Cases

1. **Fork.** From the second account, fork the repo, change a line, and open
   a pull request. Check that the run is `action_required` until approved
   (the approval gate). Then approve it.
2. **Same repo.** Open a pull request from a branch of the repo itself, with
   the same change.
3. **Idle runner.** Repeat case 1 once while a planner runner is idle on
   `backmesh-kvm-4`: `backmesh cue` a push to `main` in a private repo that
   uses it, then open the fork's PR within the cue's lead.
4. **Restart.** While case 1's `limit` job is about 30 minutes in, roll the
   listener (`backmesh upgrade`, or scale its Deployment to 0 for a minute and
   back).
5. **Listener down.** With a planner runner idle on `backmesh-kvm-4` (as in
   case 3), scale the listener's Deployment to 0, open a third fork pull
   request, approve it, wait until its job starts on the idle runner, then
   scale the listener back to 1.

Then, after the `limit` job's 60 minutes:

```sh
GH_TOKEN=$(gh auth token) node benchmarks/public-repos/check.ts <owner/repo> <fork PR> <same-repo PR>
```

It checks that:

- the fork's `private-labels` run is cancelled, with its note, and that any of
  its jobs that started on an idle runner ran at most 60 s;
- the same-repo run of `private-labels` succeeds on every cloud's label;
- the fork's public jobs never held more than 32 vCPUs at once (the 10 `cap`
  jobs alone would hold 40);
- the `limit` job is cancelled between 60 and 66 minutes in, with its note,
  despite the restart;
- the `cache` job restored `main`'s entry and its grants have no own prefix.

Run the checker again with case 3's and case 5's fork pull requests in place
of case 1's: their `private-labels` checks are the ones that apply.

From the listener's log (`backmesh logs --org <org>`), check three more things:

- each `untrusted job on a private label` line is followed by its runner
  Job's end within 60 s;
- after case 4's restart, `runtime limit timed from the sweep` names the
  `limit` job's runner before its `runtime limit` line;
- after case 5's return, its job's `untrusted job on a private label` line
  comes within 5 minutes, from the sweep.

The `limit` job's last `heartbeat` line, against its `JobStarted`, gives the
time a terminated job keeps running, which replaces the
estimate.

Record the run IDs and the checker's output with the release's tracker.

## Cost

Under $2 on AWS spot: one 2-vCPU hour for `limit`, about 10 minutes of
8 × 4 vCPUs for `cap`, and three small same-repo jobs on AWS, GCP and Azure.
The fork's private-label jobs cost at most an idle runner's few seconds.
