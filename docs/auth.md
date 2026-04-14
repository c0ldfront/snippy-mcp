# Auth & RBAC

## Stdio

Stdio transport is **trusted**. Whoever spawned the process is admin. There is no way to disable that.

## HTTP

Bearer-token gate, set with `SNIPPY_HTTP_TOKENS`:

```bash
SNIPPY_HTTP_TOKENS='alice:admin,bob:writer,carol:reader' snippy-mcp --http
```

Each comma-separated entry is `token:role`. The token can contain colons (we split on the *last* one). Roles are `reader | writer | admin`.

When the env var is unset, every request is granted `admin` (logged loudly at startup) — fine for a local-only deployment, never appropriate on a shared host.

### Roles

| Role     | Tools available                                                                 |
| -------- | ------------------------------------------------------------------------------- |
| `reader` | get, getByName, list, search, history, render, renderByName, export             |
| `writer` | reader + push, tag, untag, rename                                               |
| `admin`  | writer + delete, rollback, import, materialize, materializeMany                 |

The role-tool mapping lives in `src/mcp/auth.ts:TOOL_REQUIRED_ROLES`. The McpServer for an under-privileged session **never registers** the disallowed tools, so `listTools` reflects the caller's actual surface.

### Wire format

```
POST /mcp HTTP/1.1
Authorization: Bearer alice
Content-Type: application/json
…
```

A missing or unrecognized token → `401` with `WWW-Authenticate: Bearer realm="snippy-mcp"`.

### Rotating a token

1. Add the new token to `SNIPPY_HTTP_TOKENS` alongside the old one (both honored).
2. Roll clients to the new token.
3. Drop the old token and restart `snippy-mcp`.

There is no online token reload; restart is required.
