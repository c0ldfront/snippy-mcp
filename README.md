# snippy-mcp

A Model Context Protocol (MCP) server that lets any repo **push, store, tag, search, and render** reusable code **standards**, **snippets**, and **resources** with `${variable}` substitution. Built on Bun + `bun:sqlite`, zero Node.js dependencies.

## Install

```bash
bun install
```

Optionally register globally:

```bash
bun link
# then from any project
snippy-mcp  # runs the stdio server
```

## Configure

| Env var     | Default                | Purpose                              |
| ----------- | ---------------------- | ------------------------------------ |
| `SNIPPY_DB`               | `$HOME/.snippy-mcp.db` | SQLite file holding all artifacts.            |
| `SNIPPY_HTTP_PORT`        | `7878`                 | TCP port for `--http` transport.              |
| `SNIPPY_HTTP_HOST`        | `127.0.0.1`            | Bind address for `--http` transport.          |
| `SNIPPY_ORIGIN_ALLOWLIST` | _(unset)_              | CSV of allowed `Origin` headers; if unset, all origins are accepted (suitable only for local-only deployments). |
| `SNIPPY_HTTP_TOKENS`      | _(unset)_              | CSV of `token:role` pairs (`reader|writer|admin`). When unset, every HTTP caller is granted `admin`. Stdio transport is always trusted. |
| `SNIPPY_AUDIT_DAYS`       | `90`                   | Audit-log retention in days. `0` disables pruning.            |
| `SNIPPY_WORKSPACES`       | _(unset)_              | JSON `{ name: dbPath }` map of named workspaces. When unset, a single `default` workspace is created at `SNIPPY_DB`. |
| `SNIPPY_WORKSPACE`        | `default`              | Stdio transport workspace selection (also overridable via `--workspace=name`). |

## Run

```bash
bun run src/cli.ts
```

Or via the declared bin:

```bash
snippy-mcp
```

The server speaks the MCP protocol over stdio by default. Wire it into any MCP-capable client (Claude Desktop, IDE integrations, custom agents). For a long-lived shared instance, use the HTTP transport instead:

```bash
snippy-mcp --http
# POST JSON-RPC at http://127.0.0.1:7878/mcp ; GET /healthz and /readyz for probes.
```

Every subcommand and environment variable is summarised inline:

```bash
snippy-mcp --help      # or -h
snippy-mcp --version   # or -v
```

### Claude Desktop config example

```json
{
  "mcpServers": {
    "snippy": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/snippy-mcp/src/cli.ts"],
      "env": { "SNIPPY_DB": "/absolute/path/to/snippy.db" }
    }
  }
}
```

## MCP Surface

### Tools

| Name                     | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `artifact.push`          | Upsert an artifact by `(kind, name)`; supports `dryRun`.       |
| `artifact.get`           | Fetch by stable id.                                            |
| `artifact.getByName`     | Fetch by `(kind, name)`.                                       |
| `artifact.list`          | Newest-first list with keyset cursor + kind/language/tag filter. Defaults to `summary: true` (omits `content`/`variables`, includes `contentBytes`/`variableCount`). |
| `artifact.search`        | FTS5 full-text search with kind/tag filters and stable keyset cursor (bound to its query). Same `summary: true` default as `list`. |
| `artifact.tag`           | Add tags.                                                      |
| `artifact.untag`         | Remove tags.                                                   |
| `artifact.delete`        | Delete by id (tags and aliases cascade).                       |
| `artifact.rename`        | Rename an artifact. Old name becomes an alias so consumers don't break. |
| `artifact.history`       | List every stored revision for an artifact (summary by default). |
| `artifact.rollback`      | Replace current content with the content from a prior revision; creates a new revision. |
| `artifact.render`        | Substitute `${var}` placeholders by id.                        |
| `artifact.renderByName`  | Substitute `${var}` placeholders by `(kind, name)`.            |
| `artifact.export`        | Dump every artifact (with optional kind/tag filter + `includeHistory`) as NDJSON. |
| `artifact.import`        | Bulk-load NDJSON with `conflict: skip \| overwrite \| error` + optional `includeHistory`.  |

