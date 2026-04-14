# Tool reference

All tools are namespaced `artifact.*`. Every tool returns both `content` (a JSON-text block) and `structuredContent` (the same payload as a structured object).

| Tool                       | Required role | Destructive | Idempotent | Summary |
| -------------------------- | ------------- | ----------- | ---------- | ------- |
| `artifact.get`              | reader        | no          | yes        | Fetch by id. |
| `artifact.getByName`        | reader        | no          | yes        | Fetch by `(kind, name)`; resolves aliases. |
| `artifact.list`             | reader        | no          | yes        | Newest-first paged list with kind/language/tag filters. `summary: true` (default) omits content/variables. |
| `artifact.search`           | reader        | no          | yes        | FTS5 search; query-bound keyset cursor. |
| `artifact.history`          | reader        | no          | yes        | Revision history newest-first. `summary: true` (default) omits content/variables. |
| `artifact.render`           | reader        | no          | yes        | Substitute `${var}` placeholders by id. |
| `artifact.renderByName`     | reader        | no          | yes        | Substitute `${var}` placeholders by name. |
| `artifact.export`           | reader        | no          | yes        | NDJSON export with optional `_revisions`. |
| `artifact.push`             | writer        | no          | yes        | Upsert by `(kind, name)`. |
| `artifact.tag`              | writer        | no          | yes        | Add tags. |
| `artifact.untag`            | writer        | no          | yes        | Remove tags. |
| `artifact.rename`           | writer        | no          | no         | Rename + alias the old name. |
| `artifact.delete`           | admin         | yes         | yes        | Cascades tags, aliases, revisions. |
| `artifact.rollback`         | admin         | yes         | no         | Replay a prior revision as a new revision. |
| `artifact.import`           | admin         | yes         | no         | Bulk NDJSON import; conflict policy. |
| `artifact.materialize`      | admin         | yes         | no         | Render and write to a roots-gated path. |
| `artifact.materializeMany`  | admin         | yes         | no         | Bulk write into a roots-gated directory. |

## Conventions

- **`summary` flag** on `list` / `search` / `history`: default `true`. Omits the heavy `content` and `variables` payloads while keeping `contentBytes` and `variableCount` so callers can decide whether to fetch the full body.
- **Cursors** are opaque base64url-encoded JSON. Don't inspect or mutate them — they're versioned and self-validating; tampered cursors produce typed errors (`snippy.malformedCursor` / `snippy.legacyCursor`).
- **Errors** carry a `data.snippyCode` for stable programmatic dispatch. See the README's "Error Codes" table.
- **Progress** notifications fire on bulk ops (`export`, `import`, `materializeMany`) when the caller passes a `progressToken` in `_meta`.
- **Cancellation** via `AbortSignal` is honoured between iterations on the same bulk ops.
