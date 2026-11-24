# backmesh

GitHub Actions runners on spot VMs in your own AWS, GCP or Azure account.

[![Release](https://img.shields.io/github/v/release/backmesh/backmesh)](https://github.com/backmesh/backmesh/releases/latest)
[![License](https://img.shields.io/github/license/backmesh/backmesh)](LICENSE)
[![CI](https://github.com/backmesh/backmesh/actions/workflows/ci.yml/badge.svg)](https://github.com/backmesh/backmesh/actions/workflows/ci.yml)
[![Discord](https://img.shields.io/badge/Discord-chat-5865F2?logo=discord&logoColor=white)](https://discord.backmesh.com)

![backmesh launch video](https://backmesh.com/launch.gif)

<!-- bench:start -->

| Build        | GitHub-hosted `ubuntu-latest`, 4 vCPUs | backmesh, 4 vCPUs | backmesh vs GitHub         |
| ------------ | -------------------------------------- | ----------------- | -------------------------- |
| Docker build | 99 s, $0.024                           | 57 s, $0.0025     | 1.7× faster, 9.6× cheaper  |
| Go           | 73 s, $0.024                           | 38 s, $0.0020     | 1.9× faster, 11.8× cheaper |
| TypeScript   | 43 s, $0.012                           | 28 s, $0.0017     | 1.5× faster, 7.0× cheaper  |

Medians of 10 runs, 4 vCPUs each. [How we measured →](https://backmesh.com/benchmarks/)

<!-- bench:end -->

## Quickstart

You need:

- An owner of the GitHub org, who signs in during install.
- An AWS, GCP or Azure CLI (`aws`, `gcloud` or `az`) signed in.

```sh
curl -fsSL https://backmesh.com/install.sh | sh   # or: brew install backmesh/tap/backmesh
backmesh install --org acme
```

Or paste `set up https://backmesh.com/SKILL.md` into your coding agent. Then
use a label in a workflow:

```yaml
jobs:
  test:
    runs-on: backmesh-ubuntu-2404-4vcpu
    steps:
      - uses: actions/checkout@v5
      - run: make test
```

Linux x86-64 jobs in private repositories, or
[public ones](https://backmesh.com/public-repos/) if you turn them on. See
[Install](https://backmesh.com/install/), [Labels](https://backmesh.com/labels/)
and the [FAQ](https://backmesh.com/faq/#installing), such as for orgs that
restrict OAuth apps.

## How it works

Install creates a control plane in your account, about $74–$111 a month for one
org. Its listener long-polls GitHub for queued jobs, with no inbound port or
webhook, and starts each job on its own spot VM in the cheapest region with
capacity, deleted when the job ends. Your code, secrets, caches and logs stay in
your cloud. backmesh's core features are free, and it's built on
[anycloud](https://github.com/anycloud-sh/anycloud). The
[security model](https://backmesh.com/security/) says what runs where.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), and run `yarn verify` before you open a
pull request.
[Good first issues](https://github.com/backmesh/backmesh/labels/good%20first%20issue)
need no cloud account. Ask questions in
[Discussions](https://github.com/backmesh/backmesh/discussions) or on
[Discord](https://discord.backmesh.com).

## Security

Report a vulnerability privately to
[luis@backmesh.com](mailto:luis@backmesh.com), not in a public issue. See
[SECURITY.md](SECURITY.md).

## License

Apache License 2.0 ([LICENSE](LICENSE)), except [`cache/`](cache/), which is
MIT ([cache/LICENSE](cache/LICENSE)). [NOTICE](NOTICE) lists bundled
third-party code.
