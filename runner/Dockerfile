# backmesh's runner image: Ubuntu, the actions runner,
# Docker's CLI from the pinned Docker CLI image with pinned buildx and compose
# (jobs use the VM's Docker through its socket), the apt packages
# GitHub's Ubuntu 24.04 image installs (parity/toolset.lock), Node with
# corepack, and a few CLIs. Languages come from actions/setup-* into the tool
# cache; any other command in Ubuntu's archive installs on first use
# (first-use.bash). From anycloud's docker/github-actions-runner/Dockerfile and
# pool/Dockerfile.
ARG DOCKER_CLI_IMAGE=mirror.gcr.io/library/docker:28.0.4-cli@sha256:2bccc79fc5fed23d876bf244fa5fbe78c54bf6b6145a9483604306fd797237d5
ARG UBUNTU_IMAGE=mirror.gcr.io/library/ubuntu:24.04@sha256:d78ab76437b1afc5f01e223d6bf0172763f404bb166441328845adbef44518cb

FROM ${DOCKER_CLI_IMAGE} AS cli

FROM ${UBUNTU_IMAGE}

# GitHub stops sending jobs to runners too far behind its latest release:
# bump both together, from the release's checksums.
ARG RUNNER_VERSION=2.338.2
ARG RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
# The versions GitHub's Ubuntu 24.04 image has, from each project's checksums.
ARG NODE_VERSION=22.23.4
ARG NODE_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
ARG KUBECTL_VERSION=1.37.2
ARG KUBECTL_SHA256=c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4
ARG HELM_VERSION=3.22.1
ARG HELM_SHA256=896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea
ARG YQ_VERSION=4.54.1
ARG YQ_SHA256=8e34fc298390875de416e6a4afcb8cabeceb25d9aa8506c1a2f9353cf702ea5f
# gh, Buildx and Compose: the versions in the README of GitHub's image's
# release ubuntu24/20261122.23, not toolset.lock's revision; bump them by hand.
ARG GH_VERSION=2.105.0
ARG GH_SHA256=79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f
ARG BUILDX_VERSION=0.39.1
ARG BUILDX_SHA256=903090816da68f8bc1a2ff5346dd163a5adacfce4548d003c75df42cd47a9bf4
ARG COMPOSE_VERSION=2.38.2
ARG COMPOSE_SHA256=486b3ffc0f806ca2efbc430cef89955386011662f0c76bad17c103d059cfa9cf
# Build tools GitHub's image has, at its release ubuntu24/20261122.23's
# versions: Kitware's CMake, Ninja, Apache's Maven (SHA-512, from Maven
# Central), Kind, Kustomize and Bazelisk.
ARG CMAKE_VERSION=3.31.6
ARG CMAKE_SHA256=5a1133ff103c71eb5120e2cc3de922733e7d8a26a98ae716397e8676adb367bf
ARG NINJA_VERSION=1.13.2
ARG NINJA_SHA256=5749cbc4e668273514150a80e387a957f933c6ed3f5f11e03fb30955e2bbead6
ARG MAVEN_VERSION=3.10.2
ARG MAVEN_SHA512=57d2db6b37e7582119137ade544557bba741b29e62109ef81539a2bdfd6d0e641fdd5d8edb014af1816d0510deac6fac8f347433b3a1aa36316ba85aa77b8119
ARG KIND_VERSION=0.33.0
ARG KIND_SHA256=aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d
ARG KUSTOMIZE_VERSION=5.8.3
ARG KUSTOMIZE_SHA256=cb9e31198d3f63b44848bd0afc4c8efc56e6cfef9c93a4a39a211940e6decd61
ARG BAZELISK_VERSION=1.28.1
ARG BAZELISK_SHA256=22e7d3a188699982f661cf4687137ee52d1f24fec1ec893d91a6c4d791a75de8
# The cloud CLIs, installed on first use (pinned.sh): Microsoft's noble
# package, Google's x86-64 archive, and AWS's x86-64 zip, which AWS's key
# signs. Their versions are runner-images main's README's on 2026-11-23, not
# toolset.lock's revision; bump them by hand.
ARG AZ_VERSION=2.93.0
ARG AZ_SHA256=a6ed3e2d3eca33c6e3b40d0534d4607048a02d656192accefcb7881ce8679124
ARG GCLOUD_VERSION=593.0.0
ARG GCLOUD_SHA256=42c32b7553c712f71fcf6f124546c0519437f53755f47f9bd0c957998cd6b826
ARG AWS_VERSION=2.40.4
# Rust, PowerShell, Go, Java and Chrome, installed on first use the same way
# (pinned.sh), at the versions of GitHub's image's release ubuntu24/20261122.23:
# rustup's x86-64 rustup-init and Rust's stable toolchain, PowerShell's
# release, go.dev's archive, Temurin's JDK (GitHub's README shows
# 17.0.21.1+2 as 17.0.21+2), and Chrome for Testing's Chrome and ChromeDriver.
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG RUST_VERSION=1.100.0
ARG PWSH_VERSION=7.6.10
ARG PWSH_SHA256=e261cabc91c78a9afe8d1e5f24731ab0d38204735ab2ec94b0af55102652e10d
ARG GO_VERSION=1.26.11
ARG GO_SHA256=9849f4e04ee35303714e34fbc3ac8ab44ea3e448a95aa182f91e3b9b79c710ec
ARG JAVA_VERSION=17.0.21.1+2
ARG JAVA_SHA256=0b0ac5eab6db6abaec68c9913bcddb31321e5da411c45073d520d9c125e6f7b4
ARG CHROME_VERSION=158.0.8127.36
ARG CHROME_SHA256=dba9cc838e1ce269c33ea68170881127bd15d078fc3ca5891c90802819a4d7c7
ARG CHROMEDRIVER_SHA256=d20e70d69d68c5c983e2526452ed0779fd65dc4ade5d6741f1bb3d0d82754d3a
# corepack's defaults where a repository names no packageManager.
ARG YARN_VERSION=1.22.22
ARG PNPM_VERSION=12.18.0

