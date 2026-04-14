# Migration: v0.1 → v0.2

snippy-mcp 0.2.0 is a **mostly additive** release on top of 0.1, but a handful of changes are observable through the MCP surface and in the on-disk schema. Read this end-to-end before upgrading.

## Schema

Migrations 2, 3, and 4 run automatically on startup:

- `aliases(artifact_id, kind, alias, created_at, …)` — backs `artifact.rename`.
- `artifact_revisions(id, artifact_id, version, content, variables_json, created_at, …)` — backs `artifact.history` / `artifact.rollback`. Existing artifacts get their first revision recorded on the *next* `push` (we do not back-fill v1 content into a synthetic version 1).
- `audit_log(id, ts, actor, tool, args_json, result_code, artifact_id, correlation_id)` — see `docs/runbook.md`.

If a migration fails the binary refuses to serve and rolls back the partial transaction. Take a backup before upgrading (`snippy-mcp backup --out path.bak.db`).

## Resource URIs (breaking)

v0.1: `snippet://{kind}/{id}`
v0.2: `snippet://{workspace}/{kind}/{id}`

Clients that hard-coded the v1 shape will get `snippy.notFound` on `resources/read`. Workspace defaults to `default`, so the equivalent of the old shape is `snippet://default/{kind}/{id}`.

The resource template advertised by the server is now `snippet://{workspace}/{kind}/{id}`; clients that read `listResourceTemplates` and follow the template will continue to work.

## Search cursor (breaking)

The v0.1 search cursor was an offset; v0.2 uses a query-bound bm25/rowid keyset. Old cursors decode into a typed `snippy.legacyCursor` McpError so clients can detect the upgrade and restart pagination from page 1.

If a v1 client still has an offset cursor after upgrade, the next `artifact.search` call with that cursor returns:

```json
{
  "code": -32602,
  "data": { "snippyCode": "snippy.legacyCursor" }
}
```

Restart the search without the `cursor` argument.

## Push semantics around aliases

`artifact.push` now matches on **live names only**. Pushing a name that's reserved by an alias of another artifact throws `snippy.aliasConflict` instead of silently mutating the aliased artifact.

If you have an automation that pushes by name to refresh an artifact, the behaviour is unchanged for live names. If your tooling pushes into an alias, you'll start seeing `snippy.aliasConflict` — resolve by either renaming back, deleting the conflicting artifact, or pushing to the live name.

## NDJSON export (additive)

Export NDJSON does **not** include aliases or revisions by default — set `includeHistory: true` if you want revisions. Aliases are excluded entirely (they're a lookup-side concern, not part of the portable artifact shape). The README's export-test asserts the absence of an `aliases` field on each line.

## HTTP transport (new)

`snippy-mcp --http` opt-in. Default bind is `127.0.0.1:7878`. Three new env vars: `SNIPPY_HTTP_HOST`, `SNIPPY_HTTP_PORT`, `SNIPPY_ORIGIN_ALLOWLIST`. Stdio remains the default.

## Auth (new)

`SNIPPY_HTTP_TOKENS` gates the HTTP transport with `reader|writer|admin` RBAC. **Stdio is always trusted** — no change for IDE-spawned use.

## Audit log (new)

Every tool call lands a row in `audit_log`. Inspect with `snippy-mcp audit tail [N]`. `SNIPPY_AUDIT_DAYS` controls retention (default 90, `0` disables).

## Metrics (new)

`/metrics` on the HTTP transport exposes Prometheus text v0.0.4. No metrics dependency was added.

## Workspaces (new)

`SNIPPY_WORKSPACES` declares additional named DBs. URIs include the workspace name (see above). Stdio picks via env or `--workspace=`; HTTP picks via `?workspace=` query param.

## CLI generate (new)

`snippy-mcp generate <format>` emits a ready-to-paste client config (`claude-desktop`, `cursor`, `vscode`, `mcp-json`, `shell-env`). Use `--out` to write to a file, `--http`/`--token` to wire up the HTTP transport, `--workspace=name` to embed the workspace selector.

## Bumped to 0.2.0

`package.json#version` is now `0.2.0`. Tag `v0.2.0` to trigger the release workflow.

## Quick checklist for upgraders

- [ ] Take a backup with v0.1 binary: `cp $SNIPPY_DB $SNIPPY_DB.v01.bak`.
- [ ] Stop the server.
- [ ] Replace the binary.
- [ ] Start. Migrations 2, 3, 4 apply automatically.
- [ ] If running on the HTTP transport: set `SNIPPY_HTTP_TOKENS`, set `SNIPPY_ORIGIN_ALLOWLIST`.
- [ ] Audit clients for the new resource URI shape; restart any cursor-paginated search loops.
