import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ArtifactRepo } from "../repo/artifact-repo.ts";
import type { AuditWriter } from "./audit.ts";
import type { Role } from "./auth.ts";
import type { SnippyMetrics } from "./metrics.ts";
import { registerPrompts } from "./prompts.ts";
import { registerResources } from "./resources.ts";
import { registerTools } from "./tools.ts";

export interface BuildServerOptions {
	readonly repo: ArtifactRepo;
	readonly name?: string;
	readonly version?: string;
	readonly role?: Role;
	readonly audit?: AuditWriter;
	readonly actor?: string;
	readonly metrics?: SnippyMetrics;
	readonly db?: Database;
	readonly workspace?: string;
}

export function buildServer({
	repo,
	name,
	version,
	role,
	audit,
	actor,
	metrics,
	db,
	workspace,
}: BuildServerOptions): McpServer {
	const server = new McpServer(
		{ name: name ?? "snippy-mcp", version: version ?? "0.2.0" },
		{
			capabilities: {
				tools: { listChanged: true },
				resources: { listChanged: true, subscribe: false },
				prompts: { listChanged: true },
				logging: {},
				completions: {},
			},
			instructions:
				"snippy-mcp stores reusable code standards, snippets, and external resources. Use artifact.* tools to push, search, tag, and render; resources are exposed at snippet://{kind}/{id}; prompts apply-standard and reuse-snippet consume them.",
		},
	);

	const toolDeps = {
		repo,
		role: role ?? "admin",
		actor: actor ?? "stdio",
		...(audit !== undefined ? { audit } : {}),
		...(metrics !== undefined ? { metrics } : {}),
		...(db !== undefined ? { db } : {}),
	} as const;
	registerTools(server, toolDeps);
	registerResources(server, {
		repo,
		workspace: workspace ?? "default",
		...(db !== undefined ? { db } : {}),
	});
	registerPrompts(server, { repo });

	return server;
}
