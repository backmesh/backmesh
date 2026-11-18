# Contributing to backmesh

backmesh follows anycloud's
[CONTRIBUTING.md](https://github.com/anycloud-sh/anycloud/blob/main/CONTRIBUTING.md)
for code quality, pull requests, size estimates and code review. This file adds
what is specific to backmesh. Run `yarn verify` before you push.

## Live-test an unreleased build with a release candidate

Unit tests and CI can't show that a change works against a real cloud and a
real GitHub org. When a change needs that, such as a new runner label, install
or upgrade behaviour, or the listener, test it with a release candidate before
merging. Don't hand-build a CLI for it.

1. A maintainer pushes a `vX.Y.Z-rc.N` tag on the pull request's head commit,
   for example `v0.4.3-rc.1`:

   ```sh
   git tag -a v0.4.3-rc.1 <head-sha> -m "backmesh v0.4.3-rc.1"
   git push origin refs/tags/v0.4.3-rc.1
   ```

2. [`release.yml`](.github/workflows/release.yml) runs it as a qualification
   build. It publishes the listener and runner images, attaches
   `compatibility.json` naming their digests and the anycloud version, and
   builds the CLI binaries that embed it. The release is a prerelease in this
   repository only: no release notes, no mirror to `backmesh/backmesh-releases`
   (so `install.sh` and Homebrew don't see it) and no formula.
3. Install the candidate's CLI from that prerelease:

   ```sh
   gh release download v0.4.3-rc.1 --repo backmesh/backmesh --pattern backmesh-linux-x64.tar.gz
   tar -xzf backmesh-linux-x64.tar.gz && ./backmesh --version
   ```

4. Run it against a **test org and a test cloud account**: `backmesh install`
   or `backmesh upgrade` there, then the jobs the change needs. Never point a
   candidate at an installation other people rely on, including our own CI's.
5. Put the evidence in the pull request: the candidate's tag, the runs, and
   what you checked. Uninstall the test installation when you're done.

Number candidates from `rc.1` and bump `N` for each new head. The final release
is tagged on `main` after the pull request merges, as usual.
