import { dirname, join } from "node:path";
import { completable, isCompletable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Artifact, Kind } from "../domain/artifact.ts";
import { PushInputSchema } from "../domain/artifact.ts";
import type { ArtifactRepo, PageResult, PushResult } from "../repo/artifact-repo.ts";
import {
	AliasConflictError,
	ArtifactNotFoundError,
	NameTakenError,
	RevisionMissingError,
	SearchCursorQueryMismatchError,
	TooManyAliasesError,
} from "../repo/artifact-repo.ts";
import { LegacySearchCursorError, MalformedCursorError } from "../repo/cursor.ts";
import { RenderError, render } from "../services/render.ts";
import { discoverAllowedRoots, ensurePathAllowed } from "../services/roots.ts";
import { roleAllows, TOOL_REQUIRED_ROLES } from "./auth.ts";
import { buildCompleters } from "./completers.ts";
import type { ToolDeps } from "./deps.ts";
import { SNIPPY_ERROR_CODES, snippyMcpError } from "./errors.ts";
import {
	DeleteInputShape,
	DeleteOutputShape,
	ExportInputShape,
	ExportOutputShape,
	GetByNameInputShape,
	GetInputShape,
	GetOutputShape,
	HistoryInputShape,
	HistoryOutputShape,
	ImportInputShape,
	ImportOutputShape,
	ListInputShape,
	MaterializeInputShape,
	MaterializeManyInputShape,
	MaterializeManyOutputShape,
	MaterializeOutputShape,
	PageOutputShape,
	PushInputShape,
	PushOutputShape,
	RenameInputShape,
	RenameOutputShape,
	RenderByNameInputShape,
	RenderInputShape,
	RenderOutputShape,
	RollbackInputShape,
	RollbackOutputShape,
	SearchInputShape,
	TagInputShape,
	TagOutputShape,
} from "./schemas.ts";

