# R2 media host

Creates the launch video's media host, the `backmesh-media` R2 bucket behind
`media.backmesh.com` (maintainer approval for the launch video, 2026-11-10), after
anycloud's `experiments/cloudflare-r2-media-check`. `run.ts` says what it
does. It uploads nothing: publishing a cut needs the maintainers' approval of the
cut, its music and its place on the site (`internal/launch-video/README.md`).

`spike.yml` takes no arguments, so the mode is the `MODE` constant in
`run.ts`, committed:

- `check` is read-only and sends only GET requests: whether the token
  verifies, lists R2 buckets and reads the `backmesh.com` zone, and whether
  the bucket, its domain and a `media.backmesh.com` DNS record exist.
- `create` creates the bucket and attaches the domain with a TLS 1.2 minimum
  (each skipped when present), then waits until the domain is active and
  answers over HTTPS.

Dispatch from `main`, with the reviewed commit:

```sh
gh workflow run spike.yml --repo backmesh/backmesh --ref main \
  -f experiment=r2-media-host -f source_sha=<full SHA>
```

`report.json` in the evidence artifact records each request's status and
what it saw, without token material. The bucket and domain are meant to stay;
remove them by deleting the custom domain, then the bucket.

Delete this directory when a reviewed workflow publishes launch-video cuts or
the site stops playing a video from R2.
