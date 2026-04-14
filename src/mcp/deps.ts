import type { Database } from "bun:sqlite";
import type { ArtifactRepo } from "../repo/artifact-repo.ts";
import type { AuditWriter } from "./audit.ts";
import type { Role } from "./auth.ts";
import type { SnippyMetrics } from "./metrics.ts";

export interface ServerDeps {
	readonly repo: ArtifactRepo;
	readonly role?: Role;
	readonly audit?: AuditWriter;
	readonly actor?: string;
	readonly metrics?: SnippyMetrics;
	readonly db?: Database;
	readonly workspace?: string;
}

export interface ToolDeps extends ServerDeps {
	readonly role: Role;
	readonly actor: string;
}
