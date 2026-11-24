# backmesh

Self-hosted GitHub Actions runners in your own AWS, GCP or Azure account. Each
job runs on its own spot VM, which is deleted when the job ends.

- **Up to 2× faster, 5× cheaper builds.** In our
  [build benchmarks](https://backmesh.com/benchmarks/), a `backmesh-4` spot VM ran Docker,
  Rust and TypeScript builds 1.4 to 2.1× faster than GitHub's `ubuntu-latest`,
  at 2.8 to 5.5× less per build. Your cloud bills you, so your cloud credits
  apply.
- **Shorter waits.** backmesh learns each workflow's shape and starts runners
  ahead of its predicted jobs. Your coding agent can cue backmesh as its checks
  start, so runners boot before the push. The cache keeps your dependencies
  in a bucket next to the runners.
- **Your cloud.** Your code, secrets, caches and logs stay in your accounts, and
  no cloud keys are stored.

backmesh's core features are free. See [backmesh.com](https://backmesh.com) for
costs and the [docs](https://backmesh.com/install/).

## Install

On macOS or Linux:

```sh
curl -fsSL https://backmesh.com/install.sh | sh
```

Or with Homebrew: `brew install backmesh/tap/backmesh`.

Then install backmesh for your GitHub org:

```sh
backmesh install --org acme
```

Or paste `set up https://backmesh.com/SKILL.md` into Claude Code, Codex or
another coding agent.

You need:

- An owner of the GitHub org, who signs in and installs backmesh's GitHub App
  during install.
- An AWS, GCP or Azure account, with its CLI (`aws`, `gcloud` or `az`) signed
  in on your `PATH`.
- If the org restricts OAuth apps, an owner grants backmesh access at sign-in
  ([how](https://backmesh.com/faq/#installing)).

Then use a label in a workflow:

```yaml
jobs:
  test:
    runs-on: backmesh-4
    steps:
      - uses: actions/checkout@v5
      - run: make test
```

Only Linux x86-64 jobs can use the runners, in private repositories unless
you turn on [public repositories](https://backmesh.com/public-repos/). See
[Install](https://backmesh.com/install/) for the options and
[Labels](https://backmesh.com/labels/) for the sizes.

## How it works

Install creates backmesh's control plane in your account: an always-on VM
(t3.large on AWS), and for each org a listener on a small always-on VM of its
own (t3.small on AWS), together about $74–$111 a month for one org. The listener
long-polls GitHub for queued jobs, so nothing needs an inbound port or a
webhook. For each job, it starts a VM in the cheapest region with capacity, and
the VM is deleted when the job ends. Runners can be in other clouds than the
control plane. Every job gets
automatic caches for `setup-*` tools and npm, Yarn and pnpm downloads; replace
`actions/cache` with [`backmesh/cache`](https://backmesh.com/cache/) to keep
your own caches in a bucket in the runner's region too. The
[security model](https://backmesh.com/security/) says what runs where.

backmesh is built on [anycloud](https://github.com/anycloud-sh/anycloud), which
it downloads and runs for you, so you only use the `backmesh` CLI.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). backmesh follows anycloud's
[CONTRIBUTING.md](https://github.com/anycloud-sh/anycloud/blob/main/CONTRIBUTING.md).
Run `yarn verify` before you open a pull request. Questions are welcome on
[Discord](https://discord.backmesh.com).

## Security

Please report a vulnerability privately to
[luis@backmesh.com](mailto:luis@backmesh.com), not in a public issue. See
[SECURITY.md](SECURITY.md).

## Licence

backmesh is licensed under the [Apache License 2.0](LICENSE), except the cache
action in [`cache/`](cache/), which is under the [MIT License](cache/LICENSE).
[NOTICE](NOTICE) lists the third-party code bundled in `cache/dist` and
`runner/dist`.
