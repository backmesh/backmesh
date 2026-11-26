# sccache spike

Whether sccache, as rustc's wrapper, can use backmesh's per-job cache token
through a loopback WebDAV server, as an automatic cache kind (CI speed #97, row
C26, owner-approved 2026-11-26). This is a spike: the proxy runs as a job step
here, not in the runner image's `auto-cache.mjs`.

[`proxy.ts`](proxy.ts), bundled to [`dist/proxy.mjs`](dist/proxy.mjs) with

```sh
bun build experiments/sccache/proxy.ts --target node --format esm --minify-syntax --outfile experiments/sccache/dist/proxy.mjs
```

CI doesn't check the committed bundle against `proxy.ts`, so rebuild it after a
change. The proxy serves `SCCACHE_WEBDAV_ENDPOINT=http://127.0.0.1:4230` over `openStore`
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

[`benchmarks/builds`](../../benchmarks/builds/README.md) has the A/B's
`<label>/sccache` and `<label>/rust` arms.

## Results

### 2026-11-26, AWS, backmesh 0.7.2

`run.ts` with `<label>/sccache` and `<label>/rust` on our own CI installation,
`backmesh-ubuntu-2404-4vcpu` (every job on an `m8a.xlarge`), 5 rounds, both arms
at once
([results](../../benchmarks/builds/results/experiments/2026-11-26-0.7.2-sccache.json)).
Each round is a cold run on a new branch, then a warm run on the same branch,
which reads the cold run's objects under its own prefix. The figures are the
Build step (`cargo build --release --locked`), the median over 5 rounds, with
p90 (nearest rank) and range.

| nushell 0.116.1      | sccache off              | sccache on               | Change      |
| -------------------- | ------------------------ | ------------------------ | ----------- |
| Warm build           | 221 s (p90 232, 218–232) | 145 s (p90 149, 140–149) | −76 s, −34% |
| Cold build           | 219 s (p90 220, 217–220) | 283 s (p90 288, 274–288) | +64 s, +29% |
| Warm, queued to done | 270 s (p90 279)          | 207 s (p90 213)          | −63 s, −23% |
| Cold, queued to done | 267 s (p90 269)          | 341 s (p90 350)          | +74 s, +28% |

In each comparison every round of one arm beats every round of the other:
the exact two-sided Mann–Whitney p is 0.008 (2 of 252).

- **Hits.** The warm runs hit 4,651 of 4,765 cacheable compiles (97.6%; 952,
  886, 932, 929 and 952 of 953). Each round's misses match the writes its cold
  run dropped before the job's token was ready (0, 67, 17, 24 and 0).
- **Writes.** A cold run wrote a median of 937 objects (887–954) and 535 MB
  (490–544 MB) under the branch's prefix: the bucket's size per branch, as
  nothing else writes there. A warm run wrote 2 to 68 objects, its misses.
- **ripgrep 14.1.1** gained nothing: its build starts 2 s into the job and
  takes 20 s, and the job's token wasn't ready during it in any of the 10
  runs, so every write was dropped and every read missed (the 0 or 9 objects
  of a cold run). In round 1, the nushell jobs first used the token 36 and 17 s in.
  With a token, its 20 s build has little to save.

### What else the spike found

- **sccache fails the build if its storage check can't reach the
  endpoint** when its server starts (`Server startup failed: cache storage
failed to read`), `SCCACHE_IGNORE_SERVER_IO_ERROR=1` or not. A proxy that
  goes away after the server started only turns hits into misses: the build
  passes with cache errors (checked locally). So the proxy must be listening
  before the job's first rustc.
- **Port 4226 is sccache's own server's**, so the proxy is on 4230.
- **The sweep** (`src/listener/sweep.ts`) treats `cache/<repo>/<ref>/sccache/…`
  as objects outside an entry: each goes 1 day after its write, reads don't
  extend that, and none counts toward the repository's cap. A default branch's
  objects are gone after a quiet day, and the cap doesn't bound a busy
  repository's branches. Each object is also one `deleteBucketObject` call
  through anycloud's API: about 950 a day for each branch nushell is built on.
