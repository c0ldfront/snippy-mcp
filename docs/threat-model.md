# Threat model

## Trust boundaries

| Surface                | Trust                                            |
| ---------------------- | ------------------------------------------------ |
| Stdio transport        | Trusted: parent process owns the connection.     |
| HTTP transport         | Untrusted by default; requires bearer token.     |
| SQLite file            | Trusted: assumed to be on a private filesystem.  |
| Filesystem (`materialize`) | Restricted to client-advertised roots / `SNIPPY_ROOTS`. |

## Threats and mitigations

| Threat                                                | Mitigation                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Path traversal in `materialize`                        | `ensurePathAllowed` resolves `..` first, then matches the resolved absolute path against the allowed-roots prefix list. Property tests cover ≥100 random escape attempts. |
| SQL injection                                          | All queries use prepared statements with named bindings. Repo functions never interpolate user input into SQL strings; LIKE patterns escape `%`/`_`/`\`. |
| FTS query injection                                    | FTS5 query goes through bun:sqlite's parameter binding; we never concatenate it into MATCH. Empty queries short-circuit. |
| Cross-tenant resource leak                             | Workspaces own their own DB connection, repo, audit, metrics. URIs include workspace; `getById` is per-workspace. |
| Bearer token leak via logs                             | Audit log records actor as `http:<role>` (no token), never the token itself. Args are captured but tokens never appear in args. |
| Privilege escalation through tool listing              | Each session's McpServer literally does not register tools the role can't call. `listTools` reflects this; there is no fallback path that re-checks at call time. |
| Origin spoofing on HTTP                                | `SNIPPY_ORIGIN_ALLOWLIST` enforces strict allowlist. CORS preflight is not added; the server is JSON-only and rejects mismatched origins outright. |
| Replay / cross-query cursor reuse                       | Search cursors are bound to the originating `query` string and rejected if the next request's query differs. |
| Cursor tamper → information disclosure                  | Cursor schema validates strictly; an old offset cursor or a randomly mutated payload throws a typed `snippy.legacyCursor` / `snippy.malformedCursor` rather than coercing. |
| Race on overwrite                                      | `materialize` checks existence and writes via `Bun.write` after `mkdir -p`. Elicitation surfaces overwrite to the user when supported. |
| Audit-log volume DoS                                   | `SNIPPY_AUDIT_DAYS` (default 90) prunes; insert is best-effort and never blocks the primary op. |
| Render template injection                              | Render only substitutes declared (or bound) `${var}` placeholders; literal `${...}` content is left intact. |
| Aliased name silent-overwrite                           | `push` matches on live names only; pushing a name that resolves through an alias throws `snippy.aliasConflict`. |

## Out of scope

- Defending the SQLite file from local attackers (use filesystem ACLs).
- Encrypting tokens at rest in `SNIPPY_HTTP_TOKENS` (env-only; rotate via process restart).
- mTLS / TLS termination — run behind a reverse proxy.
