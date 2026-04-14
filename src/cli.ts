#!/usr/bin/env bun
import { unlink } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json" with { type: "json" };
import {
	FORMATS,
	type GenerateFormat,
	type GenerateInput,
	generate,
	isFormat,
} from "./cli-generate.ts";
import { resolveRetentionMs } from "./mcp/audit.ts";
import { parseTokens } from "./mcp/auth.ts";
import { buildServer } from "./mcp/server.ts";
import { parseOriginAllowlist, startHttpServer } from "./transport/http.ts";
import { parseWorkspaces, WorkspaceRegistry } from "./workspace.ts";

async function unlinkIfExists(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
}

export class UsageError extends Error {
	override readonly name = "UsageError";
}

export const VERSION: string = pkg.version;

export function helpText(): string {
	return `snippy-mcp ${VERSION} — MCP server for reusable code standards, snippets, and resources

Usage:
  snippy-mcp [--stdio] [--workspace=<name>]
      Run the stdio transport (default; trusted, role=admin).
  snippy-mcp --http [--workspace=<name>]
      Run the Streamable HTTP transport. Bind via SNIPPY_HTTP_HOST/PORT.
  snippy-mcp audit tail [N] [--workspace=<name>]
      Print the last N audit rows (default 50).
  snippy-mcp backup --out <path> [--workspace=<name>]
      Write a live VACUUM INTO backup of the workspace DB.
  snippy-mcp restore --in <path> [--workspace=<name>]
      Replace the workspace DB with a backup file (cleans WAL/SHM siblings).
  snippy-mcp generate <format> [--out <path>] [--stdio|--http]
                               [--url <url>] [--token <tok>] [--name <srv>]
      Emit a client config for: ${FORMATS.join(", ")}.
  snippy-mcp --help, -h
      Show this help and exit.
  snippy-mcp --version, -v
      Show the version and exit.

Environment:
  SNIPPY_DB                  SQLite path (default: $HOME/.snippy-mcp.db).
  SNIPPY_WORKSPACES          JSON {name: dbPath} for multi-workspace hosting.
  SNIPPY_WORKSPACE           Default stdio workspace (default: "default").
  SNIPPY_HTTP_HOST           HTTP bind host (default: 127.0.0.1).
  SNIPPY_HTTP_PORT           HTTP port (default: 7878).
  SNIPPY_HTTP_TOKENS         CSV of token:role (reader|writer|admin).
  SNIPPY_ORIGIN_ALLOWLIST    CSV of allowed Origin headers.
  SNIPPY_AUDIT_DAYS          Audit retention days (default 90; 0 disables).
  SNIPPY_ROOTS               Comma-separated materialize roots.

See README.md and docs/ for full documentation.
`;
}

function resolveDbPath(): string {
	return Bun.env.SNIPPY_DB ?? `${Bun.env.HOME ?? "."}/.snippy-mcp.db`;
}

type CliMode =
	| { kind: "stdio"; workspace: string }
	| { kind: "http"; defaultWorkspace: string }
	| { kind: "audit-tail"; limit: number; workspace: string }
	| { kind: "backup"; out: string; workspace: string }
	| { kind: "restore"; in: string; workspace: string }
	| {
			kind: "generate";
			workspace: string;
			format: GenerateFormat;
			out: string | null;
			transport: "stdio" | "http";
			httpUrl: string | undefined;
			httpToken: string | undefined;
			serverName: string | undefined;
	  };