# PIPX_*: where GitHub's image puts pipx's apps, on PATH, which ends in
# /usr/games as GitHub's does, for packages such as cowsay, and has the
# runner's ~/.cargo/bin, as GitHub's has, so `cargo install` puts its
# binaries on PATH. It comes after /usr/local/bin's first-use shims, unlike
# GitHub's, so `cargo` is the shim even when a cache restored rustup's
# proxies without a toolchain. JAVA_HOME and JAVA_HOME_17_X64, and
# CHROMEWEBDRIVER, as GitHub's image sets them: each has the image's shims
# until the first use installs Temurin 17 or ChromeDriver there. COREPACK_*:
# yarn and pnpm without a prompt, kept in a directory the runner user writes. The tool
# cache is under the VM's /workspace, at the same path in the container,
# because the runner mounts it into a job's `container:`. LANG and ImageOS as
# GitHub's image sets them; actions such as setup-python pick their builds by
# ImageOS.
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    ImageOS=ubuntu24 \
    RUNNER_TOOL_CACHE=/workspace/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/workspace/hostedtoolcache \
    PIPX_HOME=/opt/pipx \
    PIPX_BIN_DIR=/opt/pipx_bin \
    JAVA_HOME=/usr/lib/jvm/temurin-17-jdk-amd64 \
    JAVA_HOME_17_X64=/usr/lib/jvm/temurin-17-jdk-amd64 \
    CHROMEWEBDRIVER=/usr/local/share/chromedriver-linux64 \
    COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PATH=/opt/pipx_bin:/usr/local/sbin:/usr/local/bin:/home/runner/.cargo/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# The lock's packages; the ones backmesh needs, listed even where the lock has
