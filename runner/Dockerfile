# backmesh's runner image: Ubuntu, the actions runner,
# Docker's CLI with buildx and compose from the pinned Docker CLI image (jobs
# use the VM's Docker through its socket), the apt packages
# GitHub's Ubuntu 24.04 image installs (parity/toolset.lock), Node with
# corepack, and a few CLIs. Languages come from actions/setup-* into the tool
# cache; any other command in Ubuntu's archive installs on first use
# (first-use.bash). From anycloud's docker/github-actions-runner/Dockerfile and
# pool/Dockerfile.
ARG DOCKER_CLI_IMAGE=mirror.gcr.io/library/docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c
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
# The cloud CLIs, installed on first use (cloud-cli.sh): Microsoft's noble
# package, Google's x86-64 archive, and AWS's x86-64 zip, which AWS's key
# signs.
ARG AZ_VERSION=2.93.0
ARG AZ_SHA256=a6ed3e2d3eca33c6e3b40d0534d4607048a02d656192accefcb7881ce8679124
ARG GCLOUD_VERSION=593.0.0
ARG GCLOUD_SHA256=42c32b7553c712f71fcf6f124546c0519437f53755f47f9bd0c957998cd6b826
ARG AWS_VERSION=2.40.4
# corepack's defaults where a repository names no packageManager.
ARG YARN_VERSION=1.22.22
ARG PNPM_VERSION=12.18.0

# PIPX_*: where GitHub's image puts pipx's apps, on PATH, which ends in
# /usr/games as GitHub's does, for packages such as cowsay. COREPACK_*: yarn and
# pnpm without a prompt, kept in a directory the runner user writes. The tool
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
    COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PATH=/opt/pipx_bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# The lock's packages; the ones backmesh needs, listed even where the lock has
# them, or adds (gettext-base for envsubst; git-lfs, which git runs without
# bash, so it can't install on first use); and the first-use index: every
# command in the archive's command metadata with its package, main's first.
# apt fetches the metadata, so it's checked against the archive's signature.
COPY parity/toolset.lock /tmp/toolset.lock
RUN echo 'Acquire::IndexTargets::deb::CNF { MetaKey "$(COMPONENT)/cnf/Commands-$(NATIVE_ARCHITECTURE)"; ShortDescription "Commands-$(NATIVE_ARCHITECTURE)"; Description "$(RELEASE)/$(COMPONENT) $(NATIVE_ARCHITECTURE) c-n-f Metadata"; flatMetaKeyFormat "cnf/Commands-$(NATIVE_ARCHITECTURE)"; flatDescription "$(RELEASE) c-n-f Metadata"; };' \
        >/etc/apt/apt.conf.d/50backmesh-commands \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        gettext-base \
        gh \
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
      done | awk '$1 == "name:" { pkg = $2 } $1 == "commands:" { n = split($2, c, ","); for (i = 1; i <= n; i++) if (!seen[c[i]]++) print c[i], pkg }' \
        >/usr/share/backmesh/commands \
    && [[ $(wc -l </usr/share/backmesh/commands) -gt 10000 ]] \
    && useradd --create-home --uid 1001 --shell /bin/bash runner \
    && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner \
    && install -d -o runner -g runner /opt/actions-runner-dist \
        /opt/pipx /opt/pipx_bin /opt/corepack \
    && rm -rf /etc/apt/apt.conf.d/50backmesh-commands /var/lib/apt/lists/* /tmp/toolset.lock

# Node and npm with corepack's yarn and pnpm. npm's global directories are the
# runner user's, so `npm install --global` needs no sudo, as on GitHub's image.
# kubectl, helm and yq.
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
    && chmod 0755 /usr/local/bin/kubectl /usr/local/bin/yq \
    && rm /tmp/node.tar.xz /tmp/helm.tar.gz \
    && node --version && yarn --version && pnpm --version && kubectl version --client && helm version && yq --version

# The real CLI, behind the image's `docker` (docker.sh), which keeps the
# runner's own container out of the job's `docker ps` and `docker kill`.
COPY --from=cli /usr/local/bin/docker /usr/local/libexec/backmesh/
COPY docker.sh /usr/local/bin/docker
COPY --from=cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

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
# az, gcloud, gsutil and aws install on first use, from any caller (cloud-cli.sh).
COPY keys/ /usr/share/keyrings/backmesh/
COPY cloud-cli.sh /usr/local/libexec/backmesh/cloud-cli
# apt-get and apt fetch apt's lists on first use (apt.sh). Actions that
# hardcode GitHub's tool cache path, such as ruby/setup-ruby, find the image's
# through /opt/hostedtoolcache; the entrypoint creates it as the runner user.
# en_US.UTF-8 for tools that ask for it by name.
COPY apt.sh /usr/local/libexec/backmesh/apt
RUN for cli in az gcloud gsutil aws; do ln -s /usr/local/libexec/backmesh/cloud-cli "/usr/local/bin/$cli"; done \
    && printf 'az_version=%s\naz_sha256=%s\ngcloud_version=%s\ngcloud_sha256=%s\naws_version=%s\n' \
        "$AZ_VERSION" "$AZ_SHA256" "$GCLOUD_VERSION" "$GCLOUD_SHA256" "$AWS_VERSION" >/usr/share/backmesh/cloud-cli.env \
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
