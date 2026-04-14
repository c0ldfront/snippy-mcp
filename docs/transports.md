# Transports

snippy-mcp ships with two transports. Pick one with a CLI flag.

## stdio (default)

```bash
snippy-mcp           # equivalent to: snippy-mcp --stdio
```

The parent process owns the lifetime; SIGINT/SIGTERM trigger graceful close. Stdio is **always trusted**: the entire connection runs as `actor=stdio` with `role=admin`, no bearer tokens, no origin checks. This matches the MCP convention for IDE-spawned agents.

Pick a workspace:

```bash
SNIPPY_WORKSPACES='{"team":"/srv/team.db","personal":"/srv/personal.db"}' \
SNIPPY_WORKSPACE=team \
  snippy-mcp
# or per-invocation:
snippy-mcp --workspace=personal
```

## Streamable HTTP

```bash
snippy-mcp --http
# listens on http://127.0.0.1:7878 by default
```

| Path        | Method | Notes                                                     |
| ----------- | ------ | --------------------------------------------------------- |
| `/mcp`      | POST/GET/DELETE | The MCP JSON-RPC endpoint. SSE per-session.      |
| `/healthz`  | GET    | Always 200. Use for liveness probes.                       |
| `/readyz`   | GET    | 200 when SQLite responds; 503 otherwise. Liveness ≠ readiness. |
| `/metrics`  | GET    | Prometheus text v0.0.4. 404 if metrics weren't wired.      |

### Sessions

The transport uses the SDK's `WebStandardStreamableHTTPServerTransport`. Each session owns:

- A `WebStandardStreamableHTTPServerTransport` instance (with a `sessionIdGenerator: () => crypto.randomUUID()`).
- A fresh `McpServer` built by `buildServer`, scoped to the resolved role and workspace.

The server keeps a `Map<sessionId, Session>`. POSTs without `Mcp-Session-Id` are treated as initialize requests; subsequent POSTs/SSE GETs/DELETEs route by header.

### Multi-workspace routing

Set `SNIPPY_WORKSPACES='{"a":"/srv/a.db","b":"/srv/b.db"}'`. Clients pick a workspace at session-init time:

```
POST /mcp?workspace=a HTTP/1.1
Authorization: Bearer <token>
…
```

Unknown workspace → 404. The default workspace (resolved from `SNIPPY_WORKSPACE` or the literal `default`) is used when the query parameter is absent.

### Origin allowlist

```bash
SNIPPY_ORIGIN_ALLOWLIST='https://app.example,https://other.example' snippy-mcp --http
```

Unset = accept everything (suitable only when binding to localhost). Set = strict allowlist; mismatched `Origin` → 403.

### Switching transports

`buildServer` returns a plain `McpServer`. Adding a third transport (e.g. WebSocket) requires only wiring it up to call `server.connect(transport)` — no changes to the tool/prompt/resource code.
