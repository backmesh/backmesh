---
title: Upgrade
description: Move an installation to a new backmesh release.
---

```sh
backmesh upgrade
```

`upgrade` moves the installation to the release of the `backmesh` CLI you run, so
install the release you want first: run
`curl -fsSL https://backmesh.com/install.sh | sh` again, or
`brew upgrade backmesh`. It runs from the machine that installed
it, or any machine that targets its control plane, with no Docker. It moves
every org on the control plane, so it takes no `--org`.

It checks that the release supports the installation's control plane, upgrades
the control plane, then restarts each org's listener on the new image, one at
a time. Running jobs keep going on their VMs through the listener's restart;
only scaling pauses. A listener whose VM is gone gets a new VM, from the
settings the control plane keeps, and one that stopped is started again,
both before upgrade plans anything, so `--plan` works only after a run
without it; one whose token the control plane refuses, such as after a
restore from an older backup, gets a new token. An install from before
v0.5.0, whose listeners share one node, runs `upgrade` with backmesh v0.5.5
first, which moves each listener to its own VM.

It plans each org's labels again from the release's catalog, with each
cloud's [regions](/install/#regions) recomputed the same way install's are —
the fixed candidate list, narrowed to what your account allows — never kept
from an earlier run, so a region that's added or an account policy that
changes reaches an existing org on its next `upgrade`. To add a cloud, run
`backmesh install`.

Right after the control plane updates, and before any listener restarts,
`upgrade` re-applies the role setup of each runner cloud whose role this
release changes, through your signed-in cloud CLI, as install made it: a
release's runners can need rights the role doesn't have yet. So `upgrade`
needs that cloud's CLI signed in, AWS's to the account install used, and it
checks this before the control plane updates. Once the control plane is
current, `--plan` names each role. It runs on every `upgrade`, and changes
nothing when the role already matches. If it stops there, sign in as it says
and run `backmesh upgrade` again; runners that start before it finishes can
fail to launch, and their jobs get new runners once it has. A cloud connected
with keys instead of a role has no setup to re-apply: `upgrade` prints the
rights its identity needs and the command that grants them.

Pass `--runners <cloud>` (repeatable) to list every cloud the runners keep: a
cloud you leave out is removed. Its labels stop taking jobs, its runners
finish the jobs GitHub already assigned to them, and then its scale sets are
deleted. The control plane stays where it is, even when you remove its
cloud's runners. For example, to keep only AWS:

```sh
backmesh upgrade --runners aws --plan
```

When the new release, or `--runners`, changes an org's runners (labels added or
removed, a cloud removed, or regions), `upgrade` shows that plan first and asks
before changing them; a release that moves only the images asks nothing. To see the plan
without changing anything, add `--plan` (`--json` prints it as JSON), then pass
the ID it prints:

```sh
backmesh upgrade --plan
backmesh upgrade --yes --plan-id p-3f9a1c2b7e4d
```

When a new backmesh release also updates the control plane, `upgrade` updates
it first; your runners keep running, and `--plan` works only after that. If the
control plane is too old to update, `upgrade` says so before changing anything:
uninstall with the backmesh release that installed it, then install again. If
`upgrade` stops after updating the control plane, your listener is unchanged
and the next `backmesh upgrade` finishes.

Without a terminal, a change to the runners needs `--yes --plan-id`. A label
the new release removes stops taking jobs, and its scale set is deleted once
no job runs on it. If a listener's restart fails, `upgrade` puts it back on its
old image and settings, and stops before the next org.

`upgrade` ends with the `status` checks. Their warnings don't change its exit
code: it exits 0 once the upgrade is done, and `backmesh status` shows them
again.

## Run install again

Running `backmesh install` again reuses what an earlier run created, including
the control plane and the clouds already connected. A re-run whose saved
control plane answers, and is already running backmesh, skips creating it, so
that cloud's CLI isn't needed at all. The control plane stays where it is;
`--control-plane` can't move it. A re-run for an org whose listener already has
its install key keeps that key.

Its plan shows what would change in your org's runners: clouds and regions
added or left, and labels that start or stop taking jobs. A label that stops
takes no new job: jobs GitHub already assigned to it get runners first, then
its scale set is deleted, and a job sent to it later never runs, so move its
workflows first. Once you agree, install saves the change and restarts the
listener; running jobs keep going. With nothing to change, it says so. Without
`--runners`, a re-run keeps the runners as they are. It runs only with the
backmesh release the installation runs; `backmesh upgrade` moves releases.

## Sign-in

Before it changes your listener, `upgrade` checks that `api.backmesh.com`
still accepts the install key the installation saved when you signed in with
GitHub during install.

An installation made before the GitHub sign-in asks for it once. The App is
already on your org, so `upgrade` prints a code to enter at
`https://github.com/login/device` on any device. So does one whose sign-in backmesh
no longer accepts. A code that expires is replaced by a new one.

A backmesh CLI from v0.4.3 or earlier can't sign in any more: it signs in
through an OAuth app backmesh retired. Install the current CLI first
(`curl -fsSL https://backmesh.com/install.sh | sh`), then upgrade.

If `api.backmesh.com` can't be reached during that sign-in, `upgrade` stops
without changing your listener: the new listener needs the sign-in to start. Retry when it's reachable. `upgrade` also stops when any org's listener doesn't answer,
since it can't read the saved sign-in; check `backmesh status` first.