function parseArgs(argv: readonly string[]): CliMode {
	const args = argv.slice(2);
	let mode: "stdio" | "http" | null = null;
	let workspace = Bun.env.SNIPPY_WORKSPACE ?? "default";
	let auditLimit: number | null = null;
	let isAudit = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--http") mode = "http";
		else if (arg === "--stdio") mode = "stdio";
		else if (arg?.startsWith("--workspace=")) workspace = arg.slice("--workspace=".length);
		else if (arg === "--workspace") {
			const next = args[i + 1];
			if (next === undefined) throw new UsageError("--workspace requires a value");
			workspace = next;
			i += 1;
		} else if (arg === "audit") {
			const sub = args[i + 1];
			if (sub === "tail") {
				isAudit = true;
				const limitStr = args[i + 2];
				const parsed = limitStr === undefined ? 50 : Number.parseInt(limitStr, 10);
				auditLimit = Number.isFinite(parsed) ? parsed : 50;
				break;
			}
			throw new UsageError(`unknown audit subcommand: ${sub ?? ""}`);
		} else if (arg === "backup") {
			const out = takeFlagValue(args, i + 1, "--out");
			return { kind: "backup", out, workspace };
		} else if (arg === "restore") {
			const inPath = takeFlagValue(args, i + 1, "--in");
			return { kind: "restore", in: inPath, workspace };
		} else if (arg === "generate") {
			const formatName = args[i + 1];
			if (formatName === undefined || !isFormat(formatName)) {
				throw new UsageError(`'generate' requires a format argument: one of ${FORMATS.join(", ")}`);
			}
			const flags = args.slice(i + 2);
			let out: string | null = null;
			let transport: "stdio" | "http" = "stdio";
			let httpUrl: string | undefined;
			let httpToken: string | undefined;
			let serverName: string | undefined;
			for (let j = 0; j < flags.length; j++) {
				const tok = flags[j];
				if (tok === undefined) continue;
				if (tok === "--http") transport = "http";
				else if (tok === "--stdio") transport = "stdio";
				else if (tok.startsWith("--out=")) out = tok.slice("--out=".length);
				else if (tok === "--out") {
					out = flags[j + 1] ?? null;
					j += 1;
				} else if (tok.startsWith("--url=")) httpUrl = tok.slice("--url=".length);
				else if (tok === "--url") {
					httpUrl = flags[j + 1];
					j += 1;
				} else if (tok.startsWith("--token=")) httpToken = tok.slice("--token=".length);
				else if (tok === "--token") {
					httpToken = flags[j + 1];
					j += 1;
				} else if (tok.startsWith("--name=")) serverName = tok.slice("--name=".length);
				else if (tok === "--name") {
					serverName = flags[j + 1];
					j += 1;
				}
			}
			return {
				kind: "generate",
				workspace,
				format: formatName,
				out,
				transport,
				httpUrl,
				httpToken,
				serverName,
			};
		} else if (arg !== undefined) {
			throw new UsageError(`unknown argument: ${arg}`);
		}
	}
	if (isAudit) return { kind: "audit-tail", limit: auditLimit ?? 50, workspace };
	if (mode === "http") return { kind: "http", defaultWorkspace: workspace };
	return { kind: "stdio", workspace };
}

function takeFlagValue(args: readonly string[], startIndex: number, flag: string): string {
	for (let j = startIndex; j < args.length; j++) {
		const tok = args[j];
		if (tok === undefined) continue;
		if (tok.startsWith(`${flag}=`)) return tok.slice(flag.length + 1);
		if (tok === flag) {
			const v = args[j + 1];
			if (v === undefined) throw new UsageError(`${flag} requires a value`);
			return v;
		}
	}
	throw new UsageError(`${flag} is required`);
}

async function runBackup(
	registry: WorkspaceRegistry,
	workspace: string,
	out: string,
): Promise<void> {
	if (!registry.has(workspace)) throw new Error(`unknown workspace: ${workspace}`);
	const ws = registry.get(workspace);
	await unlinkIfExists(out);
	ws.db.prepare("VACUUM INTO ?").run(out);
	console.error(`backup written: ${out}`);
	registry.closeAll();
}

async function runRestore(
	registry: WorkspaceRegistry,
	workspace: string,
	source: string,
): Promise<void> {
	if (!registry.has(workspace)) throw new Error(`unknown workspace: ${workspace}`);
	const sourceFile = Bun.file(source);
	if (!(await sourceFile.exists())) {
		throw new Error(`backup file not found: ${source}`);
	}
	const ws = registry.get(workspace);
	const rows = ws.db.query("PRAGMA database_list").all() as { file: string }[];
	const target = rows.find((r) => r.file !== "")?.file;
	if (target === undefined) {
		throw new Error("could not resolve backing db file path");
	}
	ws.db.close();
	registry.closeAll();
	await Promise.all([
		unlinkIfExists(target),
		unlinkIfExists(`${target}-wal`),
		unlinkIfExists(`${target}-shm`),
	]);
	await Bun.write(target, sourceFile);
	console.error(`restore applied: ${target} ← ${source}`);
}

function pruneAudit(registry: WorkspaceRegistry, names: readonly string[]): void {
	const retention = resolveRetentionMs(Bun.env.SNIPPY_AUDIT_DAYS);
	for (const name of names) {
		const ws = registry.get(name);
		const removed = ws.audit.pruneOlderThan(retention);
		if (removed > 0) console.error(`audit[${name}]: pruned ${removed} expired rows`);
	}
}

