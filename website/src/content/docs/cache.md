---
title: Cache
description: Cache dependencies and build outputs in a bucket in your own cloud, next to the runners, with a drop-in replacement for actions/cache.
head:
  - tag: title
    content: Cache for self-hosted GitHub Actions runners | backmesh
  - tag: meta
    attrs:
      property: og:title
      content: Cache for self-hosted GitHub Actions runners | backmesh
---

backmesh keeps caches in a bucket in your own cloud account, in the same region
as the runner, so a restore never leaves the region. Use `backmesh/cache` where
a workflow uses `actions/cache`: it takes the same inputs and sets the same
outputs.

```yaml
- uses: backmesh/cache@v1
  with:
    path: |
      ~/.npm
      node_modules
    key: npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
    restore-keys: npm-${{ runner.os }}-
```

`backmesh/cache/restore@v1` and `backmesh/cache/save@v1` replace
`actions/cache/restore` and `actions/cache/save`. On a runner that isn't
backmesh's, such as GitHub's own, the action uses GitHub's cache, so a workflow
that also runs there needs no change.

## How it's faster

- **A restore fetches in parallel.** A cache is split by file into up to 32
  pieces, each compressed with zstd, or stored as is when its files are
  already compressed. A restore downloads every piece at once and unpacks each
  in its own process.
- **A save takes no time in the job.** The save step only takes a snapshot of
  the files and returns. The runner uploads the cache after the job ends,
  before its VM goes, so the job finishes sooner.

Because the upload happens after the job, a job that starts right after the
job that saved a cache, such as one that `needs:` it, can miss that cache if it
starts before the upload ends. Each job starts on a new VM, which usually takes
longer than the upload.

A save keeps a snapshot of the files as they were when it ran. If a later step
writes to one of those files in place, the save is dropped rather than storing
a half-written file, and the next run saves again. Put a cache whose tool
rewrites its files in place, such as Go's build cache, in `backmesh/cache`'s
own save at the end of the job, not in a `save` step followed by more steps.

## Automatic caches

On backmesh's runners, every job also gets two caches without any workflow
change:

- **Tools.** The versions that `actions/setup-node`, `setup-python`,
  `setup-java`, `setup-go` and the other `setup-*` actions put on `PATH` are
  saved once per repository. They're restored into the runner's tool cache
  in the job's next run, where a `setup-*` step that runs after the restore
  finds them. A tool a step changed after setup isn't saved, such as a Python
  that `pip install` wrote into outside a virtual environment. A saved tool
  lasts 7 days; after that, `setup-*` fetches the latest patch release again.
- **npm, Yarn and pnpm.** Their download caches (`~/.npm`, `~/.cache/yarn`,
  `~/.yarn/berry/cache` and `~/.local/share/pnpm/store`) are saved under a key
  made from the lockfiles the job installed. Jobs that install the same
  lockfiles share one cache. After a lockfile changes, the next run restores
  the cache saved for the previous lockfile, and the install downloads only
  what's new. Yarn 1's cache keeps every version it ever fetched; its save
  holds only those the job's `yarn.lock` files name.

The runner restores what the same job, or the same matrix leg, used in its
last run. The job doesn't wait for it: the tools and the package managers'
caches restore in the background, for up to 2 minutes after the job starts,
as its first steps run. A step that makes the directory first, such as a
`setup-*` step installing the same version or an install that started before
the restore finished, keeps its own, and a restore never leaves a half-written
directory. Complete runner shows when the job's cache token came, and a line
for each restore, with when it landed, or why there was none. A restore still
running then stops, and its line is in the runner Job's log, not the job's. A job's first run, and a new
matrix leg, restore nothing. The saves upload after the job, after
`backmesh/cache`'s own. A package manager's cache restored from an older
lockfile is saved again only if the job's install wrote into it, or, for Yarn
1, if it holds every package the new lockfile names.

**Stepping aside.** The automatic cache skips a package manager that the job
caches itself: an `actions/cache` or `backmesh/cache` step whose `path` names
that manager's directory, or `actions/setup-node`'s `cache:`. A `cache:` set
by an expression counts as not caching. A step like this added to a job takes
effect from the job's next run.

