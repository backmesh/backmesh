# Worker sign-in logs

Why one `backmesh install` sign-in poll got "api.backmesh.com didn't
answer" on 2026-11-19 at 02:09:43 UTC: the CLI gives up after 10 seconds or
on a network error, so either the Worker answered slowly (its GitHub call has
no timeout) or the request never arrived. `run.ts` reads the Worker's
Workers Logs events and per-minute invocation metrics for 02:05–02:15 UTC.
It's read-only and keeps no headers, bodies, IPs or tokens.

```sh
gh workflow run spike.yml --repo backmesh/backmesh --ref main \
  -f experiment=worker-sign-in-logs -f source_sha=<full SHA>
```

Delete this directory once the finding is in the sign-in fix's PR.
