# #160's image for the pull probe: v0.7.2's runner image with #160's
# Rust layer on top, built as #160's Dockerfile builds it. Only its size
# matters here: #160 put the layer before the runner's, so the layers after
# it were rebuilt too, but the bytes a pull fetches are the same plus about
# 218 MB.
ARG BASE=ghcr.io/backmesh/backmesh-runner@sha256:c4604e52d1d26bbf359a2b59aa39547e60f983deb7c912387977801258a1a918
FROM ${BASE}

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV CARGO_HOME=/home/runner/.cargo \
    RUSTUP_HOME=/home/runner/.rustup \
    PATH=/opt/pipx_bin:/home/runner/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256_AMD64=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG RUSTUP_SHA256_ARM64=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282
ARG RUST_VERSION=1.100.0
ARG TARGETARCH
RUN . <(env | sed -n "s/^\([A-Z]*_SHA256\)_${TARGETARCH^^}=/\1=/p") \
    && t=$(uname -m)-unknown-linux-gnu \
    && curl --fail --location --retry 5 --output /tmp/rustup-init \
        "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${t}/rustup-init" \
    && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum --check --strict \
    && chmod 0755 /tmp/rustup-init \
    && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "$RUST_VERSION" \
        --component clippy,rustfmt \
    && mv "$RUSTUP_HOME/toolchains/$RUST_VERSION-$t" "$RUSTUP_HOME/toolchains/stable-$t" \
    && mv "$RUSTUP_HOME/update-hashes/$RUST_VERSION-$t" "$RUSTUP_HOME/update-hashes/stable-$t" \
    && rustup default stable \
    && chown -R runner:runner "$RUSTUP_HOME" "$CARGO_HOME" \
    && rm /tmp/rustup-init \
    && cargo --version && rustc --version
USER runner