async function runStdio(registry: WorkspaceRegistry, workspaceName: string): Promise<void> {
	if (!registry.has(workspaceName)) {
		throw new Error(
			`workspace '${workspaceName}' is not declared in SNIPPY_WORKSPACES (have: ${registry.names().join(", ")})`,
		);
	}
	const ws = registry.get(workspaceName);
	const server = buildServer({
		repo: ws.repo,
		role: "admin",
		actor: "stdio",
		audit: ws.audit,
		metrics: ws.metrics,
		db: ws.db,
		workspace: ws.name,
	});
	const transport = new StdioServerTransport();

	const shutdown = async (): Promise<void> => {
		await server.close();
		registry.closeAll();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	await server.connect(transport);
}

function runHttp(registry: WorkspaceRegistry, defaultWorkspace: string): void {
	const port = Number.parseInt(Bun.env.SNIPPY_HTTP_PORT ?? "7878", 10);
	const host = Bun.env.SNIPPY_HTTP_HOST ?? "127.0.0.1";
	const originAllowlist = parseOriginAllowlist(Bun.env.SNIPPY_ORIGIN_ALLOWLIST);
	const tokens = parseTokens(Bun.env.SNIPPY_HTTP_TOKENS);
	if (!registry.has(defaultWorkspace)) {
		throw new Error(`default workspace '${defaultWorkspace}' is not declared`);
	}
	const seedDefault = registry.get(defaultWorkspace);
	const running = startHttpServer({
		repo: seedDefault.repo,
		db: seedDefault.db,
		host,
		port,
		originAllowlist,
		tokens,
		audit: seedDefault.audit,
		metrics: seedDefault.metrics,
		workspaces: registry,
		defaultWorkspace,
	});

	const shutdown = async (): Promise<void> => {
		await running.closeAll();
		registry.closeAll();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	const advertised = `http://${host}:${port}/mcp`;
	console.error(`snippy-mcp http transport listening on ${advertised}`);
	console.error(`workspaces: ${registry.names().join(", ")} (default: ${defaultWorkspace})`);
	if (originAllowlist === null) {
		console.error(
			"warning: SNIPPY_ORIGIN_ALLOWLIST is not set; all origins are accepted (suitable for local-only deployments).",
		);
	}
	if (!tokens.enabled) {
		console.error(
			"warning: SNIPPY_HTTP_TOKENS is not set; every connection is granted admin role (local-only).",
		);
	}
}

function runAuditTail(registry: WorkspaceRegistry, workspace: string, limit: number): void {
	if (!registry.has(workspace)) {
		throw new Error(`workspace '${workspace}' is not declared`);
	}
	const ws = registry.get(workspace);
	const entries = ws.audit.tail(limit);
	for (const e of entries.reverse()) {
		const ts = new Date(e.ts).toISOString();
		const artifact = e.artifactId !== null ? ` artifact=${e.artifactId}` : "";
		console.log(`${ts} [${ws.name}] ${e.actor} ${e.tool} ${e.resultCode}${artifact} ${e.argsJson}`);
	}
	registry.closeAll();
}

async function main(): Promise<void> {
	const rest = process.argv.slice(2);
	if (rest.includes("--help") || rest.includes("-h")) {
		process.stdout.write(helpText());
		return;
	}
	if (rest.includes("--version") || rest.includes("-v")) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}
	const mode = parseArgs(process.argv);
	const defs = parseWorkspaces(Bun.env.SNIPPY_WORKSPACES, resolveDbPath());
	const registry = new WorkspaceRegistry(defs);
	pruneAudit(registry, registry.names());
	if (mode.kind === "http") {
		runHttp(registry, mode.defaultWorkspace);
	} else if (mode.kind === "audit-tail") {
		runAuditTail(registry, mode.workspace, mode.limit);
	} else if (mode.kind === "backup") {
		await runBackup(registry, mode.workspace, mode.out);
	} else if (mode.kind === "restore") {
		await runRestore(registry, mode.workspace, mode.in);
	} else if (mode.kind === "generate") {
		await runGenerate(mode);
		registry.closeAll();
	} else {
		await runStdio(registry, mode.workspace);
	}
}

async function runGenerate(mode: {
	workspace: string;
	format: GenerateFormat;
	out: string | null;
	transport: "stdio" | "http";
	httpUrl: string | undefined;
	httpToken: string | undefined;
	serverName: string | undefined;
}): Promise<void> {
	const input: GenerateInput = {
		format: mode.format,
		binary: process.execPath.endsWith("/bun") ? "snippy-mcp" : process.execPath,
		workspace: mode.workspace,
		transport: mode.transport,
		dbPath: Bun.env.SNIPPY_DB,
		rootsPath: Bun.env.SNIPPY_ROOTS,
		...(mode.httpUrl !== undefined ? { httpUrl: mode.httpUrl } : {}),
		...(mode.httpToken !== undefined ? { httpToken: mode.httpToken } : {}),
		...(mode.serverName !== undefined ? { serverName: mode.serverName } : {}),
	};
	const text = generate(input);
	if (mode.out !== null) {
		await Bun.write(mode.out, text);
		console.error(`generated ${mode.format} → ${mode.out}`);
	} else {
		process.stdout.write(text);
		if (!text.endsWith("\n")) process.stdout.write("\n");
	}
}

try {
	await main();
} catch (err) {
	if (err instanceof UsageError) {
		process.stderr.write(`snippy-mcp: ${err.message}\nRun 'snippy-mcp --help' for usage.\n`);
		process.exit(2);
	}
	throw err;
}