All tools declare zod `inputSchema` + `outputSchema` and return both `content` (JSON text) and `structuredContent` for protocol-correct machine consumption.

### Resources

One URI template: `snippet://{workspace}/{kind}/{id}` (workspace defaults to `default` when `SNIPPY_WORKSPACES` is unset). Listing paginates through every stored artifact; reads return raw `content` with a `text/x-{language}` mime type when a language is set, `text/plain` otherwise.

### Prompts

| Name             | Args                                   | Returns                                                        |
| ---------------- | -------------------------------------- | -------------------------------------------------------------- |
| `apply-standard` | `name`, optional `targetLanguage`      | Single user message embedding the standard as an instruction.  |
| `reuse-snippet`  | `name`, optional `bindings` (JSON obj) | Single user message with the rendered snippet in a fenced block.|

## Kinds

`snippy-mcp` stores three kinds of artifact, all text-bodied:

- **standard** — a rule, convention, or checklist meant to be applied to a task.
- **snippet** — a fragment of code ready to be rendered into a specific project.
- **resource** — any other reusable text asset (prompt fragment, config template, prose reference).

All three share the same storage and MCP surface; the distinction is semantic and is reflected in the prompts and in how downstream agents frame the content.

## Variable Substitution

Artifacts may declare a `variables` array:

```jsonc
{
  "kind": "snippet",
  "name": "bun-test-skel",
  "language": "typescript",
  "content": "import { test, expect } from \"bun:test\";\ntest(\"${case}\", () => {});",
  "variables": [{ "name": "case", "default": "smoke" }]
}
```

`artifact.render` and the `reuse-snippet` prompt substitute `${case}` with a caller-supplied binding, falling back to `default` when the caller omits it. If any required variable is still missing after defaults are applied, the render fails with a structured error listing **every** missing name in one go.

Naming rules:
- `kind`: `standard | snippet | resource`
- `name`: `/^[a-z0-9][a-z0-9._-]{0,99}$/` (unique per kind)
- tags: `/^[a-z0-9][a-z0-9-]{0,63}$/`
- variable names: C-style identifiers (`/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/`)

## Error Codes

Every domain failure throws an `McpError` whose `data.snippyCode` is one of the stable strings below. Clients can switch on these without parsing human-readable messages.

| `snippyCode`                         | When it fires                                                |
| ------------------------------------ | ------------------------------------------------------------ |
| `snippy.notFound`                    | Lookup by id or `(kind, name)` resolved nothing.             |
| `snippy.nameConflict`                | Rename target collides with another artifact's live name.    |
| `snippy.aliasConflict`               | Push or rename hits a name that's already an alias for someone else. |
| `snippy.tooManyAliases`              | Artifact already has 32 aliases.                             |
| `snippy.invalidName`                 | Name violates the kebab-style validator.                     |
| `snippy.invalidBindings`             | Bindings JSON is malformed or has non-string values.         |
| `snippy.renderMissingBindings`       | Render couldn't satisfy one or more `${var}` references.     |
| `snippy.rootViolation`               | Materialize target lies outside an advertised root.          |
| `snippy.noRootsAdvertised`           | Materialize attempted with no client/env roots.              |
| `snippy.overwriteRefused`            | Materialize would clobber an existing file under `conflict='error'`. |
| `snippy.revisionMissing`             | Rollback to a non-existent version.                          |
| `snippy.legacyCursor`                | v1 offset-style search cursor passed in v2.                  |
| `snippy.malformedCursor`             | Cursor failed to decode against any known shape.             |
| `snippy.searchCursorQueryMismatch`   | Search cursor was issued for a different `query` string.     |
| `snippy.importLineInvalid`           | An NDJSON line failed to parse or validate during import.    |
| `snippy.unauthorized`                | HTTP transport: missing/invalid bearer token.                |
| `snippy.forbidden`                   | HTTP transport: token role insufficient for the operation.   |
| `snippy.workspaceUnknown`            | Workspace name not in `SNIPPY_WORKSPACES`.                   |
| `snippy.cancelled`                   | Caller's `AbortSignal` fired before the long-running op finished. |

