# Changelog

## 0.2.1 — 2026-04-14

A patch release. No public API or schema changes — the v0.2.0 tag was cut on a commit that failed the release gate on GitHub Actions runners (slower I/O than local dev), so v0.2.0 never published artifacts. v0.2.1 carries the underlying fix plus the release-pipeline hardening that was supposed to ship with it.

### Fixes
- **Database open under contention** (`src/db/connection.ts`): set `PRAGMA busy_timeout = 5000` so concurrent opens of a WAL-mode database wait politely instead of failing instantly with `SQLITE_BUSY`. Surfaced as a flaky `cli-backup.test.ts` failure on the slower I/O of GitHub Actions runners (test seeds a DB in-process, closes it, then spawns the `restore` subprocess which raced the WAL checkpoint-on-close). Also hardens real-world cases like `backup` running while the HTTP transport serves requests.

### Release pipeline
- **`forge --only`** (`forge.ts`): prefer exact triple/bunTarget matches (comma-list aware) before falling back to substring, so `--only=bun-linux-x64` no longer also picks up `bun-linux-x64-musl`. Defensive — canary Bun sometimes lags musl sidecars by a day, so a CI smoke pinned to one triple needs to actually pin one.
- **`.github/workflows/release.yml`**: aligned with the pipeline shape used across other apps in the same project family. Concurrency group on the tag ref (single-writer release), separate `check` re-run gate (lint + typecheck + tests + bench against the exact tagged commit, independent of `ci.yml`), tag/version/prerelease metadata resolution, CHANGELOG section auto-extracted into the GitHub Release body, OIDC-backed SLSA build-provenance attestation over the tarballs, multi-arch container published to `ghcr.io/c0ldfront/snippy-mcp` with provenance + SBOM + a separate SLSA attestation on the image digest. Fixed broken artifact globs that pointed at `target/*.tar.gz` / `target/SHA256SUMS.txt` instead of `target/packages/*.tar.gz` / `target/packages/SHA256SUMS.txt` — with `fail_on_unmatched_files: false`, the previous v0.2.0 release would have silently shipped without binaries or checksums even if the test suite had passed.

## 0.2.0 — 2026-04-13

A v1 → v2 cut focused on the previously-deferred storage features and an enterprise-grade operations surface. See [docs/migration-v1-to-v2.md](docs/migration-v1-to-v2.md) for the full breaking-change list.

### Storage / behaviour
- **Rename + aliases** (`artifact.rename`): old name auto-files as an alias; getByName/prompts/renderByName resolve transparently. Push matches live names only — pushing an aliased name throws `snippy.aliasConflict` instead of silently mutating.
- **Revision history** (`artifact.history`, `artifact.rollback`): every push lands an immutable revision; rollback creates a new revision (auditable). Export/import gain `includeHistory`.
- **Stable search cursor**: replaced offset with a query-bound `(bm25, rowid)` keyset. Legacy v1 cursors decode into a typed `snippy.legacyCursor` McpError.
- **Workspaces**: `SNIPPY_WORKSPACES` JSON map declares multiple SQLite stores. Resource URIs become `snippet://{workspace}/{kind}/{id}` (breaking).

### Transports
- **Streamable HTTP** (`--http`): `Bun.serve` + `WebStandardStreamableHTTPServerTransport`. Per-session McpServer routed via `Mcp-Session-Id`. `/healthz`, `/readyz`, `/metrics` endpoints. `SNIPPY_HTTP_HOST`/`PORT`/`ORIGIN_ALLOWLIST` knobs.

### Observability
- **Audit log** (`audit_log` table): every tool call lands a row keyed by `snippyCode`. `snippy-mcp audit tail [N]`. `SNIPPY_AUDIT_DAYS` retention (default 90).
- **Prometheus metrics** (`/metrics`): hand-rolled counters/histograms/gauges, no client lib. Series for tool calls, latency, artifact / revision / alias / FTS / audit row counts.

### Auth
- **Bearer-token RBAC** (HTTP only): `SNIPPY_HTTP_TOKENS=token:role` with `reader|writer|admin`. Per-session McpServer literally doesn't register tools the role can't call. Stdio remains trusted.

### MCP protocol features
- **Completion callbacks**: id/name autocomplete on tool inputs, id completer added to the resource template.
- **Progress + cancellation**: export/import/materializeMany emit `notifications/progress` and honour `AbortSignal`.
- **Elicitation**: `artifact.materialize` requests overwrite confirmation via `elicitation/create` when the client supports it; falls back to `snippy.overwriteRefused` otherwise.

### Operations
- **Backup / restore**: `snippy-mcp backup --out` (live `VACUUM INTO`); `restore --in` (cleans WAL/SHM siblings before swap).
- **Container image**: multi-stage Dockerfile (oven/bun → distroless nonroot).
- **CI/CD**: `.github/workflows/{ci,release}.yml`. CI matrix on bun-latest + canary; release on `v*` tags attaches binaries, `SHA256SUMS.txt`, and a CycloneDX SBOM.
- **forge sbom**: emits CycloneDX 1.5 by walking node_modules — no parser, no lockfile coupling.
- **`snippy-mcp generate <format>`**: claude-desktop / cursor / vscode / mcp-json / shell-env config emitter.

### Developer-facing
- **Error registry** (`src/mcp/errors.ts`): every domain failure carries a stable `data.snippyCode`. README has a full table.
- **Benchmarks** (`bench/all.bench.ts`): push, list@10k, search@10k, render hot path. CI fails on ≥20% p95 regression vs `bench/baseline.json`.
- **Property tests** (`src/security.test.ts`): 100 random inputs each across name/tag schemas, path normalization, render edges, cursor tampering.
- **Docs tree** (`docs/`): architecture, transports, auth, workspaces, threat model, runbook, benchmarks, tool reference, migration.

## 0.1.0

Initial release. Push/get/list/search/tag/untag/delete/render(ByName)/export/import/materialize(Many) over stdio.
