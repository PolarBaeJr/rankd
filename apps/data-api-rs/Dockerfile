# The Rust build of the data API (1.1.0b). Build context is the REPO ROOT, as
# for every other image:
#   docker build -f apps/data-api-rs/Dockerfile --target runner-data-api-rs .
# Images are built only in CI, never on a host. No workflow publishes this one
# yet: that is an owner step (see README.md). arm64 only.
#
# One static musl binary on `scratch`: no shell, no libc, no package manager.
# The service makes plain HTTP calls to Kong and carries its own TLS roots
# (webpki-roots) for an https SUPABASE_URL, so the image needs nothing beside
# the binary. It is a drop-in for apps/data-api's image: same port, same
# environment, same uid, same contract.

# ---- Stage 1: compile ----
# The tag pins the same toolchain as apps/data-api-rs/rust-toolchain.toml;
# change both together. rust-toolchain.toml is deliberately NOT copied in:
# inside this image it would make rustup fetch a second copy of a toolchain it
# already has.
FROM rust:1.99.0-alpine AS builder-data-api-rs
# ring compiles a little C; the image has gcc, this is its libc headers.
RUN apk add --no-cache musl-dev
WORKDIR /build

# Dependencies first, against an empty crate, so that a source-only change
# reuses this layer instead of recompiling every dependency.
COPY apps/data-api-rs/Cargo.toml apps/data-api-rs/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs && \
    cargo build --release --locked && \
    rm -rf src

# package.json is read at compile time for the version /health reports, and
# src/docs holds the two HTML pages compiled in.
COPY apps/data-api-rs/package.json ./
COPY apps/data-api-rs/src ./src
# COPY keeps the files' own mtimes, which can be older than the empty crate
# built above; cargo would then call it up to date and ship `fn main() {}`.
# Dropping this crate's fingerprints forces the real build.
RUN rm -rf target/release/.fingerprint/data-api-rs-* && \
    touch src/main.rs src/lib.rs && \
    cargo build --release --locked && \
    cp target/release/data-api-rs /data-api-rs

# ---- Stage 2: runtime ----
FROM scratch AS runner-data-api-rs
COPY --from=builder-data-api-rs /data-api-rs /data-api-rs

# No /etc/passwd here, so a numeric user: the TypeScript image's uid and gid.
USER 1001:1001
ENV PORT=8080
EXPOSE 8080
# No curl, wget or shell in the image: the binary probes itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/data-api-rs", "-healthcheck"]
ENTRYPOINT ["/data-api-rs"]
