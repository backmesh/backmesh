# sccache spike

Whether sccache, as rustc's wrapper, can use backmesh's per-job cache token
through a loopback WebDAV server, as an automatic cache kind (CI speed #97, row
C26, owner-approved 2026-11-26). This is a spike: the proxy runs as a job step
here, not in the runner image's `auto-cache.mjs`.

[`proxy.ts`](proxy.ts), bundled to [`dist/proxy.mjs`](dist/proxy.mjs) with

```sh
bun build experiments/sccache/proxy.ts --target node --format esm --minify-syntax --outfile experiments/sccache/dist/proxy.mjs
```

serves `SCCACHE_WEBDAV_ENDPOINT=http://127.0.0.1:4230` over `openStore`
(`src/cache/store.ts`). Each request reads the token file again, so a renewed
token is used as soon as it lands. A GET reads `sccache/<path>` under the own,
then the base, then the default ref's prefix, and a PUT writes under own only.
Before the token is ready, or on a ref with no own prefix, a read misses and a
write is dropped, so rustc runs without waiting. OpenDAL makes each parent
directory before a write (MKCOL) and reads the file's metadata back afterwards
(PROPFIND), so the proxy says every directory exists and answers for its own
writes. On SIGTERM it writes its counts to a file: requests, hits, bytes, and
each token it used with how many requests succeeded on it.

[`clouds.ts`](clouds.ts) runs [`target/sccache.yml`](target/sccache.yml)
on each of e2e.yml's test-org legs when it's dispatched with `sccache=true`:

```sh
gh workflow run e2e.yml -f org=backmesh-dryrun -f version=v0.7.2 -f sccache=true
```

The job does a cold nushell build through the proxy. Once the listener
has renewed the job's token (every 10 minutes), it writes and reads a probe
with the new token, then repeats the build from the bucket. The check passes
when the job did, the cold build wrote without errors, the warm build hit,
and the proxy used at least two tokens.

The spike's pull request adds the A/B arms to `benchmarks/builds` and has the
results and the go/no-go.
