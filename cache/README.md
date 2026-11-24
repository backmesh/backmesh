# backmesh cache

A drop-in replacement for [`actions/cache`](https://github.com/actions/cache)
on [backmesh](https://github.com/backmesh/backmesh)'s self-hosted runners. It
keeps caches in a bucket in your own cloud account, in the runner's region, so
a restore never leaves the region. On any other runner, such as GitHub's own,
it uses GitHub's cache, so a workflow that also runs there needs no change.

```yaml
- uses: backmesh/cache@v1
  with:
    path: |
      ~/.npm
      node_modules
    key: npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
    restore-keys: npm-${{ runner.os }}-
```

It takes `actions/cache`'s inputs and sets its `cache-hit` output.
`backmesh/cache/restore@v1` and `backmesh/cache/save@v1` replace
`actions/cache/restore` and `actions/cache/save`.

A restore downloads a cache's pieces in parallel, and a save returns at once:
the runner uploads the cache after the job ends. See
[backmesh.com/cache](https://backmesh.com/cache/) for how it works and its
limits.

This repository is published from
[`cache/`](https://github.com/backmesh/backmesh/tree/main/cache) in
backmesh/backmesh with each release; open issues and pull requests there. MIT
licensed.
