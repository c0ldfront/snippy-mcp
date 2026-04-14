export type GenerateFormat = "claude-desktop" | "cursor" | "vscode" | "mcp-json" | "shell-env";

export const FORMATS: readonly GenerateFormat[] = [
	"claude-desktop",
	"cursor",
	"vscode",
	"mcp-json",
	"shell-env",
] as const;

export function isFormat(value: string): value is GenerateFormat {
	return (FORMATS as readonly string[]).includes(value);
}

export interface GenerateInput {
	format: GenerateFormat;
	binary: string;
	workspace: string;
	transport: "stdio" | "http";
	httpUrl?: string;
	httpToken?: string;
	dbPath?: string;
	rootsPath?: string;
	serverName?: string;
}

export function generate(input: GenerateInput): string {
	const name = input.serverName ?? "snippy";
	switch (input.format) {
		case "claude-desktop":
			return JSON.stringify(claudeDesktopConfig(input, name), null, 2);
		case "cursor":
			return JSON.stringify(cursorConfig(input, name), null, 2);
		case "vscode":
			return JSON.stringify(vscodeConfig(input, name), null, 2);
		case "mcp-json":
			return JSON.stringify(genericMcpConfig(input, name), null, 2);
		case "shell-env":
			return shellEnv(input);
	}
}

interface StdioServerEntry {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

interface HttpServerEntry {
	type: "http";
	url: string;
	headers?: Record<string, string>;
}

function stdioEntry(input: GenerateInput): StdioServerEntry {
	const env: Record<string, string> = {};
	if (input.dbPath !== undefined) env.SNIPPY_DB = input.dbPath;
	if (input.rootsPath !== undefined) env.SNIPPY_ROOTS = input.rootsPath;
	const args = [];
	if (input.workspace !== "default") args.push(`--workspace=${input.workspace}`);
	const entry: StdioServerEntry = {
		command: input.binary,
		args,
	};
	if (Object.keys(env).length > 0) entry.env = env;
	return entry;
}

function httpEntry(input: GenerateInput): HttpServerEntry {
	const entry: HttpServerEntry = {
		type: "http",
		url: workspaceUrl(input.httpUrl ?? "http://127.0.0.1:7878/mcp", input.workspace),
	};
	if (input.httpToken !== undefined) {
		entry.headers = { Authorization: `Bearer ${input.httpToken}` };
	}
	return entry;
}

function workspaceUrl(rawUrl: string, workspace: string): string {
	if (workspace === "default") return rawUrl;
	const url = new URL(rawUrl);
	url.searchParams.set("workspace", workspace);
	return url.toString();
}

function claudeDesktopConfig(
	input: GenerateInput,
	name: string,
): { mcpServers: Record<string, StdioServerEntry | HttpServerEntry> } {
	const entry = input.transport === "http" ? httpEntry(input) : stdioEntry(input);
	return { mcpServers: { [name]: entry } };
}

function cursorConfig(
	input: GenerateInput,
	name: string,
): { mcpServers: Record<string, StdioServerEntry | HttpServerEntry> } {
	// Cursor uses the same {mcpServers: {...}} shape as Claude Desktop today.
	return claudeDesktopConfig(input, name);
}

function vscodeConfig(
	input: GenerateInput,
	name: string,
): { servers: Record<string, StdioServerEntry | HttpServerEntry> } {
	const entry = input.transport === "http" ? httpEntry(input) : stdioEntry(input);
	return { servers: { [name]: entry } };
}

function genericMcpConfig(
	input: GenerateInput,
	name: string,
): { mcpServers: Record<string, StdioServerEntry | HttpServerEntry> } {
	return claudeDesktopConfig(input, name);
}

function shellEnv(input: GenerateInput): string {
	const lines: string[] = [];
	if (input.dbPath !== undefined) lines.push(`export SNIPPY_DB=${shellQuote(input.dbPath)}`);
	if (input.rootsPath !== undefined)
		lines.push(`export SNIPPY_ROOTS=${shellQuote(input.rootsPath)}`);
	if (input.workspace !== "default")
		lines.push(`export SNIPPY_WORKSPACE=${shellQuote(input.workspace)}`);
	if (input.transport === "http") {
		lines.push(`export SNIPPY_HTTP_HOST=${shellQuote(httpHostFromUrl(input.httpUrl))}`);
		lines.push(`export SNIPPY_HTTP_PORT=${shellQuote(httpPortFromUrl(input.httpUrl))}`);
		if (input.httpToken !== undefined) {
			lines.push(`export SNIPPY_HTTP_TOKENS=${shellQuote(`${input.httpToken}:admin`)}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function httpHostFromUrl(url: string | undefined): string {
	try {
		const u = new URL(url ?? "http://127.0.0.1:7878");
		return u.hostname;
	} catch {
		return "127.0.0.1";
	}
}

function httpPortFromUrl(url: string | undefined): string {
	try {
		const u = new URL(url ?? "http://127.0.0.1:7878");
		return u.port !== "" ? u.port : "7878";
	} catch {
		return "7878";
	}
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9._/-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}