**Turning it off.** Set `BACKMESH_AUTO_CACHE` to `false` in the workflow's or
the job's `env:`. The runner reads it from the workflow file after the job, so
that job saves nothing, and its next run restores nothing.

```yaml
env:
  BACKMESH_AUTO_CACHE: false
```

## Where caches are kept

`backmesh install` creates one bucket for each runner region, named
`bm-cache-<id>-<region>`, in your account through the connection it makes for
the runners. `backmesh upgrade` creates the buckets for new regions, and
`backmesh uninstall` deletes them all with their contents.

- **Branches.** A job reads caches saved on its own branch, its pull request's
  base branch and the repository's default branch, in that order, and saves
  only to its own branch. A pull request can't change what the default branch
  restores, and a pull request from a fork saves nothing.
- **Credentials.** Each job gets a token that lasts 15 minutes, renewed while it
  runs, that reaches only its repository's caches in its own region. It's a
  file in the runner, never in the job's environment.
- **Eviction.** A cache is deleted 7 days after it was saved, and each
  repository keeps at most 10 GB in each region; change that with
  `backmesh install --cache-cap <GB>`, which a re-run applies. Past the cap,
  the automatic caches go first, other branches' before the default
  branch's, then `backmesh/cache`'s, oldest first. A key that never changes is
  saved again after its weekly miss.

## Rust

`Swatinem/rust-cache` works on backmesh's runners without a change, but it
keeps its cache in GitHub's cache, not in your bucket: it calls GitHub's cache
service through the `@actions/cache` library, not the `actions/cache` action,
so `backmesh/cache` can't stand in for it. It finds the image's Rust through
`CARGO_HOME`. To keep Cargo's downloads and `target` next to the runners,
cache the same directories with `backmesh/cache` instead:

```yaml
- uses: backmesh/cache@v1
  with:
    path: |
      ~/.cargo/registry/index/
      ~/.cargo/registry/cache/
      ~/.cargo/git/db/
      target/
    key: cargo-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('**/Cargo.lock') }}
    restore-keys: cargo-${{ runner.os }}-${{ runner.arch }}-
```

Cache the directories under `~/.cargo`, as above, not `~/.cargo` or
`~/.rustup` itself: on backmesh's runners those two are links to Rust's homes,
so a cache of either would hold only the link.

## Container jobs

The cache works in a job that runs in a `container:`. The image needs GNU `tar`,
as `actions/cache` also requires, and GNU `cp` (coreutils) to save.

## Limits

- A cache holding a file over 4.5 GiB isn't saved.
- `actions/setup-node`'s and the other `setup-*` actions' built-in `cache:`
  input, and Docker's `type=gha` cache, use GitHub's cache. Use `backmesh/cache`
  with the same paths instead, or, for npm, Yarn and pnpm, remove `cache:` and
  let the automatic cache keep them.
- The automatic cache keeps only the default directories. A job that moves a
  package manager's cache, through `npm_config_cache`, `YARN_CACHE_FOLDER`,
  `XDG_CACHE_HOME` or `pnpm/action-setup`, gets no automatic cache for it.
- A `container:` job gets no automatic cache. Neither does a job whose workflow
  file isn't in its checkout, or a checkout with its own `path:`.
- A job defined in a reusable workflow from another repository gets no
  automatic cache, reads only its base's and the default branch's caches, and
  saves nothing: `backmesh/cache` prints `not saved (read-only ref)`. Define a
  job that saves in the calling repository's own workflow files.
- The automatic restores wait for the job's cache token, which reaches the
  runner when GitHub tells backmesh the job started, often after the job's
  first steps, as the
  [build benchmark](https://github.com/backmesh/backmesh/tree/main/benchmarks/builds#results)
  measured. A `setup-*` step or an install that runs before its cache
  arrives downloads everything.
- Keys starting with `bm-auto-` are reserved for the automatic cache.
- The upload's result is in the runner Job's log, not the job's log.
