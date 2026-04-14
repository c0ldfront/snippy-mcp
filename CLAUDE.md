# CLAUDE.md — snippy-mcp working agreement

Project guidance for Claude Code working in this repo. Composed via the
`crimson` prompt registry (chain at the bottom). Read this end-to-end before
making non-trivial changes.

## What this repo is

`snippy-mcp` is a Model Context Protocol server (latest
`@modelcontextprotocol/sdk`, currently 1.29) backed by `bun:sqlite`,
shipped at v0.2.0. Single binary, two transports (stdio + Streamable
HTTP), multi-workspace storage, RBAC, audit log, Prometheus metrics,
hand-rolled SBOM/release pipeline.

## Canonical files

Read these before touching anything significant — they are the source of
truth for the patterns the rest of this document encodes.

| File / directory | What lives there |
| --- | --- |
| `README.md` | install, env vars, MCP surface, design notes, error-code table |
| `CHANGELOG.md` | what landed in each release; read 0.2.0 entries before non-trivial work |
| `docs/` | `architecture.md`, `transports.md`, `auth.md`, `workspaces.md`, `threat-model.md`, `runbook.md`, `benchmarks.md`, `tool-reference.md`, `migration-v1-to-v2.md` |
| `src/cli.ts` | single entry point; subcommands `--stdio` (default), `--http`, `audit tail`, `backup`, `restore`, `generate <format>` |
| `src/mcp/` | server, tools, resources, prompts, plus cross-cutting modules `errors.ts`, `auth.ts`, `audit.ts`, `metrics.ts`, `completers.ts` |
| `src/repo/artifact-repo.ts` | **all** SQL lives here; `cursor.ts` owns opaque base64url cursors |
| `src/db/migrations.ts` | ordered migration array — never edit an applied migration in place |
| `src/workspace.ts` | multi-DB registry; per-workspace `repo`/`audit`/`metrics` |
| `src/transport/http.ts` | `Bun.serve` + `WebStandardStreamableHTTPServerTransport`; per-session McpServer |
| `bench/all.bench.ts` + `bench/baseline.json` | regression guard (≥20% p50 or ≥50% p95 fails CI; see docs/benchmarks.md for why the split) |
| `forge.ts` | release pipeline (`build`, `package`, `sbom`, `source`, `release`) |
| `.github/workflows/{ci,release}.yml` | CI matrix on bun-latest + canary; release fires on `v*` tags |

Storage schema (read `src/db/migrations.ts` for the truth):

```text
artifacts            UNIQUE(kind, name)
tags                 PRIMARY KEY(artifact_id, tag)              FK→artifacts
aliases              PRIMARY KEY(kind, alias)                   FK→artifacts
artifact_revisions   UNIQUE(artifact_id, version)               FK→artifacts
audit_log            indexed by ts, tool, artifact_id
artifacts_fts        FTS5 contentless, kept in sync via triggers
```

## Bun-first

- **Runtime:** Bun 1.x. `bun <file>` for scripts, `bun test`, `bun build`,
  `bun install`, `bunx`. Never `node`, `npm`, `yarn`, `pnpm`, `npx`,
  `jest`, `vitest`, `webpack`, `esbuild`.
- **APIs:** reach for Bun-native first.
  - File I/O → `Bun.file()`, `Bun.write()` (not `node:fs`).
  - Shell → `Bun.$\`…\`` template literal (not `child_process.exec`; use
    template segments for untrusted input — never string concatenation).
  - Subprocess → `Bun.spawn` (not `child_process.spawn`).
  - SQLite → `bun:sqlite` (not `better-sqlite3`).
  - HTTP server → `Bun.serve` (not Express, not `http.createServer`).
  - WebSocket → built-in `WebSocket` (not `ws`).
  - Hashing → `Bun.CryptoHasher`, `Bun.hash`, `Bun.password`.
  - Env → `Bun.env` for Bun-only code; Bun auto-loads `.env`, no
    `dotenv`.
- **Node compat:** if a library forces it (e.g. `node:path`), use it and
  say so in one line. Don't reach for `node:*` when Bun has a native
  path.

## TypeScript

- `@types/bun` (NOT `bun-types` — see commit `771134e`).
- `strict` mode is on; **no `any`**. Use `unknown` with narrowing,
  generics, or precise types. `as` casts require a one-line comment
  explaining why the compiler can't infer it.
- Explicit return types on every exported function.
- Imports are organized via Biome's `organizeImports` rule — never
  hand-sort.

## MCP patterns

### Error registry

All MCP-surface errors funnel through `src/mcp/errors.ts`:

- Throw `snippyMcpError({ code, message, data })` — never `new
  McpError(...)` directly outside `errors.ts`.
- `code` must be a value from `SNIPPY_ERROR_CODES`
  (`snippy.notFound`, `snippy.aliasConflict`, `snippy.cancelled`, …).
- New domain failures require: (1) a new `SNIPPY_ERROR_CODES` entry;
  (2) a new row in the README "Error Codes" table; (3) coverage in
  `src/mcp/errors.test.ts` if the surface changes.