## Container image

```bash
docker build -t snippy-mcp:0.2.0 .
docker run --rm -p 7878:7878 -v $(pwd)/data:/data \
  -e SNIPPY_HTTP_TOKENS="$(openssl rand -hex 16):admin" \
  snippy-mcp:0.2.0
```

The Dockerfile is multi-stage: an `oven/bun:1` builder compiles a single static binary via `bun build --compile --target=bun-linux-x64-musl`, then the runtime layer is `gcr.io/distroless/base-debian12:nonroot` — no shell, no package manager, just the binary running as the unprivileged `nonroot` user. Default `CMD` is `--http`; override (`command: ["--stdio"]` in compose) for stdio use.

## Releases

```bash
# 1. cut a signed annotated tag (gpg-signed)
git tag -s v0.2.0 -m "snippy-mcp 0.2.0"
git push --tags

# 2. CI (.github/workflows/release.yml) takes over: forge release →
#    builds binaries for every target in package.json#forge.targets,
#    emits SHA256SUMS.txt over them, generates target/SBOM.cyclonedx.json
#    via `forge sbom`, and attaches the lot to the GitHub release.
```

The release artifacts are: per-triple binary archives, `SHA256SUMS.txt`, and a CycloneDX 1.5 SBOM (`SBOM.cyclonedx.json`).

## Generate client config

```bash
# Print a Claude Desktop config snippet to stdout
snippy-mcp generate claude-desktop

# Write a Cursor config straight to the file
snippy-mcp generate cursor --out ~/.cursor/mcp.json

# HTTP transport with a bearer token (configures the headers block)
snippy-mcp generate vscode --http --url http://localhost:7878/mcp --token tok-1

# Workspaces flow into args (stdio) or ?workspace= (http)
snippy-mcp --workspace=team generate claude-desktop --out ./team-claude.json

# Shell exports for ad-hoc env wiring
snippy-mcp generate shell-env --http --token tok-1 > /tmp/snippy.env
```

Supported formats: `claude-desktop`, `cursor`, `vscode`, `mcp-json`, `shell-env`. Each emits a ready-to-paste configuration that points at the active binary, picks up the current `SNIPPY_DB`/`SNIPPY_ROOTS` env, and respects `--workspace`.

## Backup & restore

```bash
# Live backup of the default workspace
snippy-mcp backup --out /tmp/snippy.bak.db

# Restore (replaces the current workspace DB; restart the server afterwards)
snippy-mcp restore --in /tmp/snippy.bak.db

# Pick a specific workspace
snippy-mcp --workspace=team backup --out /tmp/team.bak.db
```

`backup` uses `VACUUM INTO` so it works concurrently with active writers (no quiesce required). `restore` overwrites the workspace's `.db` file (and its `-wal`/`-shm` siblings); any running server pinned to that workspace must restart to pick up the new contents.

## Development

```bash
bun run lint       # biome check
bun run fix        # biome check --write
bun run typecheck  # tsc --noEmit
bun test           # bun:test, colocated + tests/e2e.test.ts
bun run check      # lint + typecheck + test
bun run dev        # bun --hot ./src/cli.ts
```

Stack:
- Runtime: **Bun** (uses `Bun.file`, `Bun.$`, `Bun.spawn`, `bun:sqlite`, `bun:test` — no Node.js equivalents).
- Protocol: `@modelcontextprotocol/sdk` 1.29.
- Validation: `zod` 4.
- Lint/format: `@biomejs/biome` 2.4.

## Design Notes