# them, or adds (gettext-base for envsubst; git-lfs, which git runs without
# bash, so it can't install on first use); and the first-use index: every
# command in the archive's command metadata with its package, main's first,
# after first-use-packages.txt's corrections. apt fetches the metadata, so
# it's checked against the archive's signature.
COPY parity/toolset.lock first-use-packages.txt /tmp/
RUN echo 'Acquire::IndexTargets::deb::CNF { MetaKey "$(COMPONENT)/cnf/Commands-$(NATIVE_ARCHITECTURE)"; ShortDescription "Commands-$(NATIVE_ARCHITECTURE)"; Description "$(RELEASE)/$(COMPONENT) $(NATIVE_ARCHITECTURE) c-n-f Metadata"; flatMetaKeyFormat "cnf/Commands-$(NATIVE_ARCHITECTURE)"; flatDescription "$(RELEASE) c-n-f Metadata"; };' \
        >/etc/apt/apt.conf.d/50backmesh-commands \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        gettext-base \
        git \
        git-lfs \
        jq \
        pipx \
        procps \
        python3 \
        rsync \
        sudo \
        unzip \
        zip \
        zstd \
        $(grep -v -e '^#' -e = /tmp/toolset.lock) \
    && install -d /usr/share/backmesh \
    && for component in main restricted universe multiverse; do \
        for list in /var/lib/apt/lists/*_"$component"_cnf_Commands-amd64*; do \
          /usr/lib/apt/apt-helper cat-file "$list"; \
        done; \
      done | awk 'FNR == NR { if (NF && !/^#/) to[$1] = $2; next } \
          $1 == "name:" { pkg = ($2 in to) ? to[$2] : $2 } \
          $1 == "commands:" && pkg != "-" { n = split($2, c, ","); for (i = 1; i <= n; i++) if (!seen[c[i]]++) print c[i], pkg }' \
          /tmp/first-use-packages.txt - >/usr/share/backmesh/commands \
    && [[ $(wc -l </usr/share/backmesh/commands) -gt 10000 ]] \
    && useradd --create-home --uid 1001 --shell /bin/bash runner \
    && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner \
    && install -d -o runner -g runner /opt/actions-runner-dist \
        /opt/pipx /opt/pipx_bin /opt/corepack \
    && rm -rf /etc/apt/apt.conf.d/50backmesh-commands /var/lib/apt/lists/* /tmp/toolset.lock /tmp/first-use-packages.txt

# Node and npm with corepack's yarn and pnpm. npm's global directories are the
# runner user's, so `npm install --global` needs no sudo, as on GitHub's image.
# kubectl, helm, yq and gh, and Docker's buildx and compose plugins.
RUN curl --fail --location --retry 5 --output /tmp/node.tar.xz \
        "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum --check --strict \
    && tar --extract --xz --file /tmp/node.tar.xz --directory /usr/local --strip-components 1 \
        --exclude CHANGELOG.md --exclude LICENSE --exclude README.md \
    && corepack enable yarn pnpm \
    && corepack install --global "yarn@${YARN_VERSION}" "pnpm@${PNPM_VERSION}" \
    && chown -R runner:runner /usr/local/lib/node_modules /opt/corepack \
    && chown runner:runner /usr/local/bin \
    && curl --fail --location --retry 5 --output /usr/local/bin/kubectl \
        "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && echo "${KUBECTL_SHA256}  /usr/local/bin/kubectl" | sha256sum --check --strict \
    && curl --fail --location --retry 5 --output /tmp/helm.tar.gz \
        "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" \
    && echo "${HELM_SHA256}  /tmp/helm.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --file /tmp/helm.tar.gz --directory /usr/local/bin --strip-components 1 linux-amd64/helm \
    && curl --fail --location --retry 5 --output /usr/local/bin/yq \
        "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_amd64" \
    && echo "${YQ_SHA256}  /usr/local/bin/yq" | sha256sum --check --strict \
    && curl --fail --location --retry 5 --output /tmp/gh.tar.gz \
        "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --file /tmp/gh.tar.gz --directory /usr/local/bin --strip-components 2 "gh_${GH_VERSION}_linux_amd64/bin/gh" \
    && install -d /usr/local/libexec/docker/cli-plugins \
    && curl --fail --location --retry 5 --output /usr/local/libexec/docker/cli-plugins/docker-buildx \
        "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-amd64" \
    && echo "${BUILDX_SHA256}  /usr/local/libexec/docker/cli-plugins/docker-buildx" | sha256sum --check --strict \
    && curl --fail --location --retry 5 --output /usr/local/libexec/docker/cli-plugins/docker-compose \
        "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
    && echo "${COMPOSE_SHA256}  /usr/local/libexec/docker/cli-plugins/docker-compose" | sha256sum --check --strict \
    && chmod 0755 /usr/local/bin/kubectl /usr/local/bin/yq /usr/local/libexec/docker/cli-plugins/* \
    && rm /tmp/node.tar.xz /tmp/helm.tar.gz /tmp/gh.tar.gz \
    && node --version && yarn --version && pnpm --version && kubectl version --client && helm version && yq --version \
    && gh --version

# CMake without cmake-gui, which needs a display, the interactive ccmake, or
# its docs; Ninja; Maven where GitHub's image has it, which finds java on
# PATH; Kind and Kustomize; and Bazelisk as both bazelisk and bazel, as
# GitHub's image has it, which runs the Bazel a repository's .bazelversion
# names.
RUN curl --fail --location --retry 5 --output /tmp/cmake.tar.gz \
        "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz" \
    && echo "${CMAKE_SHA256}  /tmp/cmake.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --file /tmp/cmake.tar.gz --directory /usr/local --strip-components 1 \
        --exclude '*/bin/cmake-gui' --exclude '*/bin/ccmake' --exclude '*/doc' --exclude '*/man' \
    && curl --fail --location --retry 5 --output /tmp/ninja.zip \
        "https://github.com/ninja-build/ninja/releases/download/v${NINJA_VERSION}/ninja-linux.zip" \
    && echo "${NINJA_SHA256}  /tmp/ninja.zip" | sha256sum --check --strict \
    && unzip -q /tmp/ninja.zip -d /usr/local/bin \
    && curl --fail --location --retry 5 --output /tmp/maven.tar.gz \
        "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${MAVEN_VERSION}/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
    && echo "${MAVEN_SHA512}  /tmp/maven.tar.gz" | sha512sum --check --strict \
    && tar --extract --gzip --file /tmp/maven.tar.gz --directory /usr/share \
    && ln -s "/usr/share/apache-maven-${MAVEN_VERSION}/bin/mvn" /usr/local/bin/mvn \
    && curl --fail --location --retry 5 --output /usr/local/bin/kind \
        "https://github.com/kubernetes-sigs/kind/releases/download/v${KIND_VERSION}/kind-linux-amd64" \
    && echo "${KIND_SHA256}  /usr/local/bin/kind" | sha256sum --check --strict \
    && curl --fail --location --retry 5 --output /tmp/kustomize.tar.gz \
        "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${KUSTOMIZE_VERSION}/kustomize_v${KUSTOMIZE_VERSION}_linux_amd64.tar.gz" \
    && echo "${KUSTOMIZE_SHA256}  /tmp/kustomize.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --file /tmp/kustomize.tar.gz --directory /usr/local/bin kustomize \
    && curl --fail --location --retry 5 --output /usr/local/bin/bazelisk \
        "https://github.com/bazelbuild/bazelisk/releases/download/v${BAZELISK_VERSION}/bazelisk-linux-amd64" \
    && echo "${BAZELISK_SHA256}  /usr/local/bin/bazelisk" | sha256sum --check --strict \
    && chmod 0755 /usr/local/bin/kind /usr/local/bin/bazelisk \
    && ln -s bazelisk /usr/local/bin/bazel \
    && rm /tmp/cmake.tar.gz /tmp/ninja.zip /tmp/maven.tar.gz /tmp/kustomize.tar.gz \
    && cmake --version && ctest --version && cpack --version && ninja --version \
    && kind version && kustomize version

