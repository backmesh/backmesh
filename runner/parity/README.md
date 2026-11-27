# Runner image parity

`gaps.sh` checks the runner image against GitHub's Ubuntu 24.04 image: every
tool and apt package its README names, at `toolset.lock`'s runner-images commit.
It checks presence, not versions, and skips the README's cached tools (Go,
Python, Node, Ruby, PyPy, CodeQL). `update.sh` writes `toolset.lock`, whose apt
packages the image installs; `known-gaps.txt` lists the tools the image may
lack, and `commands.txt` how to check each.

The rest of this file is a snapshot, not kept current.

## Gaps ranked by use, 2026-11-23

GitHub's image at release
[`ubuntu24/20261122.23`](https://github.com/actions/runner-images/blob/ubuntu24/20261122.23/images/ubuntu/Ubuntu2404-Readme.md)
against the runner image built from main at `4d847e7d`, after
[#115](https://github.com/backmesh/backmesh/pull/115). `gaps.sh` finds 104 of
185 tools and packages present, 45 installed on first use from Ubuntu's
archive, and 29 not in the archive. The image is 2.34 GB unpacked; v0.6.0's
layers are 724 MB compressed (zstd), which pull in 9–20 s at boot, so each
100 MB compressed adds roughly 1.2–2.8 s to every job.

**Repos** counts, out of 3,872 popular repositories with an Ubuntu job, those
with a job that calls the tool in a `run:` step and installs it neither with a
setup action nor with apt in that job: they rely on GitHub's image having it.
"First use" below is the image's `command_not_found_handle`, which apt-installs
a command from Ubuntu's archive, so only for a bash `run:` step: a command that
`sh`, `make`, a build script or a JavaScript action calls isn't installed.
Sizes are compressed (zstd -3) and measured. First-call times are measured,
except those marked est.; apt's took 4–6 s for `ruby`, `cmake`, `go`, `java`
and `clang`, including fetching apt's lists.

| #   | Tool                                | Repos       | GitHub's image           | Runner image today                                                                                                                                  | Proposal                                                                                                                       | Image Δ | First call |
| --- | ----------------------------------- | ----------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- | ---------- |
| 1   | Rust: `cargo`, `rustc`              | 236         | rustup, stable 1.100     | **Preinstalled** ([#160](https://github.com/backmesh/backmesh/pull/160)): rustup, stable with clippy and rustfmt, in `~/.cargo` on PATH as GitHub's | Done                                                                                                                           | +221 MB | –          |
| 2   | CMake, Ninja                        | 167         | 3.31.6, 1.13.2           | First use from apt: 3.28.3, 1.11.1; bash only, so a build script's `cmake` fails                                                                    | **Preinstall** Kitware's pinned 3.31 and Ninja                                                                                 | +54 MB  | –          |
| 3   | `rustup`                            | 149         | 1.29.3                   | **Preinstalled** with 1                                                                                                                             | Done                                                                                                                           | 0       | –          |
| 4   | AWS, Azure and Google Cloud CLIs    | 135, 13, 10 | latest                   | **First-use pinned** ([#115](https://github.com/backmesh/backmesh/pull/115))                                                                        | Done                                                                                                                           | 0       | –          |
| 5   | PowerShell: `shell: pwsh`, `pwsh`   | 85          | 7.6.10                   | Missing: the step fails                                                                                                                             | **First-use pinned** shim on PATH, which the runner finds for `shell: pwsh`; preinstall is +76 MB                              | 0       | ~2 s       |
| 6   | Maven                               | 79          | 3.10.2                   | First use from apt: 3.8.7 and a JRE, 57 MB; many builds enforce Maven 3.9+                                                                          | **Preinstall** Apache's pinned tarball, from Maven Central                                                                     | +8 MB   | –          |
| 7   | Go                                  | 75          | 1.26 in `/usr/bin`       | First use from apt: 1.22, which then fetches go.mod's toolchain; no `GOROOT_*_X64`                                                                  | **First-use pinned** go.dev 1.26 for `go` and `gofmt`; preinstall is +68 MB                                                    | 0       | ~2 s est.  |
| 8   | Ruby: `ruby`, `gem`, `bundle`       | 52          | 3.2.3, apt               | First use from apt: 3.2.3, the same package                                                                                                         | Leave                                                                                                                          | 0       | ~5 s       |
| 9   | Java: `java`, `./gradlew`, `./mvnw` | 50          | Temurin 8–25, 17 default | First use from apt: OpenJDK 17, bash only; `./gradlew` and `./mvnw` are `sh` scripts, so they fail                                                  | **First-use pinned** Temurin 17 for `java`, `javac`, `jar`, `keytool` on PATH; preinstall is +186 MB                           | 0       | ~3 s       |
| 10  | PostgreSQL: `psql`, service         | 40          | 16, service disabled     | `psql` first use installs `postgresql-client-common`, a wrapper without the client: broken                                                          | **Fix the index**: `psql` and friends to `postgresql-client`. The service stays a `services:` container                        | 0       | ~5 s       |
| 11  | Android SDK, `ANDROID_HOME`         | 40          | SDK, NDK, several GB     | Missing                                                                                                                                             | Leave: android-actions/setup-android installs it                                                                               | 0       | –          |
| 12  | Kind, Kustomize                     | 38, 3       | 0.33.0, 5.8.3            | Missing, not in the archive                                                                                                                         | **Preinstall** pinned binaries, after checking a kind cluster on the VM's Docker is reachable from the job                     | +9 MB   | –          |
| 13  | MySQL: `mysql`, service             | 28          | 8.0, service disabled    | Client first use from apt works                                                                                                                     | Leave; the service is a `services:` container                                                                                  | 0       | ~5 s       |
| 14  | Chrome, Chromium, Firefox, drivers  | 22          | Chrome 158 and drivers   | Chrome missing; `chromium-browser`, `chromedriver` and `firefox` first use installs Ubuntu's snap stubs: broken                                     | **First-use pinned** Chrome `.deb` for `google-chrome`; **fix the index** so the snap stubs fail as not found                  | 0       | ~28 s      |
| 15  | PHP, Composer                       | 21          | 8.3.6, 2.11.2            | First use from apt: 8.3.6, Composer 2.7.1                                                                                                           | Leave                                                                                                                          | 0       | ~5 s       |
| 16  | Clang, clang-format, clang-tidy     | 21          | 16–18, 18 default        | First use from apt: 18                                                                                                                              | Leave                                                                                                                          | 0       | ~5 s       |
| 17  | Podman, Buildah, Skopeo             | 21          | apt                      | First use from apt: the same versions                                                                                                               | Leave                                                                                                                          | 0       | ~5 s       |
| 18  | .NET SDK                            | 20          | 8.0–11.0                 | `dotnet` first use installs `dotnet-host-10.0`, without an SDK: broken                                                                              | **Fix the index**: `dotnet` to `dotnet-sdk-10.0`, Ubuntu's newest (GitHub's default is 11.0.100); setup-dotnet covers the rest | 0       | ~10 s est. |
| 19  | Bazel                               | 19          | Bazelisk as `bazel`      | First use from apt: `bazel-bootstrap` 4.2.3, which ignores `.bazelversion`                                                                          | **Preinstall** pinned Bazelisk as `bazel` and `bazelisk`                                                                       | +2 MB   | –          |
| 20  | Swift                               | 14          | 6.4.3                    | `swift` first use installs OpenStack's `python3-swiftclient`: the wrong tool                                                                        | **Fix the index**: no `swift`. Leave Swift missing (a toolchain is over 500 MB); swift-actions/setup-swift installs it         | 0       | –          |
| 21  | Homebrew                            | 14          | not on PATH              | Missing                                                                                                                                             | Leave                                                                                                                          | 0       | –          |
| 22  | Miniconda, `$CONDA`                 | 8           | 26.9.4                   | Missing                                                                                                                                             | Leave; 13 repos run setup-miniconda on the image's `$CONDA`, which needs a `miniforge-version` here                            | 0       | –          |

The rest, Haskell, Gradle, Minikube, Ant, Kotlin, Ansible, Julia, Vcpkg,
Pulumi, Packer, SAM, AzCopy and Bicep, have 8 repos or fewer each: leave them.

Together the preinstalls add about 73 MB, 10% of the compressed image, about
1–2 s of pull. Rust's adds 221 MB more, which
[benchmarks/rust-preinstall](../../benchmarks/rust-preinstall/) measured at
+0.76 s of pull a job. Preinstalling every first-use row instead would add about
750 MB, more than doubling the pull. Each first-use pinned install follows
[#115](https://github.com/backmesh/backmesh/pull/115): a shim on PATH, so any caller gets it, installing a pinned, checksummed
vendor release once per job.

### Older versions of what the image has

| Tool                        | Repos                                                                                       | GitHub's image         | Runner image           | Proposal                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------- | ---------------------- | ---------------------- | ------------------------------------------------------------------ |
| GitHub CLI                  | 1,308 use it; 91 use `gh attestation` (2.49+) or `gh api --slurp` (2.48+)                   | 2.105.0                | 2.45.0, apt            | **Preinstall** GitHub's pinned release in apt's place, +1.8 MB net |
| Docker CLI, Buildx, Compose | 794 run docker/setup-buildx-action, which uses the runner's Buildx unless given a `version` | 28.0.4, 0.39.1, 2.38.2 | 27.5.1, 0.20.1, 2.33.0 | **Bump** `DOCKER_CLI_IMAGE`, about 0 MB                            |
| Git, Git LFS                | all                                                                                         | 2.56.1, 3.8.1          | 2.43.0, 3.4.1          | Leave: Ubuntu's; GitHub's are from the git-core PPA                |
| Node, yq                    | –                                                                                           | 22.23.5, 4.54.3        | 22.23.4, 4.54.1        | The next hand bump                                                 |

### Not the image

- `sudo systemctl` (91 repos) and `sudo snap` (36): the runner is a container
  without systemd or snapd. Databases run as `services:` containers, as 315
  jobs already do for Postgres.
- `docker system prune` or `docker image prune` (61 and 51 repos) and
  jlumbroso/free-disk-space (52) act on the VM's Docker, which the job shares.
- github/codeql-action (719 repos) finds its bundle in GitHub's tool cache;
  here it downloads it whenever the tool cache lacks it.

## arm64 demand, 2026-11-24

Of the same 3,872 repositories (see Method and limits), 1,247 (32%) build or
test for Linux arm64 in some job, and 663 (17%) run a job on a Linux arm64
runner. backmesh runs Linux x86-64 only. 216 (6%) run a job on Windows arm64.
macOS is left out: GitHub's `macos-14` and later are arm64 by default, which
1,364 repositories use.

| Linux arm64 in a workflow                                                                    | Repos | Share |
| -------------------------------------------------------------------------------------------- | ----- | ----- |
| (a) A job on a Linux arm64 runner                                                            | 663   | 17.1% |
| – GitHub's `ubuntu-24.04-arm`, `ubuntu-22.04-arm` or `ubuntu-26.04-arm`                      | 593   | 15.3% |
| – Self-hosted or larger-runner labels (`[self-hosted, ARM64]`, `ubuntu-arm64`, ...)          | 86    | 2.2%  |
| – Another provider's arm label                                                               | 49    | 1.3%  |
| (b) Multi-arch images: build-push or bake with an arm `platforms`, or `buildx --platform`    | 419   | 10.8% |
| (b) QEMU: docker/setup-qemu-action, binfmt or run-on-arch-action                             | 524   | 13.5% |
| (c) A matrix over a Linux arm64 or armv7 value on an Ubuntu or arm job                       | 781   | 20.2% |
| Cross-compiling to Linux arm64 on x64 (Rust/C target triples, `manylinux_*_aarch64`, GOARCH) | 238   | 6.1%  |
| Any of these                                                                                 | 1,247 | 32.2% |
| Any of these, but no job on a Linux arm64 runner                                             | 584   | 15.1% |

Of the 524 using QEMU, 372 have no arm64 runner: they emulate arm64 on x64,
which is slower than building on arm64. 300 build multi-arch images
with no arm64 runner. These are the jobs an arm64 runner speeds up; a
cross-compile (most of the Go and much of the Rust counts) needs none.

By primary language, share of that language's repositories:

| Language   | Repos | Any Linux arm64 | Linux arm64 runner | arm64 output, no arm64 runner |
| ---------- | ----- | --------------- | ------------------ | ----------------------------- |
| Rust       | 271   | 69%             | 43%                | 27%                           |
| Go         | 376   | 56%             | 20%                | 36%                           |
| C++        | 203   | 42%             | 33%                | 9%                            |
| C          | 121   | 39%             | 22%                | 17%                           |
| TypeScript | 756   | 33%             | 20%                | 13%                           |
| Python     | 777   | 31%             | 15%                | 16%                           |
| Java       | 158   | 22%             | 9%                 | 13%                           |
| JavaScript | 395   | 13%             | 4%                 | 9%                            |

Rust, C and C++ repositories most often run a job on an arm64 runner. Go and
Python ones more often produce arm64 output without one: by cross-compiling,
multi-arch images, or `manylinux` aarch64 wheels under QEMU.

GitHub's own arm64 labels dominate because they're free in public repositories
(4 vCPU); in private repositories they're 2 vCPU at $0.005 a minute, 17% under
x64 ([GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).
Across all public workflows, GitHub's code search finds `ubuntu-24.04-arm` in
103k files, `ubuntu-22.04-arm` 15k, `ubuntu-26.04-arm` 8k, `windows-11-arm`
22k, `docker/setup-qemu-action` 125k and `linux/arm64` 143k, against 8.6M with
`runs-on: ubuntu-latest`.

How other providers expose arm64, from their docs on 2026-11-24, with files in
GitHub's code search:

| Provider                                                                             | Linux arm64 label                                                                      | Sizes                    | Code search                       |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------ | --------------------------------- |
| [GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) | `ubuntu-24.04-arm`, `ubuntu-22.04-arm`, `ubuntu-26.04-arm`; Windows `windows-11-arm`   | 4 vCPU public, 2 private | above                             |
| [Blacksmith](https://docs.blacksmith.sh/blacksmith-runners/overview)                 | `blacksmith-4vcpu-ubuntu-2404-arm`                                                     | 2–32 vCPU                | 1,040 (`ubuntu-2404-arm`)         |
| [Depot](https://depot.dev/docs/github-actions/runner-types)                          | `depot-ubuntu-24.04-arm`, `depot-ubuntu-24.04-arm-16`                                  | 2–64 vCPU, Graviton4     | 284 (`depot-ubuntu-24.04-arm`)    |
| [RunsOn](https://runs-on.com/runners/linux/)                                         | `runs-on=${{ github.run_id }}/runner=2cpu-linux-arm64`, `image=ubuntu24-full-arm64`    | 1–64 vCPU, Graviton      | 296 (`cpu-linux-arm64`)           |
| [WarpBuild](https://www.warpbuild.com/docs/ci/cloud-runners)                         | `warp-ubuntu-latest-arm64-4x`, `warp-ubuntu-2604-arm64-4x`                             | 2–32 vCPU                | 174 (`warp-ubuntu-latest-arm64`)  |
| [Ubicloud](https://www.ubicloud.com/docs/github-actions-integration/runner-types)    | `ubicloud-standard-4-arm`, `ubicloud-standard-4-arm-ubuntu-2404`                       | 2–30 vCPU                | 74 (`ubicloud-standard-2-arm`)    |
| [Namespace](https://namespace.so/docs/reference/github-actions/runner-configuration) | `nscloud-ubuntu-22.04-arm64-4x8`, or a `namespace-profile-*` label configured as arm64 | shape `{vCPU}x{GB}`      | 13 (`nscloud-ubuntu-22.04-arm64`) |

All of them name the architecture in the label, as GitHub does; none of
Blacksmith, WarpBuild or Ubicloud lists Windows arm64. In the sample, 21
repositories use Blacksmith's arm labels, 12 Depot's, 7 Namespace's, 5
WarpBuild's, 2 RunsOn's and 2 Ubicloud's. A Namespace profile label hides its
architecture, so it's undercounted.

Method: the same workflow files. A job counts for (a) when a label its
`runs-on` can take, including the matrix values it references and the quoted
results of an expression, matches an arm label above or names arm64, aarch64
or arm. (b) and (c) look at a job's steps and matrix; values naming macOS,
Windows, iOS or Android are left out of (c). Limits, besides those below:

- Free arm64 runners in public repositories inflate (a) against private repos,
  backmesh's users, where arm64 is paid and smaller.
- Pattern matching: a spot check of 5 repositories counted only by (c) found
  one false positive (an Android arm64 matrix) and one arm64 runner missed (a
  matrix in a `fromJSON` string). Arm
  builds in scripts, Makefiles, GoReleaser or bake files aren't seen, so
  (b) and the cross-compile row are lower bounds.

## Method and limits

The 5,755 non-fork, non-archived repositories with 5,000 or more stars
(GitHub's search, by star band), with each one's `.github/workflows/*.yml` at
its default branch through GraphQL: 33,886 workflow files, of which 55,406 jobs
run on Ubuntu (`runs-on` names it, or its matrix does) without a `container:`,
in 3,872 repositories. A tool counts when a command position in a job's `run:`
steps names it (after `sudo`, `env`, assignments, `&&`, `|`, `;` or `$(`), with
steps whose `if:` names Windows or macOS left out, and `shell: pwsh` counting
for PowerShell. It counts as installed by the job when a setup action for it,
or an apt, brew, snap, pip or npm install naming it, is in the same job.
Actions are counted by `uses:` anywhere in a repository.

- Popular repositories aren't backmesh's users: they lean to Rust, Go and
  large build matrices, and private monorepos may differ.
- It's a lower bound: a tool called from a script file, a Makefile or an
  action's code isn't seen. Browsers are the clearest case: Puppeteer, Karma
  and Selenium start Chrome without naming it.
- It counts repositories, not job runs.
- GitHub's code search, as a cross-check over all public workflows (all
  operating systems, approximate): `./gradlew` 257k files, `go build` 307k,
  `cmake` 209k, `cargo build` 186k, `dotnet build` 183k, `rustup` 121k,
  `ANDROID_HOME` 39k, `google-chrome` 22k, `swift build` 20k, `kind create
cluster` 2k, out of 8.5M with `runs-on: ubuntu-latest`.
- First-call times are one run each, on an AWS VM.
