---
title: Uninstall
description: Delete an installation, its runners and its GitHub setup.
---

```sh
backmesh uninstall [--org <org>] [--yes] [--delete-checkpoint-bucket] [--confirm <name-or-id>] [--control-plane <cloud>:<region>]
```

It runs from any machine with your cloud sign-ins that targets the control
plane, as the one install ran on does, and asks before
deleting anything. It says how many jobs are running: those jobs fail. Pass
`--yes` to run it without a terminal.

For each org, in order, it:

1. Asks an owner of the org, or a member who manages its self-hosted
   runners, to sign in with GitHub, with a code to enter at
   `https://github.com/login/device`. The code is printed as plain lines, so a
   CI job shows it in its log. backmesh.com then gives `uninstall` an
   hour-long token that can manage only the org's self-hosted runners. The
   token stays in memory and is never saved. When the control plane's saved
   sign-in has expired, `uninstall` replaces it with a device code too.
2. Has the org's listener stop taking jobs and remove its runners, then stops
   the listener. When the whole control plane goes, it also stops anything
   else you deployed alongside the listeners, such as an older listener.
3. Deletes backmesh's scale sets, its leftover runners and the org's empty
   `backmesh-` runner groups from this control plane (from any, when no control
   plane is configured), and checks that none are left. It also deletes
   backmesh's scale sets in the `backmesh` group older releases used, but not
   that group.
4. Removes backmesh's GitHub App from the org and ends the installation's
   sign-in. While another backmesh installation in the org is running, the
   App stays (see below).

Then it ends any runner VM left and waits for it to go, then has the control
plane delete itself: its VMs, its cloud connections and its DNS name. It
prints what install left in each cloud: the role connection's setup, which
trusts only the deleted control plane, for you to delete in the cloud's console.

If anything fails, run the same command again: it picks up where it stopped. If it names an org to finish, run the `--org` command it gives. If no listener is running, pass `--org <org>` so `uninstall` knows which org to remove backmesh from. An install from 0.1.x also left its own per-org GitHub App, which an org owner deletes in the org's settings.

## When another installation is running

Another backmesh installation in the org that has used the App in the last
hour may still be serving jobs. With a control plane configured on this
machine, `uninstall` removes only this installation: its listener, its scale
sets, runners and `backmesh-` runner groups, and its control plane. The App,
the other installation's runners and the shared `backmesh` group's scale sets
stay, and `uninstall` names the other installation. Without its listener,
as after an install that failed, `uninstall` has no key to say which
installation it is, so backmesh.com refuses the token. It still deletes the
control plane and its cloud side. If no listener ever ran, nothing of the
installation is at GitHub. Otherwise it names the installation's runner groups
for you to delete in the org's Actions settings, and exits non-zero. Without a control plane
configured, backmesh.com refuses the token and nothing changes. If the other
installation's control plane is gone too, run `uninstall --org <org>` an hour
after its last token to remove the rest.
backmesh.com keeps an audit record of every request.

## When the control plane is gone

If the control plane doesn't answer, or none is targeted on this machine, pass
`--org <org>`: `uninstall` does steps 1, 3 and 4 for that org only. It removes
backmesh from the org's GitHub, says so, and lists what may be left: the
control plane's VMs, the runners' VMs, the checkpoint bucket and each cloud's
role connection setup.

To delete the cloud side too, also pass `--control-plane <cloud>:<region>` of
the control plane, as install planned it:

```sh
backmesh uninstall --org acme --control-plane aws:us-east-2
```

`uninstall` first checks, before changing anything, that the control plane's
cloud account is the one your cloud CLI is signed in to and that the control
plane is gone or stopped, or the installation is failed or mid-delete, which it
names in its question; otherwise it stops with the reason. It then removes
backmesh from GitHub, deletes the control plane and runner VMs through your
cloud CLI, and names anything left to delete in the console, such
as a runner's VM. `--control-plane` needs the control plane's address targeted on this
machine, as it is where install ran.

## Remove one org

When the control plane runs backmesh for several orgs, `uninstall --org <org>`
removes only that org, with steps 1 to 4. The control plane and the other orgs
stay. For the last org, or without `--org`, `uninstall` removes
everything.

## The checkpoint bucket

The checkpoint bucket holds the control plane's backups, and deleting it ends
any restore. `uninstall` deletes it only when you agree and type the
installation's name or ID, or, without a terminal, with
`--delete-checkpoint-bucket` and `--confirm <name-or-id>`. `--yes` alone never
deletes it.
