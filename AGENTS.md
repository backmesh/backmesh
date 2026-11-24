# Agent instructions

Keep this file small and durable.

- The maintainers keep backmesh's design records privately: what backmesh
  does and how it is built, size estimates, the cache designs, and how we
  publish releases and run our own CI installation. A change that needs them
  is checked against them in review.
- Follow anycloud's
  [CONTRIBUTING.md](https://github.com/anycloud-sh/anycloud/blob/main/CONTRIBUTING.md)
  for code quality, pull requests, size estimates and justification tables, and
  code review.
- Run `yarn verify` (lint, format check, typecheck, tests) before pushing.
- [CONTRIBUTING.md](CONTRIBUTING.md) has how a change is live-tested with a
  release candidate before it ships.
- A change that claims a speedup gets its own A/B before it merges: run
  `benchmarks/` (builds, cue) on a build of the change and on main, and put the
  numbers in the PR body. No measured gain, no speed claim: reconsider the
  change.
- backmesh uses only anycloud's public API and CLI. Nothing CI-specific goes into
  anycloud; a gap there is an anycloud issue, not a backmesh workaround inside it.
- Never run local cloud CLIs (`aws`, `gcloud`, `az`) or a local anycloud API
  with cloud credentials.

## Stack

Owner, 2026-11-04. Match anycloud's choices so code reads the same in both repos,
and add no dependency outside this list without a reason in the PR body.

- CLI: `commander`. API client: `@orpc/openapi-client`, generated from anycloud's
  `openapi.generated.json`. Validation: `zod` 4. GitHub REST: `@octokit/rest`.
- GitHub App JWT: RS256, with WebCrypto in the Worker (`node:crypto`
  in the CLI until the broker replaces it). The scale-set API (sessions, long
  poll, acquire, JIT): a hand-written `fetch` client, after ARC's Go client.
- Logs: JSON lines to stdout. Otherwise the Node standard library: no web
  framework, ORM or DI container.
