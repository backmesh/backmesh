---
title: The runner image
description: What's in the image every backmesh job runs in, how a missing command installs on first use, and how to run a job in an image of your own.
---

Every label runs the same image: Ubuntu 24.04 with the GitHub Actions runner,
the Docker CLI, which uses the VM's Docker, and the apt packages GitHub's
`ubuntu-24.04` runners have, not their language toolchains, cloud CLIs or
browsers. It's built from a public Dockerfile and signed,
and each backmesh release names one image by its digest. The image is built
for x86-64 and arm64, with the same tools at the same versions; an
[arm64 label](/labels/#arm64)'s VM pulls the arm64 build, and the first-use
installs fetch arm64 releases there.

## What's in it

- The apt packages GitHub's Ubuntu 24.04 image installs, from the list in
  GitHub's [runner-images](https://github.com/actions/runner-images)
  repository: compilers and build tools (`gcc`, `g++`, `make`, `autoconf`,
  `pkg-config`), archive tools (`zip`, `unzip`, `7z`, `xz`, `zstd`), network
  tools (`curl`, `wget`, `ssh`, `rsync`, `dig`), `jq`, `shellcheck`, `sqlite3`,
  `xvfb` and the rest. backmesh follows GitHub's list as it changes.
- `git`, Git LFS and the GitHub CLI, `gh`.
- The Docker CLI with Buildx and Compose, using the VM's Docker.
- Node.js 22 with npm, and Yarn and pnpm through Corepack.
- Python 3 with `pipx`.
- `kubectl`, `helm`, `yq` and `envsubst`.

GitHub's image also preinstalls language toolchains, cloud CLIs, browsers
and databases. backmesh's doesn't, which keeps the image small enough for every
job to pull it on its own VM. [Coming from ubuntu-latest](/from-ubuntu-latest/)
lists them with the setup action for each.

## Languages come from setup actions

A job gets a language at the version it asks for from that language's setup
action, as it does on GitHub's runners:

```yaml
steps:
  - uses: actions/setup-node@v6
    with:
      node-version: 24
  - uses: actions/setup-python@v6
    with:
      python-version: '3.13'
```

`actions/setup-go`, `actions/setup-java`, `actions/setup-dotnet`,
`ruby/setup-ruby` and the other setup actions work the same way. Each job's VM
is new, so the action downloads its version in every job.

## A missing command installs on first use

When a `run:` step calls a command the image doesn't have, and a package in
Ubuntu's archive provides it, the step installs that package with apt and goes
on, with one line in its log:

```text
backmesh: installing ruby for ruby
```

The Azure, Google Cloud and AWS CLIs install on first use from each vendor's
signed packages.

apt checks the package against the archive's signature. A typo, or a command no
Ubuntu package provides, fails as usual with `command not found`. The first use
in a job takes a few seconds longer. To pin a version, or to install the package
before you need it, install it in a step of its own:

```yaml
- run: sudo apt-get install -y ruby-full
```

The image ships without apt's package lists, so the first apt command in a job
fetches them; an `apt-get update` of your own works too.

First-use install works for commands a bash step runs itself, as `run:` steps
do by default. A command started by another program, such as a tool a Makefile
or a Python script calls, isn't installed; install its package in an earlier
step. Neither is a command in a `shell: sh` step or in a job's `container:`.

## An image of your own

For tools Ubuntu doesn't package, or to match another image completely, run the
job in a container image that has them, with GitHub's
[`container:`](https://docs.github.com/en/actions/writing-workflows/choosing-where-your-workflow-runs/running-jobs-in-a-container).
The job's steps then run inside that image, on the job's own VM:

```yaml
jobs:
  build:
    runs-on: backmesh-ubuntu-2404-4vcpu
    container: mcr.microsoft.com/dotnet/sdk:9.0
```

Any image works, including one you build with exactly the tools your jobs need.
Each job's VM is new, so it pulls the image in every job.
