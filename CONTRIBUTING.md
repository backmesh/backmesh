# Contributing to backmesh

backmesh follows anycloud's
[CONTRIBUTING.md](https://github.com/anycloud-sh/anycloud/blob/main/CONTRIBUTING.md)
for code quality, pull requests, size estimates and code review, and the rules
in [AGENTS.md](AGENTS.md), including the A/B a speed claim needs before it
merges. Run `yarn verify` before you push. This file adds how a change is
live-tested before it ships.

## Live-test a change with a release candidate

Unit tests and CI can't show that a change works against a real cloud and a
real GitHub org. A change to install, upgrade, the listener or runner labels is
tested with a release candidate on the test org, `backmesh-dryrun`, before its
release is tagged. Don't hand-build a CLI for it.

1. Set `package.json`'s version to the release the change ships in, such as
   `0.6.2`. A maintainer tags `v0.6.2-rc.1` on the reviewed head of a branch in
   this repository, never a fork's:

   ```sh
   git tag -a v0.6.2-rc.1 <head-sha> -m "backmesh v0.6.2-rc.1"
   git push origin refs/tags/v0.6.2-rc.1
   ```

   [`release.yml`](.github/workflows/release.yml) builds it as a prerelease in
   this repository only, on the staging Worker, with no mirror, so `install.sh`
   and Homebrew don't see it.

2. Run [`e2e.yml`](.github/workflows/e2e.yml) on the test org twice: a fresh
   install, and an upgrade from the latest release.

   ```sh
   gh workflow run e2e.yml -f org=backmesh-dryrun -f version=v0.6.2-rc.1
   gh workflow run e2e.yml -f org=backmesh-dryrun -f version=v0.6.2-rc.1 -f from=v0.6.1
   ```

   Each install and uninstall prints a GitHub device sign-in, also commented on
   [#42](https://github.com/backmesh/backmesh/issues/42), for an admin of the
   test org to approve. Never point a candidate at an installation other people
   rely on.

3. Link the candidate and both runs in the pull request. A new head gets the
   next candidate, `rc.2`, and both runs again.

4. Once both pass on the head that merges, the release `v0.6.2` is tagged on
   `main` with its `docs/releases/v0.6.2.md`.