- Repo-level error classes live in `src/repo/` and are mapped to MCP
  errors by `toMcpError` / `rethrowAsMcp` in `src/mcp/tools.ts` — add a
  branch there when introducing a new repo error.
- `data.snippyCode` is the stable client contract; never break it
  without a major version bump and a migration entry.

### Tool registration

`src/mcp/tools.ts` exposes a local `tool(name, def, handler)` helper
that:

1. Skips registration entirely if the caller's role lacks the required
   `TOOL_REQUIRED_ROLES[name]` permission.
2. Wraps the handler to record an audit row (best-effort) and a metrics
   sample (counter + histogram) on every call, keyed by the resolved
   `snippyCode` or `"ok"`.

Use `tool(...)` for new tools. Don't call `server.registerTool` directly
inside `registerTools` — the wrapper enforces RBAC + audit + metrics
in one place.

### Transports

- `--stdio` (default) is **trusted** — `actor=stdio`, `role=admin`.
- `--http` is **untrusted** — bearer-token gate via `SNIPPY_HTTP_TOKENS`.
  Each session's `McpServer` literally does not register tools the
  caller's role can't invoke (so `listTools` reflects authority).
- HTTP routes: `/mcp` (POST/GET/DELETE), `/healthz`, `/readyz`,
  `/metrics`. Origin allowlist via `SNIPPY_ORIGIN_ALLOWLIST` (CSV).
- Buildtime: `buildServer({ repo, role, actor, audit, metrics, db,
  workspace })` returns a plain `McpServer` — adding a new transport is
  one wiring change, not a refactor.

### Workspaces

- Resource URIs are always `snippet://{workspace}/{kind}/{id}`. There
  is no v0.1 fallback shape.
- Multi-DB hosting via `SNIPPY_WORKSPACES` (JSON map). Each workspace
  owns its own `ArtifactRepo`, `AuditWriter`, and `SnippyMetrics`
  registry.
- Workspace selection: `--workspace=name` flag, `SNIPPY_WORKSPACE` env
  (stdio), or `?workspace=name` query (HTTP).

## Tests

- **Colocated unit tests:** every `src/foo.ts` ships a sibling
  `src/foo.test.ts` in the same commit.
- **End-to-end:** `tests/e2e.test.ts` spawns the actual CLI binary over
  stdio. Use it for protocol-shape assertions and full-binary
  integration.
- **Property tests:** `src/security.test.ts` for security-critical
  invariants (path normalization, regex edges, cursor tampering). Uses
  an inline LCG generator — no `fast-check` dependency.
- **Benchmarks:** `bench/all.bench.ts`, invoked via `bun run bench`
  (not part of `bun test`). Re-baseline with `bun run bench:baseline`.
- **Runner:** `bun:test` only. `import { test, expect, describe,
  beforeEach } from "bun:test"`.
- **Mocks:** prefer `openMemoryDb()` over a mocked SQLite — we want
  real SQL bugs to surface in tests.
- **Coverage expectation:** new function-level files ship with
  happy-path coverage **and** at least one edge case in the same
  commit.

```ts
// src/feature.test.ts
import { describe, expect, test } from "bun:test";
import { feature } from "./feature.ts";

describe("feature", () => {
  test("happy path", () => {
    expect(feature("ok")).toBe("OK");
  });
  test("rejects empty input", () => {
    expect(() => feature("")).toThrow();
  });
});
```

## Migrations

- Schema changes go through `src/db/migrations.ts` as a new entry in
  the ordered array.
- **Never edit an applied migration in place** — old DBs already ran
  it; a stealth edit silently desyncs them.
- Update `src/db/connection.test.ts` `appliedMigrationIds` expectations
  to include the new id.
- A migration that fails rolls back the partial transaction; the binary
  refuses to serve until a future fix lands.

## SOLID / DRY

Concrete rules, not slogans:

- One file = one reason to change. Three repetitions = extract; two is
  fine.
- Extension via registries (`SNIPPY_ERROR_CODES`,
  `TOOL_REQUIRED_ROLES`, the migration array, the forge `SUBCOMMANDS`
  list) — adding a new error / role / migration / subcommand should
  not require touching dispatch code.
- Narrow, role-shaped interfaces. Depend on interfaces; inject
  implementations (e.g. `ToolDeps` interface, repo passed in).
- Prefer composition over inheritance and slight duplication over
  tight coupling between unrelated modules.
- Don't prematurely abstract — a helper used once is dead weight.

## Biome

- `bunx biome check --write` is the only formatter/linter gate. No
  ESLint, no Prettier.
- Fix Biome violations rather than silencing them. `// biome-ignore
  lint/<rule>: <one-line reason>` only when the rule is provably wrong
  for the case (see `bench/all.bench.ts` for the literal-`${var}`
  example).
- `biome.json` in the repo root is the config; do not override
  per-directory.

## Reviewer gate

Every non-trivial design choice — schema shape, public API surface,
dependency picks, module boundaries, naming conventions, file layout,
transport wiring — is reviewed by a third-party AI reviewer (use the
`architect-reviewer` subagent) before code lands.

Procedure:

