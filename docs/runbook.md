# Runbook

## Common operations

### Rotate an HTTP token

1. Edit the `SNIPPY_HTTP_TOKENS` env in your service manager (systemd unit, Docker compose, etc.). Add the new token alongside the old one.
2. `systemctl restart snippy-mcp` / `docker compose restart snippy-mcp`.
3. Roll clients to the new token at their own pace.
4. Edit the env again to drop the old token; restart.

There is no online reload.

### Restore from backup

1. Stop the service: `systemctl stop snippy-mcp`.
2. `snippy-mcp restore --in /backups/snippy-2026-04-13.bak.db` (uses `SNIPPY_DB`).
3. For named workspaces: `snippy-mcp --workspace=team restore --in /backups/team-2026-04-13.bak.db`.
4. Start the service.

`restore` deletes `-wal` / `-shm` siblings before swapping in the backup file, so WAL replay can't resurrect post-backup writes.

### Take a live backup (no downtime)

```bash
snippy-mcp backup --out /backups/snippy-$(date -I).bak.db
```

Internally uses SQLite's `VACUUM INTO`, which is safe under concurrent writers.

### Inspect the audit log

```bash
snippy-mcp audit tail 200
snippy-mcp --workspace=team audit tail 200
```

### Find the most-called tool

```bash
curl -s http://localhost:7878/metrics | grep snippy_tool_calls_total
```

### Scale audit retention

```bash
SNIPPY_AUDIT_DAYS=30 systemctl restart snippy-mcp   # prune anything >30d on next start
SNIPPY_AUDIT_DAYS=0 systemctl restart snippy-mcp    # disable pruning entirely
```

## Diagnostics

| Symptom                                     | Where to look                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `/readyz` 503                               | DB file permissions, disk full, schema migration failure                       |
| Tools missing from `listTools`              | The session's role doesn't have access; check `SNIPPY_HTTP_TOKENS` mapping     |
| `snippy.legacyCursor` errors after upgrade  | A v1 client cached an old offset cursor — clients must restart their search   |
| Slow searches                               | `snippy_tool_call_duration_seconds_bucket{tool="artifact.search"}` — investigate dataset growth or run `bun run bench` to compare to baseline |
| `snippy.cancelled`                          | Client aborted; safe to ignore (export/import/materializeMany honour AbortSignal) |
| Stale aliases after a rename                | `artifact.history` shows the rename event in `audit_log`; aliases auto-cascade only on artifact delete, not rename — use `artifact.rename` to clear |

## Upgrade

1. Check `docs/migration-v1-to-v2.md` for breaking changes.
2. Take a backup before upgrading.
3. Restart with the new binary; migrations run automatically on startup.
4. If a migration fails, the binary refuses to serve — the partial transaction is rolled back. Roll back to the previous binary while you investigate.
