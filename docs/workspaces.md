# Workspaces

A single `snippy-mcp` process can host multiple independent SQLite stores. Each workspace owns its own:

- `artifacts`/`tags`/`aliases`/`artifact_revisions` tables
- `audit_log` (and retention pruning)
- Prometheus gauge values

## Declaring workspaces

```bash
SNIPPY_WORKSPACES='{"team":"/srv/snippy/team.db","personal":"/srv/snippy/personal.db"}'
```

Workspace names match `/^[a-z0-9][a-z0-9._-]{0,63}$/`. A workspace named `default` is implicit if not declared, backed by `SNIPPY_DB`.

## Selecting a workspace

| Transport | How                                              |
| --------- | ------------------------------------------------ |
| stdio     | `SNIPPY_WORKSPACE=name` env or `--workspace=name` flag |
| HTTP      | `?workspace=name` query parameter on the `/mcp` URL    |

If the HTTP client omits the parameter, the server uses its CLI default (same `--workspace=` resolution as stdio). Unknown workspace → `404 unknown workspace: <name>`.

## URI scheme

Resource URIs always include the workspace name:

```
snippet://{workspace}/{kind}/{id}
# example: snippet://team/snippet/01H8Z…
```

This is a **breaking change** from v0.1, where URIs were `snippet://{kind}/{id}`. See [migration-v1-to-v2](./migration-v1-to-v2.md).

## Backup & restore

`snippy-mcp backup --out path.db` honours `--workspace=` so each workspace can be backed up independently. The same applies to `restore`.

## Operational notes

- DB connections are opened lazily; an unused workspace consumes nothing until first request.
- Each workspace is independently pruned by `SNIPPY_AUDIT_DAYS`.
- Metrics gauges are per-workspace but exposed on a single `/metrics` endpoint at the moment (planned: split per-workspace label).
