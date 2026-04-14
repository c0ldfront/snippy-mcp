import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openMemoryDb } from "../db/connection.ts";
import { parseTokens } from "../mcp/auth.ts";
import { buildSnippyMetrics } from "../mcp/metrics.ts";
import { ArtifactRepo } from "../repo/artifact-repo.ts";
import { parseOriginAllowlist, type RunningHttpServer, startHttpServer } from "./http.ts";

let server: RunningHttpServer;
let endpoint: URL;

beforeAll(() => {
	const db = openMemoryDb();
	const repo = new ArtifactRepo(db);
	server = startHttpServer({
		repo,
		db,
		host: "127.0.0.1",
		port: 0,
		originAllowlist: null,
		tokens: parseTokens(undefined),
	});
	endpoint = new URL(`http://127.0.0.1:${server.bun.port}/mcp`);
});

afterAll(async () => {
	await server.closeAll();
});

describe("http transport", () => {
	test("/healthz returns ok", async () => {
		const res = await fetch(`http://127.0.0.1:${server.bun.port}/healthz`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	test("/readyz returns ok when the db responds", async () => {
		const res = await fetch(`http://127.0.0.1:${server.bun.port}/readyz`);
		expect(res.status).toBe(200);
	});

	test("a streamable-http client can list tools and round-trip a push", async () => {
		const transport = new StreamableHTTPClientTransport(endpoint);
		const client = new Client({ name: "snippy-http-test", version: "0.0.0" }, { capabilities: {} });
		await client.connect(transport);
		const { tools } = await client.listTools();
		expect(tools.some((t) => t.name === "artifact.push")).toBe(true);

		const pushed = (
			await client.callTool({
				name: "artifact.push",
				arguments: { kind: "snippet", name: "http-test", content: "x" },
			})
		).structuredContent as { artifact: { name: string } };
		expect(pushed.artifact.name).toBe("http-test");
		await client.close();
	});

	test("origin allowlist rejects unknown origins with 403", async () => {
		const db = openMemoryDb();
		const repo = new ArtifactRepo(db);
		const restricted = startHttpServer({
			repo,
			db,
			host: "127.0.0.1",
			port: 0,
			originAllowlist: parseOriginAllowlist("https://allowed.example"),
			tokens: parseTokens(undefined),
		});
		try {
			const url = `http://127.0.0.1:${restricted.bun.port}/mcp`;
			const blocked = await fetch(url, {
				method: "POST",
				headers: { origin: "https://attacker.example", "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			});
			expect(blocked.status).toBe(403);
		} finally {
			await restricted.closeAll();
			db.close();
		}
	});
});

describe("http transport bearer auth + RBAC", () => {
	test("requests without a valid bearer token get 401 when tokens are configured", async () => {
		const db = openMemoryDb();
		const repo = new ArtifactRepo(db);
		const authed = startHttpServer({
			repo,
			db,
			host: "127.0.0.1",
			port: 0,
			originAllowlist: null,
			tokens: parseTokens("alice:admin"),
		});
		try {
			const url = `http://127.0.0.1:${authed.bun.port}/mcp`;
			const noToken = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			});
			expect(noToken.status).toBe(401);
		} finally {
			await authed.closeAll();
			db.close();
		}
	});

	test("reader role cannot see destructive tools (artifact.delete absent from listTools)", async () => {
		const db = openMemoryDb();
		const repo = new ArtifactRepo(db);
		const authed = startHttpServer({
			repo,
			db,
			host: "127.0.0.1",
			port: 0,
			originAllowlist: null,
			tokens: parseTokens("ro:reader"),
		});
		try {
			const url = `http://127.0.0.1:${authed.bun.port}/mcp`;
			const transport = new StreamableHTTPClientTransport(new URL(url), {
				requestInit: { headers: { authorization: "Bearer ro" } },
			});
			const client = new Client({ name: "ro", version: "0.0.0" }, { capabilities: {} });
			await client.connect(transport);
			const { tools } = await client.listTools();
			const names = tools.map((t) => t.name);
			expect(names).toContain("artifact.list");
			expect(names).not.toContain("artifact.delete");
			expect(names).not.toContain("artifact.push");
			await client.close();
		} finally {
			await authed.closeAll();
			db.close();
		}
	});

	test("admin role sees every tool", async () => {
		const db = openMemoryDb();
		const repo = new ArtifactRepo(db);
		const authed = startHttpServer({
			repo,
			db,
			host: "127.0.0.1",
			port: 0,
			originAllowlist: null,
			tokens: parseTokens("god:admin"),
		});
		try {
			const url = `http://127.0.0.1:${authed.bun.port}/mcp`;
			const transport = new StreamableHTTPClientTransport(new URL(url), {
				requestInit: { headers: { authorization: "Bearer god" } },
			});
			const client = new Client({ name: "god", version: "0.0.0" }, { capabilities: {} });
			await client.connect(transport);
			const { tools } = await client.listTools();
			const names = tools.map((t) => t.name);
			expect(names).toContain("artifact.delete");
			expect(names).toContain("artifact.materialize");
			await client.close();
		} finally {
			await authed.closeAll();
			db.close();
		}
	});
});

describe("/metrics endpoint", () => {
	test("returns 404 when metrics aren't wired into the transport", async () => {
		const url = `http://127.0.0.1:${server.bun.port}/metrics`;
		const res = await fetch(url);
		expect(res.status).toBe(404);
	});

	test("renders Prometheus text once metrics are attached", async () => {
		const db = openMemoryDb();
		const repo = new ArtifactRepo(db);
		const metrics = buildSnippyMetrics(db);
		const withMetrics = startHttpServer({
			repo,
			db,
			host: "127.0.0.1",
			port: 0,
			originAllowlist: null,
			tokens: parseTokens(undefined),
			metrics,
		});
		try {
			metrics.recordToolCall("artifact.list", "ok", 0.01);
			const res = await fetch(`http://127.0.0.1:${withMetrics.bun.port}/metrics`);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("snippy_tool_calls_total");
			expect(body).toContain("snippy_artifacts_total");
		} finally {
			await withMetrics.closeAll();
			db.close();
		}
	});
});

describe("parseOriginAllowlist", () => {
	test("returns null when env is missing or empty", () => {
		expect(parseOriginAllowlist(undefined)).toBeNull();
		expect(parseOriginAllowlist("")).toBeNull();
		expect(parseOriginAllowlist("  ")).toBeNull();
	});

	test("splits on commas, trims whitespace, dedupes", () => {
		const set = parseOriginAllowlist("https://a, https://b ,https://a");
		expect(set?.has("https://a")).toBe(true);
		expect(set?.has("https://b")).toBe(true);
		expect(set?.size).toBe(2);
	});
});
