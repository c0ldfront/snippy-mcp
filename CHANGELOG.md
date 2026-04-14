# Changelog

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
