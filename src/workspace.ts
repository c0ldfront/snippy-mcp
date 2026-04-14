import type { Db } from "./db/connection.ts";
import { openDb } from "./db/connection.ts";
import { AuditWriter } from "./mcp/audit.ts";
import { buildSnippyMetrics, type SnippyMetrics } from "./mcp/metrics.ts";
import { ArtifactRepo } from "./repo/artifact-repo.ts";

export interface WorkspaceDef {
	readonly name: string;
	readonly dbPath: string;
}

export interface OpenWorkspace {
	readonly name: string;
	readonly db: Db;
	readonly repo: ArtifactRepo;
	readonly audit: AuditWriter;
	readonly metrics: SnippyMetrics;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function parseWorkspaces(
	raw: string | undefined,
	fallbackDbPath: string,
): ReadonlyMap<string, WorkspaceDef> {
	const map = new Map<string, WorkspaceDef>();
	if (raw === undefined || raw.trim() === "") {
		map.set("default", { name: "default", dbPath: fallbackDbPath });
		return map;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const detail = err instanceof Error ? err.message : "invalid JSON";
		throw new Error(`SNIPPY_WORKSPACES is not valid JSON: ${detail}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("SNIPPY_WORKSPACES must be a JSON object of {name: dbPath}.");
	}
	for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!NAME_PATTERN.test(name)) {
			throw new Error(`SNIPPY_WORKSPACES name '${name}' is not a valid workspace identifier.`);
		}
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`SNIPPY_WORKSPACES['${name}'] must be a non-empty string db path.`);
		}
		map.set(name, { name, dbPath: value });
	}
	if (!map.has("default")) {
		map.set("default", { name: "default", dbPath: fallbackDbPath });
	}
	return map;
}

export class WorkspaceRegistry {
	private readonly opened = new Map<string, OpenWorkspace>();

	constructor(private readonly defs: ReadonlyMap<string, WorkspaceDef>) {}

	has(name: string): boolean {
		return this.defs.has(name);
	}

	names(): string[] {
		return [...this.defs.keys()].sort();
	}

	get(name: string): OpenWorkspace {
		const cached = this.opened.get(name);
		if (cached !== undefined) return cached;
		const def = this.defs.get(name);
		if (def === undefined) throw new Error(`unknown workspace: ${name}`);
		const db = openDb(def.dbPath);
		const ws: OpenWorkspace = {
			name,
			db,
			repo: new ArtifactRepo(db),
			audit: new AuditWriter(db),
			metrics: buildSnippyMetrics(db),
		};
		this.opened.set(name, ws);
		return ws;
	}

	closeAll(): void {
		for (const ws of this.opened.values()) ws.db.close();
		this.opened.clear();
	}
}
