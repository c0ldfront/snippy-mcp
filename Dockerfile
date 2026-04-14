# syntax=docker/dockerfile:1.7

# ── Builder ─────────────────────────────────────────────────────────
FROM oven/bun:1 AS builder
WORKDIR /src

# Install dependencies first for cache reuse.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Compile a single self-contained binary.
COPY tsconfig.json biome.json ./
COPY src ./src
COPY forge.ts ./
RUN bun build ./src/cli.ts \
      --compile \
      --target=bun-linux-x64-musl \
      --outfile /out/snippy-mcp

# ── Runtime ─────────────────────────────────────────────────────────
# Bun-compiled binaries are statically linked enough to run on a
# distroless base — no node, no runtime, just the executable + libc.
FROM gcr.io/distroless/base-debian12:nonroot AS runtime
LABEL org.opencontainers.image.title="snippy-mcp"
LABEL org.opencontainers.image.source="https://github.com/c0ldfront/snippy-mcp"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --from=builder /out/snippy-mcp /usr/local/bin/snippy-mcp

# Default to HTTP transport on a known port; override the entrypoint
# args (or `command:` in compose) to switch to stdio for IDE-style use.
ENV SNIPPY_HTTP_HOST=0.0.0.0
ENV SNIPPY_HTTP_PORT=7878
ENV SNIPPY_DB=/data/snippy.db

EXPOSE 7878
VOLUME ["/data"]

USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/snippy-mcp"]
CMD ["--http"]