1. State the decision in one paragraph: alternatives + the one
   proposed.
2. Spawn a reviewer with that paragraph + relevant code context.
3. Treat reviewer output as **blocking**. Watch for: side-stepping
   (different problem), mis-design (wrong layer / ownership),
   over-design (generalizing past requirements), over-engineering
   (abstractions with no current consumer).
4. Revise until the reviewer clears it. If you disagree, write a
   one-paragraph rebuttal and re-submit — never silently ignore.

Skip the gate only for mechanical changes (renames, trivial bug fixes,
test additions).

## Commit discipline

- A feature is "done" only when **all three are green**: `bunx biome
  check`, `bunx tsc --noEmit`, `bun test`. Then commit, then start the
  next feature.
- One commit per feature. Don't bundle. Don't commit WIP.
- Conventional Commit subjects, imperative, ≤72 chars: `feat:`,
  `fix:`, `refactor:`, `test:`, `chore:`, `docs:`, `build:`, `ci:`.
- Body explains *why*, not *what* — the diff already shows *what*.
- Stage specific files (`git add path/to/file`), never `git add -A` or
  `git add .`.
- Never `--amend` published commits, never `--no-verify`, never
  `--no-gpg-sign`.
- Co-Authored-By trailer: every Claude-authored commit ends with
  `Co-Authored-By: Claude Opus 4.6 (1M context)
  <noreply@anthropic.com>` (heredoc the body).

## Documentation accuracy

- Every command, file path, env var, and CLI flag in any `*.md` is
  copied from the source — not paraphrased.
- Defaults match the code; if the default changes in code, the doc is
  wrong.
- Behavior claims must be backed by a test or a clearly-pointed code
  path.
- Versions (Bun, Biome, TypeScript, SDK, model IDs) are read from
  `package.json` / lockfile, not guessed.
- New env vars / flags / tools require a same-commit update to
  README + relevant `docs/` page.
- Don't document aspirational features in the main docs — put them in
  a "Roadmap" or "Known Gaps" section.

## Enterprise-grade bar (concrete, not vibes)

| Pillar | What "done" looks like in this repo |
| --- | --- |
| Observability | Audit row + MCP logging notification on mutations; metric (counter + histogram) on every tool call |
| Auth | HTTP bearer-gated with reader/writer/admin RBAC; stdio trusted |
| Durability | Versioned migrations; `snippy-mcp backup` (online VACUUM INTO) + tested `restore` |
| Reproducibility | Deterministic builds; SHA256SUMS.txt + CycloneDX SBOM attached to GitHub releases; signed tags |
| Failure modes | Every exception path uses a typed `McpError` with a stable `snippyCode`. Audit writes are best-effort. |
| Performance | `bench/baseline.json` is the regression contract; >20% p50 or >50% p95 regression fails CI. Baseline lives in the GH Actions runner environment — re-baseline from a green CI run, not a local laptop. |
| Security | Paths normalized before checks; zod at every boundary; `Bun.$` template segments for shell |
| Docs | README + `docs/` answer "how do I rotate a token?", "how do I restore from backup?", "what's the threat model?" |
| CI | Lint + typecheck + unit + e2e + bench-regression on every PR; main never red |
| Release hygiene | Conventional commits; semver; signed tags; release artifacts attached with verifiable manifest |

**Anything without a test, a metric, or a doc entry is not done.**

## Output shape (when generating code in chat)

1. ≤1 line of context. No "Here is…" / "Certainly!".
2. One fenced TypeScript block per file, first line a `// path/to/file.ts` comment.
3. Sibling `*.test.ts` for every function-level file (`bun:test`).
4. End with one run command (e.g. `bun test` or `bun run path/to/file.ts`).
5. No closing recap.

## Voice

- No pleasantries, apologies, or "I hope this helps".
- No recap of what was just written.
- No hedging unless genuinely uncertain — then state the uncertainty
  in one line.
- Ambiguous requirement → ask one pointed question, don't guess across
  interpretations.

## Frontend (when applicable)

This repo doesn't ship a frontend today, but if one is added: HTML
imports with `Bun.serve()`, no `vite`. HTML files import `.tsx`/`.jsx`
directly; CSS via `<link>`. See the Bun docs in
`node_modules/bun-types/docs/**.mdx` (or `@types/bun` equivalents).

---

## Prompt provenance

This document is composed via the `crimson` MCP prompt registry. Chain:

1. `role-bun-runtime-engineer`
2. `role-mcp-protocol-expert`
3. `context-snippy-mcp-repo` *(this repo)*
4. `constraint-bun-native-apis`
5. `constraint-snippy-error-registry` *(this repo)*
6. `constraint-snippy-test-conventions` *(this repo)*
7. `constraint-solid-dry`
8. `constraint-biome-lint-format`
9. `constraint-third-party-review-gate`
10. `constraint-commit-per-feature`
11. `constraint-doc-accuracy`
12. `constraint-enterprise-grade-bar`
13. `format-bun-paste-ready`
14. `tone-terse-engineering`

Re-compose with the `crimson` MCP server (`compose-prompt` tool) when
patterns drift.