# The real CLI, behind the image's `docker` (docker.sh), which keeps the
# runner's own container out of the job's `docker ps` and `docker kill`.
COPY --from=cli /usr/local/bin/docker /usr/local/libexec/backmesh/
COPY docker.sh /usr/local/bin/docker

RUN archive="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    && curl --fail --location --retry 5 --output "/tmp/${archive}" \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${archive}" \
    && echo "${RUNNER_SHA256}  /tmp/${archive}" | sha256sum --check --strict \
    && tar --extract --gzip --file "/tmp/${archive}" --directory /opt/actions-runner-dist \
    && rm "/tmp/${archive}" \
    && printf '%s\n' "$RUNNER_VERSION" > /opt/actions-runner-dist/.runner-version \
    && /opt/actions-runner-dist/bin/installdependencies.sh \
    && chown -R runner:runner /opt/actions-runner-dist \
    && rm -rf /var/lib/apt/lists/* \
    && docker buildx version \
    && docker compose version \
    && gh --version \
    && node --version

COPY runner-job.sh /usr/local/bin/runner-job
COPY runner-job-completed.sh runner-job-started.sh /usr/local/bin/
COPY dist/auto-cache.mjs dist/LICENSE dist/NOTICE /usr/local/lib/backmesh/
COPY first-use.bash /etc/backmesh/first-use.bash
# The cloud CLIs, Rust, PowerShell, Go, Java and Chrome install on first use,
# from any caller (pinned.sh).
COPY keys/ /usr/share/keyrings/backmesh/
COPY pinned.sh /usr/local/libexec/backmesh/pinned
# apt-get and apt fetch apt's lists on first use (apt.sh). Actions that
# hardcode GitHub's tool cache path, such as ruby/setup-ruby, find the image's
# through /opt/hostedtoolcache; the entrypoint creates it as the runner user.
# en_US.UTF-8 for tools that ask for it by name.
COPY apt.sh /usr/local/libexec/backmesh/apt
RUN for cmd in az gcloud gsutil aws rustup cargo rustc rustdoc rustfmt cargo-fmt cargo-clippy clippy-driver \
        pwsh go gofmt java javac jar keytool google-chrome google-chrome-stable chromedriver; do \
      ln -s /usr/local/libexec/backmesh/pinned "/usr/local/bin/$cmd"; \
    done \
    && install -d "$JAVA_HOME/bin" /opt/google/chrome "$CHROMEWEBDRIVER" \
    && for cmd in "$JAVA_HOME"/bin/{java,javac,jar,keytool} /usr/bin/google-chrome /opt/google/chrome/chrome \
        "$CHROMEWEBDRIVER/chromedriver"; do \
      ln -s /usr/local/libexec/backmesh/pinned "$cmd"; \
    done \
    && printf '%s\n' "az_version=$AZ_VERSION" "az_sha256=$AZ_SHA256" "gcloud_version=$GCLOUD_VERSION" \
        "gcloud_sha256=$GCLOUD_SHA256" "aws_version=$AWS_VERSION" "rustup_version=$RUSTUP_VERSION" \
        "rustup_sha256=$RUSTUP_SHA256" "rust_version=$RUST_VERSION" "pwsh_version=$PWSH_VERSION" \
        "pwsh_sha256=$PWSH_SHA256" "go_version=$GO_VERSION" "go_sha256=$GO_SHA256" "java_version=$JAVA_VERSION" \
        "java_sha256=$JAVA_SHA256" "chrome_version=$CHROME_VERSION" "chrome_sha256=$CHROME_SHA256" \
        "chromedriver_sha256=$CHROMEDRIVER_SHA256" >/usr/share/backmesh/pinned.env \
    && ln -s /usr/local/libexec/backmesh/apt /usr/local/bin/apt-get \
    && ln -s /usr/local/libexec/backmesh/apt /usr/local/bin/apt \
    && ln -s "$RUNNER_TOOL_CACHE" /opt/hostedtoolcache \
    && locale-gen en_US.UTF-8
# The release's tag, or the commit's (image.yml), as GitHub's ImageVersion.
ARG IMAGE_VERSION=dev
ENV ImageVersion=${IMAGE_VERSION}
# Bash reads it in every non-interactive shell, as a `run:` step is.
ENV BASH_ENV=/etc/backmesh/first-use.bash

LABEL org.opencontainers.image.source="https://github.com/backmesh/backmesh" \
      org.opencontainers.image.title="backmesh runner" \
      org.opencontainers.image.description="One ephemeral GitHub Actions runner per anycloud VM Job, using its VM's Docker" \
      sh.anycloud.backmesh.runner-version="${RUNNER_VERSION}"

USER runner
ENTRYPOINT ["/usr/local/bin/runner-job"]
CMD ["run"]
