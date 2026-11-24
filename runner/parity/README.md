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

| #   | Tool                                | Repos       | GitHub's image           | Runner image today                                                                                      | Proposal                                                                                                               | Image Δ | First call |
| --- | ----------------------------------- | ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------- | ---------- |
| 1   | Rust: `cargo`, `rustc`              | 236         | rustup, stable 1.100     | First use from apt: rustc 1.75, too old for most crates (edition 2024 needs 1.85)                       | **First-use pinned** rustup, stable with clippy and rustfmt, in `~/.cargo` on PATH as GitHub's; preinstall is +218 MB  | 0       | ~8 s       |
| 2   | CMake, Ninja                        | 167         | 3.31.6, 1.13.2           | First use from apt: 3.28.3, 1.11.1; bash only, so a build script's `cmake` fails                        | **Preinstall** Kitware's pinned 3.31 and Ninja                                                                         | +54 MB  | –          |
| 3   | `rustup`                            | 149         | 1.29.3                   | First use from apt: 1.26 with no toolchain                                                              | As 1                                                                                                                   | 0       | ~8 s       |
| 4   | AWS, Azure and Google Cloud CLIs    | 135, 13, 10 | latest                   | **First-use pinned** ([#115](https://github.com/backmesh/backmesh/pull/115))                            | Done                                                                                                                   | 0       | –          |
| 5   | PowerShell: `shell: pwsh`, `pwsh`   | 85          | 7.6.10                   | Missing: the step fails                                                                                 | **First-use pinned** shim on PATH, which the runner finds for `shell: pwsh`; preinstall is +76 MB                      | 0       | ~2 s       |
| 6   | Maven                               | 79          | 3.10.2                   | First use from apt: 3.8.7 and a JRE, 57 MB; many builds enforce Maven 3.9+                              | **Preinstall** Apache's pinned tarball, from Maven Central                                                             | +8 MB   | –          |
| 7   | Go                                  | 75          | 1.26 in `/usr/bin`       | First use from apt: 1.22, which then fetches go.mod's toolchain; no `GOROOT_*_X64`                      | **First-use pinned** go.dev 1.26 for `go` and `gofmt`; preinstall is +68 MB                                            | 0       | ~2 s est.  |
| 8   | Ruby: `ruby`, `gem`, `bundle`       | 52          | 3.2.3, apt               | First use from apt: 3.2.3, the same package                                                             | Leave                                                                                                                  | 0       | ~5 s       |
| 9   | Java: `java`, `./gradlew`, `./mvnw` | 50          | Temurin 8–25, 17 default | First use from apt: OpenJDK 17, bash only; `./gradlew` and `./mvnw` are `sh` scripts, so they fail      | **First-use pinned** Temurin 17 for `java`, `javac`, `jar`, `keytool` on PATH; preinstall is +186 MB                   | 0       | ~3 s       |
| 10  | PostgreSQL: `psql`, service         | 40          | 16, service disabled     | `psql` first use installs `postgresql-client-common`, a wrapper without the client: broken              | **Fix the index**: `psql` and friends to `postgresql-client`. The service stays a `services:` container                | 0       | ~5 s       |
| 11  | Android SDK, `ANDROID_HOME`         | 40          | SDK, NDK, several GB     | Missing                                                                                                 | Leave: android-actions/setup-android installs it                                                                       | 0       | –          |
| 12  | Kind, Kustomize                     | 38, 3       | 0.33.0, 5.8.3            | Missing, not in the archive                                                                             | **Preinstall** pinned binaries, after checking a kind cluster on the VM's Docker is reachable from the job             | +9 MB   | –          |
| 13  | MySQL: `mysql`, service             | 28          | 8.0, service disabled    | Client first use from apt works                                                                         | Leave; the service is a `services:` container                                                                          | 0       | ~5 s       |
| 14  | Chrome, Chromium, Firefox, drivers  | 22          | Chrome 158 and drivers   | Chrome missing; `chromium`, `chromedriver` and `firefox` first use installs Ubuntu's snap stubs: broken | **First-use pinned** Chrome `.deb` for `google-chrome`; **fix the index** so the snap stubs fail as not found          | 0       | ~28 s      |
| 15  | PHP, Composer                       | 21          | 8.3.6, 2.11.2            | First use from apt: 8.3.6, Composer 2.7.1                                                               | Leave                                                                                                                  | 0       | ~5 s       |
| 16  | Clang, clang-format, clang-tidy     | 21          | 16–18, 18 default        | First use from apt: 18                                                                                  | Leave                                                                                                                  | 0       | ~5 s       |
| 17  | Podman, Buildah, Skopeo             | 21          | apt                      | First use from apt: the same versions                                                                   | Leave                                                                                                                  | 0       | ~5 s       |
| 18  | .NET SDK                            | 20          | 8.0–11.0                 | `dotnet` first use installs `dotnet-host-10.0`, without an SDK: broken                                  | **Fix the index**: `dotnet` to `dotnet-sdk-8.0`; setup-dotnet covers the rest                                          | 0       | ~10 s est. |
| 19  | Bazel                               | 19          | Bazelisk as `bazel`      | First use from apt: `bazel-bootstrap` 4.2.3, which ignores `.bazelversion`                              | **Preinstall** pinned Bazelisk as `bazel` and `bazelisk`                                                               | +2 MB   | –          |
| 20  | Swift                               | 14          | 6.4.3                    | `swift` first use installs OpenStack's `python3-swiftclient`: the wrong tool                            | **Fix the index**: no `swift`. Leave Swift missing (a toolchain is over 500 MB); swift-actions/setup-swift installs it | 0       | –          |
| 21  | Homebrew                            | 14          | not on PATH              | Missing                                                                                                 | Leave                                                                                                                  | 0       | –          |
| 22  | Miniconda, `$CONDA`                 | 8           | 26.9.4                   | Missing                                                                                                 | Leave; 13 repos run setup-miniconda on the image's `$CONDA`, which needs a `miniforge-version` here                    | 0       | –          |

The rest, Haskell, Gradle, Minikube, Ant, Kotlin, Ansible, Julia, Vcpkg,
Pulumi, Packer, SAM, AzCopy and Bicep, have 8 repos or fewer each: leave them.

Together the preinstalls add about 73 MB, 10% of the compressed image, about
1–2 s of pull. Preinstalling every first-use row instead would add about
750 MB, more than doubling the pull. Each first-use pinned install follows
[#115](https://github.com/backmesh/backmesh/pull/115): a shim on PATH, so any caller gets it, installing a pinned, checksummed
vendor release once per job.

### Older versions of what the image has

| Tool                        | Repos                                                                                       | GitHub's image         | Runner image           | Proposal                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------- | ---------------------- | ---------------------- | ------------------------------------------------------------- |
| GitHub CLI                  | 1,308 use it; 91 use `gh attestation` (2.49+) or `gh api --slurp` (2.48+)                   | 2.105.0                | 2.45.0, apt            | **Preinstall** GitHub's pinned release in apt's place, +17 MB |
| Docker CLI, Buildx, Compose | 794 run docker/setup-buildx-action, which uses the runner's Buildx unless given a `version` | 28.0.4, 0.39.1, 2.38.2 | 27.5.1, 0.20.1, 2.33.0 | **Bump** `DOCKER_CLI_IMAGE`, about 0 MB                       |
| Git, Git LFS                | all                                                                                         | 2.56.1, 3.8.1          | 2.43.0, 3.4.1          | Leave: Ubuntu's; GitHub's are from the git-core PPA           |
| Node, yq                    | –                                                                                           | 22.23.5, 4.54.3        | 22.23.4, 4.54.1        | The next hand bump                                            |

### Not the image

- `sudo systemctl` (91 repos) and `sudo snap` (36): the runner is a container
  without systemd or snapd. Databases run as `services:` containers, as 315
  jobs already do for Postgres.
- `docker system prune` or `docker image prune` (61 and 51 repos) and
  jlumbroso/free-disk-space (52) act on the VM's Docker, which the job shares.
- github/codeql-action (719 repos) finds its bundle in GitHub's tool cache;
  here it downloads it whenever the tool cache lacks it.

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
