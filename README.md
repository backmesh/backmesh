# backmesh

CI runners for GitHub Actions in your own cloud: AWS, GCP and Azure. backmesh is built on [anycloud](https://github.com/anycloud-sh/anycloud). It installs and runs anycloud underneath, so you only use the `backmesh` CLI. Each job runs on its own VM, which goes when the job ends.

Status: released; [install](#install) it with one command.

Principles:

- Your cloud, your bill.
- Keyless cloud connections.
- CLI only.
- Nothing CI-specific inside anycloud: backmesh uses only anycloud's public API.

## Install

On macOS or Linux:

```sh
curl -fsSL https://backmesh.com/install.sh | sh
```

Run it again to move to the latest release. Or use [Homebrew](https://brew.sh): `brew install backmesh/tap/backmesh`, and `brew upgrade backmesh` later.

On first use, backmesh downloads the anycloud release it pins into `~/.backmesh/bin` and checks it against the SHA-256 digest built into the binary, so there's nothing else to install.

## Status

`backmesh status [--org <org>] [--json]` shows the control plane, then each org's runner VMs and queue with the reasons runners are short and its month-to-date cost, then the health checks. Under each label it also prints the p50 and p95 queue wait, startup and run time of the jobs completed in the last 24 hours, such as:

```text
  backmesh-4: 5 assigned, 2 running; runners 2 queued, 0 starting, 1 running
    42 jobs completed in 24 h: queue p50 0 s, p95 2 s; startup p50 48 s, p95 1.6 min; run p50 4.2 min, p95 11.0 min
```

The listener keeps that window in memory, so a restart empties it. Each completed job also writes one `job completed` JSON line to the listener's log, which `backmesh logs --org <org>` shows for as long as the listener's Pod runs.

## Licence

backmesh is licensed under the [Apache License 2.0](LICENSE), except the cache action in [`cache/`](cache/), which is under the [MIT License](cache/LICENSE). [NOTICE](NOTICE) lists the third-party code bundled in `cache/dist` and `runner/dist`; each release binary and the runner image carry their own NOTICE.