function jsonContent(value: unknown): { type: "text"; text: string }[] {
	return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

interface ArtifactListItem {
	id: string;
	kind: Kind;
	name: string;
	language: string | null;
	description: string;
	tags: string[];
	aliases: string[];
	createdAt: number;
	updatedAt: number;
	contentBytes: number;
	variableCount: number;
	content?: string;
	variables?: Artifact["variables"];
}

const utf8Encoder = new TextEncoder();
function utf8ByteLength(s: string): number {
	return utf8Encoder.encode(s).byteLength;
}

function toListItem(a: Artifact, summary: boolean): ArtifactListItem {
	const item: ArtifactListItem = {
		id: a.id,
		kind: a.kind,
		name: a.name,
		language: a.language,
		description: a.description,
		tags: a.tags,
		aliases: a.aliases,
		createdAt: a.createdAt,
		updatedAt: a.updatedAt,
		contentBytes: utf8ByteLength(a.content),
		variableCount: a.variables.length,
	};
	if (!summary) {
		item.content = a.content;
		item.variables = a.variables;
	}
	return item;
}

function serializePage(
	page: PageResult,
	summary: boolean,
): {
	artifacts: ArtifactListItem[];
	nextCursor: string | null;
	summary: boolean;
} {
	return {
		artifacts: page.artifacts.map((a) => toListItem(a, summary)),
		nextCursor: page.nextCursor,
		summary,
	};
}

function serializePush(result: PushResult): {
	artifact: Artifact;
	existed: boolean;
	previousUpdatedAt: number | null;
	dryRun: boolean;
} {
	return {
		artifact: result.artifact,
		existed: result.existed,
		previousUpdatedAt: result.previousUpdatedAt,
		dryRun: result.dryRun,
	};
}

function toMcpError(err: unknown): McpError | null {
	if (err instanceof ArtifactNotFoundError) {
		return snippyMcpError({
			code: SNIPPY_ERROR_CODES.NotFound,
			message: err.message,
			data: { id: err.id },
		});
	}
	if (err instanceof NameTakenError) {
		return snippyMcpError({
			code: SNIPPY_ERROR_CODES.NameConflict,
			message: err.message,
			data: { kind: err.kind, name: err.takenName },
		});
	}
	if (err instanceof AliasConflictError) {
		return snippyMcpError({
			code: SNIPPY_ERROR_CODES.AliasConflict,
			message: err.message,
			data: { kind: err.kind, alias: err.alias, holderId: err.holderId },
		});
	}
	if (err instanceof TooManyAliasesError) {
		return snippyMcpError({
			code: SNIPPY_ERROR_CODES.TooManyAliases,
			message: err.message,
			data: { id: err.id },
		});
	}
	if (err instanceof RevisionMissingError) {
		return snippyMcpError({
			code: SNIPPY_ERROR_CODES.RevisionMissing,
			message: err.message,
			data: { artifactId: err.artifactId, version: err.version },
		});
	}
	if (err instanceof LegacySearchCursorError) {
		return snippyMcpError({ code: SNIPPY_ERROR_CODES.LegacyCursor, message: err.message });
	}
	if (err instanceof MalformedCursorError) {
		return snippyMcpError({
			code: SNIPPY_ERROR_CODES.MalformedCursor,
			message: err.message,
			data: { kind: err.kind },
		});
	}
	if (err instanceof SearchCursorQueryMismatchError) {
		return snippyMcpError({
			code: SNIPPY_ERROR_CODES.SearchCursorQueryMismatch,
			message: err.message,
			data: { cursorQuery: err.cursorQuery, currentQuery: err.currentQuery },
		});
	}
	if (err instanceof RenderError) {
		return snippyMcpError({
			code: SNIPPY_ERROR_CODES.RenderMissingBindings,
			message: err.message,
			data: { missing: err.missing },
		});
	}
	return null;
}

function rethrowAsMcp(err: unknown): never {
	const m = toMcpError(err);
	throw m ?? err;
}

function requireArtifact(repo: ArtifactRepo, id: string): Artifact {
	const a = repo.getById(id);
	if (a === null) {
		throw snippyMcpError({
			code: SNIPPY_ERROR_CODES.NotFound,
			message: `Artifact not found: id=${id}`,
			data: { id },
		});
	}
	return a;
}

function requireArtifactByName(repo: ArtifactRepo, kind: Kind, name: string): Artifact {
	const a = repo.getByName(kind, name);
	if (a === null) {
		throw snippyMcpError({
			code: SNIPPY_ERROR_CODES.NotFound,
			message: `Artifact not found: ${kind}/${name}`,
			data: { kind, name },
		});
	}
	return a;
}

function log(server: McpServer, level: "info" | "warning", message: string, data?: unknown): void {
	server
		.sendLoggingMessage({
			level,
			logger: "snippy-mcp",
			data: data === undefined ? { message } : { message, ...(data as object) },
		})
		.catch(() => undefined);
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
	const { repo, role, actor, audit, metrics, db } = deps;
	const completers = db !== undefined ? buildCompleters(db) : null;

	// biome-ignore lint/suspicious/noExplicitAny: zod schema shapes are intentionally opaque here.
	const safeWrap = (schema: any, completer: (...args: any[]) => unknown): any => {
		if (isCompletable(schema)) return schema;
		return completable(schema, completer as never);
	};

	const wrapInputSchemaCompleters = (shape: Record<string, unknown>): Record<string, unknown> => {
		if (completers === null) return shape;
		const out: Record<string, unknown> = { ...shape };
		if ("id" in out) out.id = safeWrap(out.id, completers.completeId);
		if ("name" in out) {
			out.name = safeWrap(
				out.name,
				(prefix: string, ctx?: { arguments?: Record<string, string> }) =>
					completers.completeArtifactName(prefix, ctx),
			);
		}
		return out;
	};

	const allowed = (name: string): boolean => {
		const required = TOOL_REQUIRED_ROLES[name];
		return required === undefined || roleAllows(role, required);
	};

	const recordAudit = (tool: string, args: unknown, code: string): void => {
		if (audit === undefined) return;
		audit.record({ actor, tool, args, resultCode: code });
	};

	// biome-ignore lint/suspicious/noExplicitAny: forwarding SDK overload generics through a single wrapper requires opaque types.
	const tool = (name: string, def: any, handler: (args: any, extra: any) => any): void => {
		if (!allowed(name)) return;
		if (def?.inputSchema !== undefined && completers !== null) {
			def = { ...def, inputSchema: wrapInputSchemaCompleters(def.inputSchema) };
		}
		const wrapped = async (args: unknown, extra: unknown): Promise<unknown> => {
			const startNs = performance.now();
			let code = "ok";
			try {
				const res = await handler(args, extra);
				return res;
			} catch (err) {
				const data =
					err instanceof McpError ? (err.data as Record<string, unknown> | undefined) : undefined;
				code = typeof data?.snippyCode === "string" ? data.snippyCode : "error";
				throw err;
			} finally {
				recordAudit(name, args, code);
				if (metrics !== undefined) {
					const elapsedSeconds = (performance.now() - startNs) / 1000;
					metrics.recordToolCall(name, code, elapsedSeconds);
				}
			}
		};
		// biome-ignore lint/suspicious/noExplicitAny: see above — SDK overloads aren't transparent through a generic wrapper.
		(server.registerTool as any)(name, def, wrapped);
	};

	tool(
		"artifact.push",
		{
			title: "Push artifact",
			description:
				"Create or update an artifact (standard, snippet, or resource) identified by (kind, name). Returns the saved artifact plus clobber-detection metadata.",
			inputSchema: PushInputShape,
			outputSchema: PushOutputShape,
			annotations: { idempotentHint: true, destructiveHint: false, readOnlyHint: false },
		},
		(args) => {
			try {
				const result = repo.push({
					kind: args.kind,
					name: args.name,
					language: args.language ?? null,
					description: args.description ?? "",
					content: args.content,
					variables: args.variables ?? [],
					tags: args.tags ?? [],
					dryRun: args.dryRun ?? false,
				});
				if (!result.dryRun) {
					log(server, "info", result.existed ? "artifact.updated" : "artifact.created", {
						id: result.artifact.id,
						kind: result.artifact.kind,
						name: result.artifact.name,
					});
				}
				const payload = serializePush(result);
				return { content: jsonContent(payload), structuredContent: payload };
			} catch (err) {
				rethrowAsMcp(err);
			}
		},
	);

	tool(
		"artifact.get",
		{
			title: "Get artifact by id",
			description: "Fetch an artifact by its stable id.",
			inputSchema: GetInputShape,
			outputSchema: GetOutputShape,
			annotations: { readOnlyHint: true },
		},
		(args) => {
			const payload = { artifact: requireArtifact(repo, args.id) };
			return { content: jsonContent(payload), structuredContent: payload };
		},
	);

	tool(
		"artifact.getByName",
		{
			title: "Get artifact by (kind, name)",
			description: "Fetch an artifact by its kind and human-readable name.",
			inputSchema: GetByNameInputShape,
			outputSchema: GetOutputShape,
			annotations: { readOnlyHint: true },
		},
		(args) => {
			const payload = { artifact: requireArtifactByName(repo, args.kind, args.name) };
			return { content: jsonContent(payload), structuredContent: payload };
		},
	);

	tool(
		"artifact.list",
		{
			title: "List artifacts",
			description:
				"List artifacts newest-first with optional kind/language/tag filters and keyset pagination.",
			inputSchema: ListInputShape,
			outputSchema: PageOutputShape,
			annotations: { readOnlyHint: true },
		},
		(args) => {
			const input: {
				kind?: Kind;
				language?: string;
				tags?: string[];
				cursor?: string;
				limit?: number;
			} = {};
			if (args.kind !== undefined) input.kind = args.kind;
			if (args.language !== undefined) input.language = args.language;
			if (args.tags !== undefined) input.tags = args.tags;
			if (args.cursor !== undefined) input.cursor = args.cursor;
			if (args.limit !== undefined) input.limit = args.limit;
			const page = serializePage(repo.list(input), args.summary);
			return { content: jsonContent(page), structuredContent: page };
		},
	);

	tool(
		"artifact.search",
		{
			title: "Search artifacts",
			description:
				"Full-text search over name, description, and content with optional kind/tag filters.",
			inputSchema: SearchInputShape,
			outputSchema: PageOutputShape,
			annotations: { readOnlyHint: true },
		},
		(args) => {
			const input: {
				query: string;
				kind?: Kind;
				tags?: string[];
				cursor?: string;
				limit?: number;
			} = { query: args.query };
			if (args.kind !== undefined) input.kind = args.kind;
			if (args.tags !== undefined) input.tags = args.tags;
			if (args.cursor !== undefined) input.cursor = args.cursor;
			if (args.limit !== undefined) input.limit = args.limit;
			try {
				const page = serializePage(repo.search(input), args.summary);
				return { content: jsonContent(page), structuredContent: page };
			} catch (err) {
				rethrowAsMcp(err);
			}
		},
	);

	tool(
		"artifact.tag",
		{
			title: "Add tags",
			description: "Add tags to an artifact. Returns the full tag list after the operation.",
			inputSchema: TagInputShape,
			outputSchema: TagOutputShape,
			annotations: { idempotentHint: true },
		},
		(args) => {
			requireArtifact(repo, args.id);
			const tags = repo.addTags(args.id, args.tags);
			return { content: jsonContent({ tags }), structuredContent: { tags } };
		},
	);

	tool(
		"artifact.untag",
		{
			title: "Remove tags",
			description:
				"Remove tags from an artifact. Missing tags are ignored. Returns the full tag list after the operation.",
			inputSchema: TagInputShape,
			outputSchema: TagOutputShape,
			annotations: { idempotentHint: true },
		},
		(args) => {
			requireArtifact(repo, args.id);
			const tags = repo.removeTags(args.id, args.tags);
			return { content: jsonContent({ tags }), structuredContent: { tags } };
		},
	);

	tool(
		"artifact.rename",
		{
			title: "Rename artifact",
			description:
				"Rename an artifact. The old name becomes an alias so downstream callers (getByName, prompts, renderByName) keep working. Fails if the new name is already a live name or alias of another artifact of the same kind.",
			inputSchema: RenameInputShape,
			outputSchema: RenameOutputShape,
			annotations: { idempotentHint: false, destructiveHint: false, readOnlyHint: false },
		},
		(args) => {
			try {
				const result = repo.rename(args.id, args.newName);
				if (result.previousName !== result.artifact.name) {
					log(server, "info", "artifact.renamed", {
						id: result.artifact.id,
						kind: result.artifact.kind,
						oldName: result.previousName,
						newName: result.artifact.name,
					});
				}
				const payload = { artifact: result.artifact, previousName: result.previousName };
				return { content: jsonContent(payload), structuredContent: payload };
			} catch (err) {
				rethrowAsMcp(err);
			}
		},
	);

	tool(
		"artifact.history",
		{
			title: "List an artifact's revision history",
			description:
				"Return every stored revision for an artifact (newest first). Each push — including rollbacks — creates a new immutable revision. Default summary mode omits content and variables.",
			inputSchema: HistoryInputShape,
			outputSchema: HistoryOutputShape,
			annotations: { readOnlyHint: true },
		},
		(args) => {
			const artifact = requireArtifact(repo, args.id);
			const revisions = repo.listRevisions(artifact.id);
			const items = revisions.map((r) => {
				const base = {
					id: r.id,
					artifactId: r.artifactId,
					version: r.version,
					createdAt: r.createdAt,
					contentBytes: utf8ByteLength(r.content),
					variableCount: r.variables.length,
				};
				if (args.summary) return base;
				return { ...base, content: r.content, variables: r.variables };
			});
			const payload = { artifactId: artifact.id, revisions: items, summary: args.summary };
			return { content: jsonContent(payload), structuredContent: payload };
		},
	);

	tool(
		"artifact.rollback",
		{
			title: "Rollback artifact to a prior revision",
			description:
				"Replace the artifact's current content with the content from `toVersion`. Creates a new revision rather than rewriting history, so the rollback itself is auditable.",
			inputSchema: RollbackInputShape,
			outputSchema: RollbackOutputShape,
			annotations: { destructiveHint: true, idempotentHint: false },
		},
		(args) => {
			try {
				const result = repo.rollback(args.id, args.toVersion);
				log(server, "warning", "artifact.rolledback", {
					id: result.artifact.id,
					kind: result.artifact.kind,
					name: result.artifact.name,
					toVersion: args.toVersion,
					newVersion: result.newVersion,
				});
				const payload = { artifact: result.artifact, newVersion: result.newVersion };
				return { content: jsonContent(payload), structuredContent: payload };
			} catch (err) {
				rethrowAsMcp(err);
			}
		},
	);

	tool(
		"artifact.delete",
		{
			title: "Delete artifact",
			description: "Remove an artifact by id. Tags are cascaded.",
			inputSchema: DeleteInputShape,
			outputSchema: DeleteOutputShape,
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		(args) => {
			const deleted = repo.delete(args.id);
			if (deleted) log(server, "warning", "artifact.deleted", { id: args.id });
			return {
				content: jsonContent({ deleted }),
				structuredContent: { deleted },
			};
		},
	);

	tool(
		"artifact.export",
		{
			title: "Export artifacts as NDJSON",
			description:
				"Export every artifact (optionally filtered by kind or tags) as one JSON object per line so it can be re-imported into another snippy-mcp instance.",
			inputSchema: ExportInputShape,
			outputSchema: ExportOutputShape,
			annotations: { readOnlyHint: true },
		},
		async (args, extra) => {
			const lines: string[] = [];
			let cursor: string | null = null;
			const progress = makeProgressEmitter(extra);
			do {
				throwIfCancelled(extra);
				const page = repo.list({
					limit: 100,
					...(args.kind !== undefined ? { kind: args.kind } : {}),
					...(args.tags !== undefined ? { tags: args.tags } : {}),
					...(cursor !== null ? { cursor } : {}),
				});
				for (const a of page.artifacts) {
					const base: Record<string, unknown> = {
						kind: a.kind,
						name: a.name,
						language: a.language,
						description: a.description,
						content: a.content,
						variables: a.variables,
						tags: a.tags,
					};
					if (args.includeHistory) {
						base._revisions = repo.listRevisions(a.id).map((r) => ({
							version: r.version,
							content: r.content,
							variables: r.variables,
							createdAt: r.createdAt,
						}));
					}
					lines.push(JSON.stringify(base));
				}
				cursor = page.nextCursor;
				await progress.send(lines.length);
			} while (cursor !== null);
			const payload = { count: lines.length, ndjson: lines.join("\n") };
			return { content: jsonContent(payload), structuredContent: payload };
		},
	);

	tool(
		"artifact.import",
		{
			title: "Import artifacts from NDJSON",
			description:
				"Bulk-load artifacts from an NDJSON document (one JSON object per line). Conflict policy controls behavior when (kind, name) already exists.",
			inputSchema: ImportInputShape,
			outputSchema: ImportOutputShape,
			annotations: { idempotentHint: false, destructiveHint: true },
		},
		async (args, extra) => {
			let imported = 0;
			let skipped = 0;
			let overwritten = 0;
			const errors: { line: number; message: string }[] = [];
			const lines = args.ndjson.split("\n");
			const total = lines.filter((l: string) => l.trim().length > 0).length;
			const progress = makeProgressEmitter(extra, total);
			let processed = 0;
			for (let i = 0; i < lines.length; i++) {
				throwIfCancelled(extra);
				const raw = lines[i]?.trim() ?? "";
				if (raw === "") continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(raw);
				} catch (err) {
					errors.push({
						line: i + 1,
						message: err instanceof Error ? err.message : "invalid JSON",
					});
					continue;
				}
				const revisionPayload =
					args.includeHistory &&
					parsed !== null &&
					typeof parsed === "object" &&
					"_revisions" in parsed
						? extractRevisions((parsed as { _revisions: unknown })._revisions)
						: null;
				const input = PushInputSchema.safeParse(parsed);
				if (!input.success) {
					errors.push({ line: i + 1, message: input.error.message });
					continue;
				}
				const existing = repo.getByLiveName(input.data.kind, input.data.name);
				const holder =
					existing === null ? repo.findAliasHolder(input.data.kind, input.data.name) : null;
				const nameInUse = existing !== null || holder !== null;
				if (nameInUse) {
					if (args.conflict === "skip") {
						skipped++;
						continue;
					}
					if (args.conflict === "error") {
						errors.push({
							line: i + 1,
							message: `conflict: ${input.data.kind}/${input.data.name} already exists`,
						});
						continue;
					}
				}
				try {
					const result = repo.push(input.data);
					if (revisionPayload !== null) {
						repo.replaceRevisions(result.artifact.id, revisionPayload);
					}
					if (nameInUse) overwritten++;
					else imported++;
				} catch (err) {
					if (err instanceof AliasConflictError) {
						errors.push({ line: i + 1, message: err.message });
						continue;
					}
					throw err;
				}
				processed += 1;
				await progress.send(processed);
			}
			log(server, "info", "artifact.import", { imported, skipped, overwritten });
			const payload = { imported, skipped, overwritten, errors };
			return { content: jsonContent(payload), structuredContent: payload };
		},
	);

	tool(
		"artifact.render",
		{
			title: "Render artifact",
			description:
				"Render an artifact's content by substituting $" +
				"{var} placeholders with provided bindings.",
			inputSchema: RenderInputShape,
			outputSchema: RenderOutputShape,
			annotations: { readOnlyHint: true },
		},
		(args) => {
			const artifact = requireArtifact(repo, args.id);
			const payload = renderToPayload(artifact, args.bindings ?? {});
			return { content: jsonContent(payload), structuredContent: payload };
		},
	);

	tool(
		"artifact.renderByName",
		{
			title: "Render artifact by (kind, name)",
			description:
				"Render an artifact (looked up by kind and name) by substituting $" + "{var} placeholders.",
			inputSchema: RenderByNameInputShape,
			outputSchema: RenderOutputShape,
			annotations: { readOnlyHint: true },
		},
		(args) => {
			const artifact = requireArtifactByName(repo, args.kind, args.name);
			const payload = renderToPayload(artifact, args.bindings ?? {});
			return { content: jsonContent(payload), structuredContent: payload };
		},
	);

	tool(
		"artifact.materialize",
		{
			title: "Materialize artifact to disk",
			description:
				"Render an artifact (by id or kind+name) and write it to a path inside a client-advertised root (or SNIPPY_ROOTS). Returns only path/bytes/sha256 — no file content in the response.",
			inputSchema: MaterializeInputShape,
			outputSchema: MaterializeOutputShape,
			annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args) => {
			const artifact = resolveArtifact(repo, args);
			const result = await materializeOne({
				server,
				artifact,
				path: args.path,
				bindings: args.bindings ?? {},
				conflict: args.conflict,
				chmodX: args.chmodX,
			});
			const payload: Record<string, unknown> = {
				path: result.path,
				bytes: result.bytes,
				sha256: result.sha256,
				written: result.written,
				existed: result.existed,
				rootSource: result.rootSource,
			};
			return { content: jsonContent(payload), structuredContent: payload };
		},
	);

	tool(
		"artifact.materializeMany",
		{
			title: "Materialize many artifacts into a directory",
			description:
				"Write a batch of artifacts (selected by ids, kind, and/or tags) into a directory under a client-advertised root. Per-artifact bindings supported via bindingsByName.",
			inputSchema: MaterializeManyInputShape,
			outputSchema: MaterializeManyOutputShape,
			annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args, extra) => {
			const allowed = await discoverAllowedRoots(server);
			if (allowed.source === "none") {
				throw snippyMcpError({
					code: SNIPPY_ERROR_CODES.NoRootsAdvertised,
					message:
						"No allowed roots advertised. Set SNIPPY_ROOTS or have the client declare roots.",
				});
			}
			const dir = ensurePathAllowed(args.dir, allowed);
			const targets = collectTargets(repo, args);
			const progress = makeProgressEmitter(extra, targets.length);
			let processed = 0;
			const written: {
				id: string;
				name: string;
				path: string;
				bytes: number;
				sha256: string;
			}[] = [];
			const skipped: { id: string; name: string; path: string }[] = [];
			const errors: { id: string; name: string; message: string }[] = [];

			for (const a of targets) {
				throwIfCancelled(extra);
				const filename = artifactFilename(a, args.extension);
				const target = ensurePathAllowed(join(dir, filename), allowed);
				const bindings = args.bindingsByName?.[a.name] ?? {};
				try {
					const result = await writeArtifact({
						artifact: a,
						path: target,
						bindings,
						conflict: args.conflict,
						chmodX: false,
					});
					if (result.written) {
						written.push({
							id: a.id,
							name: a.name,
							path: result.path,
							bytes: result.bytes,
							sha256: result.sha256,
						});
					} else {
						skipped.push({ id: a.id, name: a.name, path: result.path });
					}
				} catch (err) {
					errors.push({
						id: a.id,
						name: a.name,
						message: err instanceof Error ? err.message : "unknown error",
					});
				}
				processed += 1;
				await progress.send(processed);
			}

			log(server, "info", "artifact.materializeMany", {
				written: written.length,
				skipped: skipped.length,
				errors: errors.length,
			});
			const payload: Record<string, unknown> = {
				written,
				skipped,
				errors,
				rootSource: allowed.source,
			};
			return { content: jsonContent(payload), structuredContent: payload };
		},
	);
}

interface ResolveArgs {
	id?: string;
	kind?: Kind;
	name?: string;
}

function resolveArtifact(repo: ArtifactRepo, args: ResolveArgs): Artifact {
	if (args.id !== undefined) return requireArtifact(repo, args.id);
	if (args.kind !== undefined && args.name !== undefined) {
		return requireArtifactByName(repo, args.kind, args.name);
	}
	throw snippyMcpError({
		code: SNIPPY_ERROR_CODES.InvalidBindings,
		message: "Provide either { id } or { kind, name } to identify the artifact.",
	});
}

interface MaterializeOneInput {
	server: McpServer;
	artifact: Artifact;
	path: string;
	bindings: Readonly<Record<string, string>>;
	conflict: "skip" | "overwrite" | "error";
	chmodX: boolean;
}

interface WriteResult {
	path: string;
	bytes: number;
	sha256: string;
	written: boolean;
	existed: boolean;
}

async function materializeOne(
	input: MaterializeOneInput,
): Promise<WriteResult & { rootSource: "client" | "env" }> {
	const allowed = await discoverAllowedRoots(input.server);
	if (allowed.source === "none") {
		throw snippyMcpError({
			code: SNIPPY_ERROR_CODES.NoRootsAdvertised,
			message: "No allowed roots advertised. Set SNIPPY_ROOTS or have the client declare roots.",
		});
	}
	const target = ensurePathAllowed(input.path, allowed);
	let effectiveConflict = input.conflict;
	if (effectiveConflict === "error") {
		const file = Bun.file(target);
		if (await file.exists()) {
			const confirmed = await elicitOverwrite(input.server, target);
			if (confirmed === true) {
				effectiveConflict = "overwrite";
			} else if (confirmed === false) {
				throw snippyMcpError({
					code: SNIPPY_ERROR_CODES.OverwriteRefused,
					message: `Refusing to overwrite existing file: ${target}`,
					data: { path: target, reason: "user_declined" },
				});
			}
		}
	}
	try {
		const result = await writeArtifact({
			artifact: input.artifact,
			path: target,
			bindings: input.bindings,
			conflict: effectiveConflict,
			chmodX: input.chmodX,
		});
		log(input.server, "info", "artifact.materialize", {
			id: input.artifact.id,
			path: result.path,
			written: result.written,
		});
		return { ...result, rootSource: allowed.source };
	} catch (err) {
		if (err instanceof RenderError) {
			throw snippyMcpError({
				code: SNIPPY_ERROR_CODES.RenderMissingBindings,
				message: err.message,
				data: { missing: err.missing },
			});
		}
		if (err instanceof Error && err.message.startsWith("Refusing to overwrite")) {
			throw snippyMcpError({
				code: SNIPPY_ERROR_CODES.OverwriteRefused,
				message: err.message,
				data: { path: target },
			});
		}
		throw err;
	}
}

async function elicitOverwrite(server: McpServer, path: string): Promise<boolean | null> {
	const caps = server.server.getClientCapabilities();
	if (caps?.elicitation === undefined) return null;
	try {
		const res = await server.server.elicitInput({
			message: `${path} already exists. Overwrite?`,
			requestedSchema: {
				type: "object",
				properties: {
					confirm: {
						type: "boolean",
						title: "Overwrite the existing file?",
						description: "Confirm to clobber the file with the freshly materialized artifact.",
					},
				},
				required: ["confirm"],
			},
		});
		if (res.action !== "accept") return false;
		const value = (res.content as { confirm?: unknown } | undefined)?.confirm;
		return value === true;
	} catch {
		// Elicitation failed; fall back to the original error.
		return null;
	}
}

interface WriteArtifactInput {
	artifact: Artifact;
	path: string;
	bindings: Readonly<Record<string, string>>;
	conflict: "skip" | "overwrite" | "error";
	chmodX: boolean;
}

async function writeArtifact(input: WriteArtifactInput): Promise<WriteResult> {
	const content = render({
		content: input.artifact.content,
		variables: input.artifact.variables,
		bindings: input.bindings,
	});
	const file = Bun.file(input.path);
	const existed = await file.exists();
	if (existed) {
		if (input.conflict === "skip") {
			const bytes = file.size;
			const sha256 = await sha256Hex(content);
			return { path: input.path, bytes, sha256, written: false, existed: true };
		}
		if (input.conflict === "error") {
			throw new Error(`Refusing to overwrite existing file: ${input.path}`);
		}
	}
	await Bun.$`mkdir -p ${dirname(input.path)}`.quiet();
	const bytes = await Bun.write(input.path, content);
	if (input.chmodX) await Bun.$`chmod +x ${input.path}`.quiet();
	const sha256 = await sha256Hex(content);
	return { path: input.path, bytes, sha256, written: true, existed };
}

async function sha256Hex(content: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

function collectTargets(
	repo: ArtifactRepo,
	args: { ids?: string[]; kind?: Kind; tags?: string[] },
): Artifact[] {
	const seen = new Map<string, Artifact>();
	if (args.ids !== undefined) {
		for (const id of args.ids) {
			const a = requireArtifact(repo, id);
			seen.set(a.id, a);
		}
	}
	if (args.ids === undefined || args.kind !== undefined || args.tags !== undefined) {
		let cursor: string | null = null;
		do {
			const page = repo.list({
				limit: 100,
				...(args.kind !== undefined ? { kind: args.kind } : {}),
				...(args.tags !== undefined ? { tags: args.tags } : {}),
				...(cursor !== null ? { cursor } : {}),
			});
			for (const a of page.artifacts) seen.set(a.id, a);
			cursor = page.nextCursor;
		} while (cursor !== null);
	}
	return [...seen.values()];
}

const LANGUAGE_EXT: Readonly<Record<string, string>> = {
	typescript: "ts",
	tsx: "tsx",
	javascript: "js",
	jsx: "jsx",
	json: "json",
	html: "html",
	css: "css",
	markdown: "md",
	md: "md",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	sh: "sh",
	bash: "sh",
	python: "py",
	rust: "rs",
	go: "go",
	sql: "sql",
};

function artifactFilename(a: Artifact, override: string | undefined): string {
	if (override !== undefined) return `${a.name}.${override.replace(/^\./, "")}`;
	if (a.language !== null && LANGUAGE_EXT[a.language] !== undefined) {
		return `${a.name}.${LANGUAGE_EXT[a.language]}`;
	}
	return a.name;
}

function extractRevisions(
	raw: unknown,
):
	| { version: number; content: string; variables: Artifact["variables"]; createdAt: number }[]
	| null {
	if (!Array.isArray(raw)) return null;
	const out: {
		version: number;
		content: string;
		variables: Artifact["variables"];
		createdAt: number;
	}[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object") return null;
		const e = entry as Record<string, unknown>;
		if (
			typeof e.version !== "number" ||
			!Number.isInteger(e.version) ||
			e.version < 1 ||
			typeof e.content !== "string" ||
			typeof e.createdAt !== "number"
		) {
			return null;
		}
		const variables = Array.isArray(e.variables)
			? (e.variables as Artifact["variables"])
			: ([] as Artifact["variables"]);
		out.push({
			version: e.version,
			content: e.content,
			variables,
			createdAt: e.createdAt,
		});
	}
	return out;
}

interface ToolExtra {
	signal?: AbortSignal;
	sendNotification?: (notification: unknown) => Promise<void>;
	_meta?: { progressToken?: string | number };
}

function throwIfCancelled(extra: ToolExtra | undefined): void {
	if (extra?.signal?.aborted === true) {
		throw snippyMcpError({
			code: SNIPPY_ERROR_CODES.Cancelled,
			message: "operation cancelled by client",
		});
	}
}

function makeProgressEmitter(
	extra: ToolExtra | undefined,
	total?: number,
): { send(progress: number): Promise<void> } {
	const token = extra?._meta?.progressToken;
	if (token === undefined || extra?.sendNotification === undefined) {
		return { async send(): Promise<void> {} };
	}
	const sendNotification = extra.sendNotification;
	return {
		async send(progress: number): Promise<void> {
			try {
				await sendNotification({
					method: "notifications/progress",
					params: {
						progressToken: token,
						progress,
						...(total !== undefined ? { total } : {}),
					},
				});
			} catch {
				// notifications are best-effort; don't break the primary op.
			}
		},
	};
}

function renderToPayload(
	artifact: Artifact,
	bindings: Readonly<Record<string, string>>,
): { id: string; kind: Kind; name: string; content: string } {
	try {
		const content = render({
			content: artifact.content,
			variables: artifact.variables,
			bindings,
		});
		return { id: artifact.id, kind: artifact.kind, name: artifact.name, content };
	} catch (err) {
		if (err instanceof RenderError) {
			throw snippyMcpError({
				code: SNIPPY_ERROR_CODES.RenderMissingBindings,
				message: `${err.message} (artifact=${artifact.kind}/${artifact.name})`,
				data: { missing: err.missing, kind: artifact.kind, name: artifact.name },
			});
		}
		throw err;
	}
}
