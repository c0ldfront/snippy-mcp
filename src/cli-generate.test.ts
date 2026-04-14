import { describe, expect, test } from "bun:test";
import { FORMATS, generate, isFormat } from "./cli-generate.ts";

describe("isFormat", () => {
	test("accepts every declared format", () => {
		for (const f of FORMATS) expect(isFormat(f)).toBe(true);
	});
	test("rejects garbage", () => {
		expect(isFormat("nope")).toBe(false);
		expect(isFormat("")).toBe(false);
	});
});

describe("generate", () => {
	test("claude-desktop stdio: emits {mcpServers: {snippy: {command, args}}}", () => {
		const out = JSON.parse(
			generate({
				format: "claude-desktop",
				binary: "snippy-mcp",
				workspace: "default",
				transport: "stdio",
				dbPath: "/srv/snippy.db",
				rootsPath: "/srv/code",
			}),
		);
		expect(out.mcpServers.snippy.command).toBe("snippy-mcp");
		expect(out.mcpServers.snippy.args).toEqual([]);
		expect(out.mcpServers.snippy.env.SNIPPY_DB).toBe("/srv/snippy.db");
		expect(out.mcpServers.snippy.env.SNIPPY_ROOTS).toBe("/srv/code");
	});

	test("workspace name flows into args (stdio) and ?workspace= (http)", () => {
		const stdio = JSON.parse(
			generate({
				format: "claude-desktop",
				binary: "snippy-mcp",
				workspace: "team",
				transport: "stdio",
			}),
		);
		expect(stdio.mcpServers.snippy.args).toEqual(["--workspace=team"]);

		const http = JSON.parse(
			generate({
				format: "claude-desktop",
				binary: "snippy-mcp",
				workspace: "team",
				transport: "http",
				httpUrl: "http://localhost:7878/mcp",
			}),
		);
		expect(http.mcpServers.snippy.url).toContain("workspace=team");
		expect(http.mcpServers.snippy.type).toBe("http");
	});

	test("http with token attaches Authorization header", () => {
		const out = JSON.parse(
			generate({
				format: "cursor",
				binary: "snippy-mcp",
				workspace: "default",
				transport: "http",
				httpToken: "secret-tok",
			}),
		);
		expect(out.mcpServers.snippy.headers.Authorization).toBe("Bearer secret-tok");
	});

	test("vscode emits {servers:{...}} (vscode-style key)", () => {
		const out = JSON.parse(
			generate({
				format: "vscode",
				binary: "snippy-mcp",
				workspace: "default",
				transport: "stdio",
			}),
		);
		expect(out.servers.snippy).toBeDefined();
		expect(out.mcpServers).toBeUndefined();
	});

	test("shell-env emits export lines and quotes paths with spaces", () => {
		const out = generate({
			format: "shell-env",
			binary: "snippy-mcp",
			workspace: "team",
			transport: "http",
			dbPath: "/path with space/snippy.db",
			httpUrl: "http://0.0.0.0:9000/mcp",
			httpToken: "tok-1",
		});
		expect(out).toContain("export SNIPPY_DB='/path with space/snippy.db'");
		expect(out).toContain("export SNIPPY_WORKSPACE=team");
		expect(out).toContain("export SNIPPY_HTTP_HOST=0.0.0.0");
		expect(out).toContain("export SNIPPY_HTTP_PORT=9000");
		expect(out).toContain("export SNIPPY_HTTP_TOKENS='tok-1:admin'");
	});

	test("custom server name overrides the default 'snippy' key", () => {
		const out = JSON.parse(
			generate({
				format: "claude-desktop",
				binary: "snippy-mcp",
				workspace: "default",
				transport: "stdio",
				serverName: "company-snippy",
			}),
		);
		expect(out.mcpServers["company-snippy"]).toBeDefined();
		expect(out.mcpServers.snippy).toBeUndefined();
	});
});
