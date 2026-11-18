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
only scaling pauses.

It plans each org's labels again from the release's catalog, with each
cloud's [regions](/install/#regions) recomputed the same way install's are —
the fixed candidate list, narrowed to what your account allows — never kept
from an earlier run, so a region that's added or an account policy that
changes reaches an existing org on its next `upgrade`. It reads no regions
through your cloud CLI. To add a cloud, run `backmesh install`.

On AWS, `upgrade` then lowers the control plane's two disks to gp3's baseline,
3,000 IOPS and 125 MiB/s, in place through your signed-in AWS CLI, with no
restart. Installations from before backmesh v0.4.2 have faster disks, which cost about $85 a month
more. Lowering them needs `ec2:DescribeInstances`, `ec2:DescribeVolumes` and
`ec2:ModifyVolume`. Without them, or within 6 hours
of a disk's last change, `upgrade` says so and finishes; run it again later.

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
no longer accepts.

If `api.backmesh.com` can't be reached during that sign-in, `upgrade` stops
without changing your listener: the new listener needs the sign-in to start. Retry when it's reachable. `upgrade` also stops when any org's listener doesn't answer,
since it can't read the saved sign-in; check `backmesh status` first.
