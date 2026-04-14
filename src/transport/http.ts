import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Db } from "../db/connection.ts";
import type { AuditWriter } from "../mcp/audit.ts";
import { lookupRole, type Role, type TokenMap } from "../mcp/auth.ts";
import type { SnippyMetrics } from "../mcp/metrics.ts";
import { buildServer } from "../mcp/server.ts";
import type { ArtifactRepo } from "../repo/artifact-repo.ts";
import type { WorkspaceRegistry } from "../workspace.ts";

export interface HttpServerOptions {
	readonly repo: ArtifactRepo;
	readonly db: Db;
	readonly host: string;
	readonly port: number;
	readonly originAllowlist: ReadonlySet<string> | null;
	readonly tokens: TokenMap;
	readonly audit?: AuditWriter;
	readonly metrics?: SnippyMetrics;
	readonly workspaces?: WorkspaceRegistry;
	readonly defaultWorkspace?: string;
	readonly serverName?: string;
	readonly serverVersion?: string;
}

interface Session {
	transport: WebStandardStreamableHTTPServerTransport;
	server: Awaited<ReturnType<typeof buildServer>>;
	role: Role;
}

export interface RunningHttpServer {
	readonly bun: ReturnType<typeof Bun.serve>;
	closeAll(): Promise<void>;
}

const SESSION_HEADER = "mcp-session-id";

export function startHttpServer(opts: HttpServerOptions): RunningHttpServer {
	const sessions = new Map<string, Session>();

	const isOriginAllowed = (origin: string | null): boolean => {
		if (opts.originAllowlist === null) return true;
		if (origin === null) return false;
		return opts.originAllowlist.has(origin);
	};

	const handleMcp = async (req: Request): Promise<Response> => {
		const origin = req.headers.get("origin");
		if (!isOriginAllowed(origin)) {
			return new Response(JSON.stringify({ error: "origin not allowed" }), {
				status: 403,
				headers: { "content-type": "application/json" },
			});
		}

		const role = lookupRole(opts.tokens, req.headers.get("authorization"));
		if (role === null) {
			return new Response(
				JSON.stringify({ error: "unauthorized: bearer token missing or unknown" }),
				{
					status: 401,
					headers: {
						"content-type": "application/json",
						"www-authenticate": 'Bearer realm="snippy-mcp"',
					},
				},
			);
		}

		const sessionId = req.headers.get(SESSION_HEADER);
		if (sessionId !== null) {
			const session = sessions.get(sessionId);
			if (session === undefined) {
				return new Response(JSON.stringify({ error: "unknown session" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}
			return session.transport.handleRequest(req);
		}

		const url = new URL(req.url);
		const requestedWs = url.searchParams.get("workspace") ?? opts.defaultWorkspace ?? "default";
		let resolved: {
			repo: ArtifactRepo;
			db: Db;
			audit?: AuditWriter;
			metrics?: SnippyMetrics;
		};
		if (opts.workspaces !== undefined) {
			if (!opts.workspaces.has(requestedWs)) {
				return new Response(JSON.stringify({ error: `unknown workspace: ${requestedWs}` }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}
			const ws = opts.workspaces.get(requestedWs);
			resolved = { repo: ws.repo, db: ws.db, audit: ws.audit, metrics: ws.metrics };
		} else {
			resolved = {
				repo: opts.repo,
				db: opts.db,
				...(opts.audit !== undefined ? { audit: opts.audit } : {}),
				...(opts.metrics !== undefined ? { metrics: opts.metrics } : {}),
			};
		}

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessioninitialized: (sid) => {
				sessions.set(sid, { transport, server, role });
			},
			onsessionclosed: (sid) => {
				const s = sessions.get(sid);
				if (s !== undefined) {
					sessions.delete(sid);
					void s.server.close();
				}
			},
		});
		const actor = `http:${role}`;
		const server = buildServer({
			repo: resolved.repo,
			role,
			actor,
			db: resolved.db,
			workspace: requestedWs,
			...(resolved.audit !== undefined ? { audit: resolved.audit } : {}),
			...(resolved.metrics !== undefined ? { metrics: resolved.metrics } : {}),
			...(opts.serverName !== undefined ? { name: opts.serverName } : {}),
			...(opts.serverVersion !== undefined ? { version: opts.serverVersion } : {}),
		});
		await server.connect(transport);
		return transport.handleRequest(req);
	};

	const handleMetrics = (): Response => {
		if (opts.metrics === undefined) {
			return new Response("metrics disabled", { status: 404 });
		}
		return new Response(opts.metrics.registry.render(), {
			status: 200,
			headers: { "content-type": "text/plain; version=0.0.4" },
		});
	};

	const handleHealth = (): Response =>
		new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });

	const handleReady = (): Response => {
		try {
			opts.db.query("SELECT 1").get();
			return new Response("ok", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "db unreachable";
			return new Response(message, { status: 503, headers: { "content-type": "text/plain" } });
		}
	};

	const bun = Bun.serve({
		hostname: opts.host,
		port: opts.port,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/healthz") return handleHealth();
			if (url.pathname === "/readyz") return handleReady();
			if (url.pathname === "/metrics") return handleMetrics();
			if (url.pathname === "/mcp") return handleMcp(req);
			return new Response("not found", { status: 404 });
		},
	});

	return {
		bun,
		async closeAll(): Promise<void> {
			for (const session of sessions.values()) {
				await session.transport.close();
				await session.server.close();
			}
			sessions.clear();
			bun.stop(true);
		},
	};
}

export function parseOriginAllowlist(raw: string | undefined): ReadonlySet<string> | null {
	if (raw === undefined || raw.trim() === "") return null;
	const set = new Set<string>();
	for (const o of raw.split(",")) {
		const trimmed = o.trim();
		if (trimmed !== "") set.add(trimmed);
	}
	return set.size === 0 ? null : set;
}
