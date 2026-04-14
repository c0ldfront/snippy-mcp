import { resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface AllowedRoots {
	readonly source: "client" | "env" | "none";
	readonly roots: readonly string[];
}

function fileUriToPath(uri: string): string | null {
	try {
		const u = new URL(uri);
		if (u.protocol !== "file:") return null;
		return decodeURIComponent(u.pathname);
	} catch {
		return null;
	}
}

function envRoots(): string[] {
	const raw = Bun.env.SNIPPY_ROOTS;
	if (raw === undefined || raw.length === 0) return [];
	return raw
		.split(":")
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
		.map((p) => resolve(p));
}

export async function discoverAllowedRoots(server: McpServer): Promise<AllowedRoots> {
	const clientCaps = server.server.getClientCapabilities();
	if (clientCaps?.roots !== undefined) {
		try {
			const result = await server.server.listRoots();
			const roots: string[] = [];
			for (const r of result.roots) {
				const p = fileUriToPath(r.uri);
				if (p !== null) roots.push(resolve(p));
			}
			if (roots.length > 0) return { source: "client", roots };
		} catch {
			// fall through to env
		}
	}
	const env = envRoots();
	if (env.length > 0) return { source: "env", roots: env };
	return { source: "none", roots: [] };
}

export function isPathInsideRoot(targetAbs: string, rootAbs: string): boolean {
	const root = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
	return targetAbs === rootAbs || targetAbs.startsWith(root);
}

export function ensurePathAllowed(path: string, allowed: AllowedRoots): string {
	const abs = resolve(path);
	if (allowed.roots.length === 0) {
		throw new Error(
			"No allowed roots advertised. Set SNIPPY_ROOTS or have the client declare roots.",
		);
	}
	for (const root of allowed.roots) {
		if (isPathInsideRoot(abs, root)) return abs;
	}
	throw new Error(
		`Path ${abs} is outside the allowed roots (${allowed.source}: ${allowed.roots.join(", ")})`,
	);
}
