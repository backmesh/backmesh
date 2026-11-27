# Rust preinstall benchmark

What preinstalling rustup and stable Rust in the runner image
([#160](https://github.com/backmesh/backmesh/pull/160)) costs every job's
image pull, against what it saves a Rust job. #160 was closed on an estimate,
+2.6–6.1 s of pull a job, from scaling the whole image's pull time by its
size. This measures it.

A one-off workflow, `rust-preinstall-benchmark.yml` (runs 45952939485 and
45954685910 from the `bench/rust-preinstall` branch, at commit 4b019955 in
this PR's history; not kept on main, since it publishes a package), built #160's image as v0.7.2's runner image plus #160's Rust layer
([`Dockerfile`](Dockerfile)), pushed it to the package
`ghcr.io/backmesh/backmesh-runner-bench` (deleted after), then ran 20 probe jobs at once on
`backmesh-ubuntu-2404-4vcpu` (AWS) in our CI installation. Each job is a
fresh runner VM.
[`probe.sh`](probe.sh) pulls both images in a random order, each into its
own empty dockerd, then times `cargo --version`, Rust's first use on today's
image (the pinned rustup install, `runner/pinned.sh`). Each pair is on the
same VM, so the pull difference is paired. [`report.ts`](report.ts) writes
the figures to the job summary and every job's row to the `results`
artifact.

An installation runs one runner image, so the probe can't boot runners on
both images at once. It pulls the way a runner VM's boot does, but not in
the boot:

- **Same daemon and disk.** The dockerd is `docker:<host version>-dind`, with
  the host's `daemon.json` and its store a volume on the host's disk, so the
  pull's layer concurrency, unpacking and disk are the host's.
- **Authenticated.** Both pulls log in to GHCR with the job's token, in case
  the bench package is private; a runner's pull is anonymous. Both arms pay
  the same token exchange. A package the workflow's token creates takes the
  repository's visibility, public here.
- **After boot, not in it.** anycloud may pull while the VM is still booting
  (`prepulled`), where some of a longer pull could overlap the boot. The
  probe's pull runs alone on an idle VM, so its difference is an upper
  bound on what a boot would see.

**Queued to first step** for #160's image is modelled: each job's measured
queued to first step on today's image plus its own pull difference.

## Running it

Dispatch **Rust preinstall benchmark**, or push to `bench/rust-preinstall`.
It takes about 15 minutes. Delete the `backmesh-runner-bench` package
after: that takes a token with `delete:packages`, or a workflow's own token
with `packages: write`.

## Results

### 2026-11-27, v0.7.2's runner image, AWS

Runs [45952939485](https://github.com/backmesh/backmesh/actions/runs/45952939485)
and [45954685910](https://github.com/backmesh/backmesh/actions/runs/45954685910),
20 jobs each on `backmesh-ubuntu-2404-4vcpu` in our CI installation
(v0.7.2), pooled: 40 VMs, each pulling both images. Host Docker 29.9.3 with
the containerd snapshotter. The compressed images: today's 779 MB, #160's
1,000 MB (+221 MB; #160 measured +218 MB). Medians and p90s (nearest rank),
in seconds; p-values two-sided, normal approximation.

| Figure                                | Today (v0.7.2) | #160 (+Rust)              | Difference      | p                                             |
| ------------------------------------- | -------------- | ------------------------- | --------------- | --------------------------------------------- |
| Pull (fresh store)                    | 5.0, p90 5.5   | 5.9, p90 6.2              | +0.76, p90 1.38 | 6e-12 (Mann–Whitney), 4e-7 (Wilcoxon, paired) |
| Queued to first step                  | 34.0, p90 38   | 35.1, p90 40.6 (modelled) | +0.76           | 0.21 (Mann–Whitney)                           |
| Boot: kernel start to container start | 17.3, p90 18.6 | –                         |                 |                                               |
| Rust's first use (`cargo --version`)  | 6.6, p90 6.8   | 0 (preinstalled)          | −6.6            |                                               |

- **The pull cost is a third to an eighth of the estimate.** #160 was closed
  on +2.6–6.1 s a job; the paired difference is +0.76 s (p90 1.4 s, range −1.1 to +2.6
  s). The whole 779 MB image pulls in 5 s, about 0.65 s a 100 MB, where the
  parity README's 1.2–2.8 s a 100 MB came from v0.6.0's 9–20 s pulls; the
  extra 221 MB cost about 0.34 s a 100 MB, as the pull fetches layers in
  parallel.
- **Queued to first step doesn't show it.** The 0.76 s is 2% of a 34 s
  start, and the two arms' distributions aren't distinguishable (p 0.21).
- **Order.** Pulled first or second, the difference was alike (0.65 s with
  today's first, 21 jobs; 0.92 s with #160's first, 19).
- **A Rust job saves 6.6 s** (6.5 to 7.0 s), the first call's pinned rustup
  install on today's image. Preinstalling pays off when more than about 1 in
  9 of an installation's jobs use Rust (0.76 / 6.6; 1 in 5 at the p90 cost),
  against the 31–73% #160's close assumed.

**GCP and Azure aren't measured.** Our CI installation has no GCP route: 20
jobs each on `backmesh-gcp-ubuntu-2404-4vcpu` and
`backmesh-gcp-ubuntu-2404-arm-4vcpu` sat queued for over 13 minutes with no
runner, and were cancelled. It has no Azure either. Measuring them means a
probe on the test org's e2e installs, which wait on an admin's device
sign-ins; a GCP VM pulls the same GHCR image over a similar path, so that
wasn't worth the queue for a ~1 s effect (coordinator, 2026-11-27).