- **Storage:** single `bun:sqlite` file; `PRAGMA foreign_keys=ON`; WAL mode. FTS5 non-contentless virtual table kept in sync with the `artifacts` table via three triggers (insert/delete/update) so writes remain a single source of truth.
- **Pagination:** keyset over `(updated_at DESC, id DESC)` for `list`, and keyset over `(bm25, rowid)` for `search` (bound to the query that issued the cursor). Legacy v1 offset cursors are rejected with a typed error so clients restart cleanly after upgrade.
- **Transport:** stdio by default, optional Streamable HTTP via `--http`. The HTTP transport runs on `Bun.serve` with `WebStandardStreamableHTTPServerTransport`; sessions are routed by the `Mcp-Session-Id` header, every session owns its own `McpServer` instance, and `/healthz`/`/readyz` probes are exposed alongside the JSON-RPC endpoint.
- **Auth (HTTP only).** Bearer-token gate driven by `SNIPPY_HTTP_TOKENS`. Each token is mapped to a `reader | writer | admin` role; the per-session `McpServer` only registers tools the role allows, so `listTools` reflects the caller's privileges. Stdio is always trusted (you've already paid the cost of spawning the parent process).
- **Audit log.** Every tool call lands a row in `audit_log` (best-effort: a failed insert never blocks the primary operation). Each row carries actor, tool name, args (JSON, truncated past 8 KB), result code (`ok` or a `snippyCode`), optional artifact id, and timestamp. Inspect with `snippy-mcp audit tail [N]`; CLI startup prunes rows older than `SNIPPY_AUDIT_DAYS` (default 90, `0` disables).
- **Metrics (HTTP only).** `GET /metrics` exposes Prometheus text v0.0.4: `snippy_tool_calls_total{tool,result}` (counter), `snippy_tool_call_duration_seconds{tool}` (histogram), and live gauges for artifacts, revisions, aliases, FTS rows, and audit rows. Hand-rolled — no Prometheus client dependency.
- **Progress + cancellation.** `artifact.export`, `artifact.import`, and `artifact.materializeMany` honor the caller's `AbortSignal` between iterations and emit `notifications/progress` when `_meta.progressToken` is provided.
- **Elicitation.** When `artifact.materialize` would clobber an existing file under `conflict='error'` and the client advertises the `elicitation` capability, snippy asks the user to confirm via `elicitation/create`. Without elicitation support, the original `snippy.overwriteRefused` error semantics stand.
- **Workspaces.** A single server can host multiple SQLite stores via `SNIPPY_WORKSPACES` (JSON `{name: dbPath}`). Each workspace owns an isolated `ArtifactRepo`, `AuditWriter`, and Prometheus registry. The HTTP transport routes via the `?workspace=name` query param on session init; stdio picks one via `SNIPPY_WORKSPACE` or `--workspace=name`. Resource URIs are `snippet://{workspace}/{kind}/{id}` (always — there is no v1 fallback shape).
- **Rename + aliases.** `artifact.rename(id, newName)` transactionally swaps the live name and files the old name as an alias in an `aliases` table keyed by `(kind, alias)` (FK-cascaded on delete). `artifact.getByName`, the `apply-standard`/`reuse-snippet` prompts, and `renderByName` all resolve aliases transparently; `artifact.push` matches on live names only, so pushing into an alias fails fast with a typed error rather than silently mutating the aliased artifact. Search remains live-name only — aliases are a resolution surface, not a discovery surface.
- **Revision history.** Every `push` (including rollbacks) lands a row in `artifact_revisions` with a monotonic per-artifact `version`; FK-cascaded on delete. `artifact.history` returns the full history (summary by default). `artifact.rollback(id, toVersion)` replays a prior revision's content+variables as a *new* revision, so the rollback is itself auditable. Export/import gain `includeHistory`: export emits `_revisions` on each NDJSON line; import, when enabled, replaces the imported artifact's history with those rows.
- **Portability.** `artifact.export` and `artifact.import` speak NDJSON so a curated library can be moved between dev and team DBs, committed to a repo alongside code, or seeded into CI. Import conflict policy (`skip | overwrite | error`) lets consumers choose how aggressive a sync should be.
- **Observability.** Mutations emit MCP `notifications/message` (`artifact.created`, `artifact.updated`, `artifact.deleted`, `artifact.import`) so clients that opt in to `logging/setLevel` get an audit trail.

## License

MIT — see [LICENSE](LICENSE).
