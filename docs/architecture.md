# Architecture

snippy-mcp is a Model Context Protocol (MCP) server backed by SQLite. The single binary speaks either stdio or Streamable HTTP and exposes one resource template, two prompts, and the full `artifact.*` tool surface.

## Layers

```
┌────────────────────────────────────────────────────────────────────┐
│ Transport (stdio | streamable HTTP via Bun.serve)                  │
│   - HTTP routes /mcp /healthz /readyz /metrics                     │
│   - Bearer auth + RBAC, origin allowlist                           │
│   - One McpServer instance per session, role-scoped                │
└─────────────┬──────────────────────────────────────────────────────┘
              │
┌─────────────▼──────────────────────────────────────────────────────┐
│ MCP layer (src/mcp/*)                                              │
│   - server.ts: capability negotiation + composition root           │
│   - tools.ts: 17 artifact.* tools, gated by role                   │
│   - resources.ts: snippet://{workspace}/{kind}/{id}                │
│   - prompts.ts: apply-standard, reuse-snippet                      │
│   - errors.ts: stable snippyCode registry                          │
│   - audit.ts, metrics.ts, completers.ts: cross-cutting concerns    │
└─────────────┬──────────────────────────────────────────────────────┘
              │
┌─────────────▼──────────────────────────────────────────────────────┐
│ Repo (src/repo/artifact-repo.ts) + Cursors (src/repo/cursor.ts)    │
│   - All SQL lives here. push/get/list/search/rename/rollback.      │
└─────────────┬──────────────────────────────────────────────────────┘
              │
┌─────────────▼──────────────────────────────────────────────────────┐
│ Storage (bun:sqlite)                                               │
│   - artifacts, tags, aliases, artifact_revisions, audit_log,       │
│     artifacts_fts (FTS5 virtual table)                             │
└────────────────────────────────────────────────────────────────────┘
```

## Composition

`buildServer({ repo, role, audit, metrics, db, workspace, … })` constructs an `McpServer` with capability flags for `tools`, `resources`, `prompts`, `logging`, and `completions`. Each session gets its own server, so:

- An RBAC-narrowed session truly only registers tools the role can call (the SDK never sees disallowed tools at all).
- Per-session audit/metrics state stays local to the workspace's writers.
- The HTTP transport routes `Mcp-Session-Id` to the right session map entry.

## Storage invariants

- `artifacts.UNIQUE(kind, name)` is the only canonical name for an artifact at any moment.
- `aliases.PRIMARY KEY(kind, alias)` reserves alternate names with FK cascade on artifact delete.
- `artifact_revisions.UNIQUE(artifact_id, version)` records every push/rollback; FK cascade.
- `tags.PRIMARY KEY(artifact_id, tag)` with FK cascade.
- FTS5 (`artifacts_fts`, contentless, indexes name/description/content) is kept in sync via triggers.

## Why no ORM

The repo layer is hand-rolled SQL on `bun:sqlite`'s prepared-statement API. The schema is small (six tables), every query has a deterministic plan, and we want raw control over keyset pagination and FTS bm25 scoring — a generic ORM would add a layer between us and the engine for no payoff.
