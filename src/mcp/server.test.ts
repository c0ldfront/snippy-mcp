import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openMemoryDb } from "../db/connection.ts";
import { ArtifactRepo } from "../repo/artifact-repo.ts";
import { buildServer } from "./server.ts";

async function makeClient(): Promise<Client> {
	const db = openMemoryDb();
	const repo = new ArtifactRepo(db);
	const server = buildServer({ repo });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "snippy-test-client", version: "0.0.0" }, { capabilities: {} });
	await client.connect(clientTransport);
	return client;
}

async function makeClientWithRoots(roots: readonly string[]): Promise<Client> {
	const db = openMemoryDb();
	const repo = new ArtifactRepo(db);
	const server = buildServer({ repo });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client(
		{ name: "snippy-test-client", version: "0.0.0" },
		{ capabilities: { roots: {} } },
	);
	client.setRequestHandler(ListRootsRequestSchema, async () => ({
		roots: roots.map((p) => ({ uri: `file://${p}`, name: p })),
	}));
	await client.connect(clientTransport);
	return client;
}

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
	const dir = `${Bun.env.TMPDIR ?? "/tmp"}/snippy-mat-${crypto.randomUUID()}`;
	await Bun.$`mkdir -p ${dir}`;
	tmpDirs.push(dir);
	return dir;
}
afterAll(async () => {
	for (const d of tmpDirs) await Bun.$`rm -rf ${d}`;
});

describe("MCP server: capabilities & metadata", () => {
	test("negotiates tool, resource, and prompt capabilities", async () => {
		const client = await makeClient();
		const caps = client.getServerCapabilities();
		expect(caps?.tools).toBeDefined();
		expect(caps?.resources).toBeDefined();
		expect(caps?.prompts).toBeDefined();
		await client.close();
	});

	test("advertises every expected tool", async () => {
		const client = await makeClient();
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(
			[
				"artifact.push",
				"artifact.get",
				"artifact.getByName",
				"artifact.list",
				"artifact.search",
				"artifact.tag",
				"artifact.untag",
				"artifact.delete",
				"artifact.rename",
				"artifact.history",
				"artifact.rollback",
				"artifact.render",
				"artifact.renderByName",
				"artifact.export",
				"artifact.import",
				"artifact.materialize",
				"artifact.materializeMany",
			].sort(),
		);
		await client.close();
	});

	test("advertises expected prompts", async () => {
		const client = await makeClient();
		const { prompts } = await client.listPrompts();
		expect(prompts.map((p) => p.name).sort()).toEqual(["apply-standard", "reuse-snippet"]);
		await client.close();
	});
});

describe("MCP tool: artifact.push + get + render", () => {
	let client: Client;
	beforeEach(async () => {
		client = await makeClient();
	});

	test("push creates and returns structuredContent", async () => {
		const result = await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "snippet",
				name: "hello",
				language: "typescript",
				description: "says hi",
				content: "console.log('hello ${name}');",
				variables: [{ name: "name", default: "world" }],
				tags: ["greeting"],
			},
		});
		expect(result.isError).toBeFalsy();
		const sc = result.structuredContent as {
			artifact: { name: string; tags: string[] };
			existed: boolean;
		};
		expect(sc.artifact.name).toBe("hello");
		expect(sc.artifact.tags).toEqual(["greeting"]);
		expect(sc.existed).toBe(false);
		await client.close();
	});

	test("push then render substitutes variables and applies defaults", async () => {
		await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "snippet",
				name: "greeter",
				language: "typescript",
				content: "hi ${name}, project=${project}",
				variables: [{ name: "name" }, { name: "project", default: "fallback" }],
				tags: [],
			},
		});
		const rendered = await client.callTool({
			name: "artifact.renderByName",
			arguments: {
				kind: "snippet",
				name: "greeter",
				bindings: { name: "Alice" },
			},
		});
		const sc = rendered.structuredContent as { content: string };
		expect(sc.content).toBe("hi Alice, project=fallback");
		await client.close();
	});

	test("render without required binding surfaces an error result", async () => {
		await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "snippet",
				name: "needy",
				content: "v=${v}",
				variables: [{ name: "v" }],
				tags: [],
			},
		});
		const result = await client.callTool({
			name: "artifact.renderByName",
			arguments: { kind: "snippet", name: "needy", bindings: {} },
		});
		expect(result.isError).toBe(true);
		const parts = result.content as { type: string; text?: string }[];
		const text = parts.map((p) => p.text ?? "").join("\n");
		expect(text).toMatch(/v/);
		await client.close();
	});
});

describe("MCP tool: list / search / tag / untag / delete", () => {
	test("list round-trips and tag filtering narrows results", async () => {
		const client = await makeClient();
		for (const name of ["alpha", "beta", "gamma"]) {
			await client.callTool({
				name: "artifact.push",
				arguments: {
					kind: "snippet",
					name,
					content: "x",
					tags: name === "alpha" ? ["star"] : [],
				},
			});
		}
		const all = (await client.callTool({ name: "artifact.list", arguments: {} }))
			.structuredContent as { artifacts: { name: string }[] };
		expect(all.artifacts.map((a) => a.name).sort()).toEqual(["alpha", "beta", "gamma"]);
		const starred = (
			await client.callTool({
				name: "artifact.list",
				arguments: { tags: ["star"] },
			})
		).structuredContent as { artifacts: { name: string }[] };
		expect(starred.artifacts.map((a) => a.name)).toEqual(["alpha"]);
		await client.close();
	});

	test("list defaults to summary mode (no content or variables, just size hints)", async () => {
		const client = await makeClient();
		await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "snippet",
				name: "heavy",
				content: "x".repeat(5000),
				variables: [{ name: "a" }, { name: "b" }],
			},
		});
		const res = (await client.callTool({ name: "artifact.list", arguments: {} }))
			.structuredContent as {
			summary: boolean;
			artifacts: {
				name: string;
				content?: string;
				variables?: unknown[];
				contentBytes: number;
				variableCount: number;
			}[];
		};
		expect(res.summary).toBe(true);
		const heavy = res.artifacts.find((a) => a.name === "heavy");
		expect(heavy).toBeDefined();
		if (heavy !== undefined) {
			expect(heavy.content).toBeUndefined();
			expect(heavy.variables).toBeUndefined();
			expect(heavy.contentBytes).toBe(5000);
			expect(heavy.variableCount).toBe(2);
		}
		await client.close();
	});

	test("list with summary:false includes full content and variables", async () => {
		const client = await makeClient();
		await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "snippet",
				name: "full",
				content: "hello",
				variables: [{ name: "a", default: "1" }],
			},
		});
		const res = (await client.callTool({ name: "artifact.list", arguments: { summary: false } }))
			.structuredContent as {
			summary: boolean;
			artifacts: { name: string; content?: string; variables?: { name: string }[] }[];
		};
		expect(res.summary).toBe(false);
		const full = res.artifacts.find((a) => a.name === "full");
		expect(full?.content).toBe("hello");
		expect(full?.variables?.[0]?.name).toBe("a");
		await client.close();
	});

	test("search honors the summary flag the same way", async () => {
		const client = await makeClient();
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "searchable", content: "findable needle body" },
		});
		const summary = (
			await client.callTool({ name: "artifact.search", arguments: { query: "needle" } })
		).structuredContent as {
			summary: boolean;
			artifacts: { content?: string; contentBytes: number }[];
		};
		expect(summary.summary).toBe(true);
		expect(summary.artifacts[0]?.content).toBeUndefined();
		expect(summary.artifacts[0]?.contentBytes).toBeGreaterThan(0);

		const full = (
			await client.callTool({
				name: "artifact.search",
				arguments: { query: "needle", summary: false },
			})
		).structuredContent as { artifacts: { content?: string }[] };
		expect(full.artifacts[0]?.content).toBe("findable needle body");
		await client.close();
	});

	test("search finds by content keyword", async () => {
		const client = await makeClient();
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "fox", content: "the quick brown fox" },
		});
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "latin", content: "lorem ipsum" },
		});
		const hits = (
			await client.callTool({
				name: "artifact.search",
				arguments: { query: "fox" },
			})
		).structuredContent as { artifacts: { name: string }[] };
		expect(hits.artifacts.map((a) => a.name)).toEqual(["fox"]);
		await client.close();
	});

	test("tag/untag roundtrip updates the artifact", async () => {
		const client = await makeClient();
		const pushed = (
			await client.callTool({
				name: "artifact.push",
				arguments: { kind: "snippet", name: "tt", content: "x" },
			})
		).structuredContent as { artifact: { id: string } };
		const id = pushed.artifact.id;
		const tagged = (
			await client.callTool({
				name: "artifact.tag",
				arguments: { id, tags: ["a", "b"] },
			})
		).structuredContent as { tags: string[] };
		expect(tagged.tags).toEqual(["a", "b"]);
		const untagged = (
			await client.callTool({
				name: "artifact.untag",
				arguments: { id, tags: ["a"] },
			})
		).structuredContent as { tags: string[] };
		expect(untagged.tags).toEqual(["b"]);
		await client.close();
	});

	test("delete removes the artifact", async () => {
		const client = await makeClient();
		const pushed = (
			await client.callTool({
				name: "artifact.push",
				arguments: { kind: "snippet", name: "gone", content: "x" },
			})
		).structuredContent as { artifact: { id: string } };
		const del = (
			await client.callTool({
				name: "artifact.delete",
				arguments: { id: pushed.artifact.id },
			})
		).structuredContent as { deleted: boolean };
		expect(del.deleted).toBe(true);
		await client.close();
	});
});

describe("MCP elicitation: artifact.materialize overwrite confirmation", () => {
	test("when the client supports elicitation, an overwrite is requested before clobbering", async () => {
		const root = await tmpDir();
		await Bun.write(`${root}/exists.ts`, "ORIGINAL");
		const db = openMemoryDb();
		const repo = new ArtifactRepo(db);
		const server = buildServer({ repo });
		const [clientTransport, serverTransport] = (
			await import("@modelcontextprotocol/sdk/inMemory.js")
		).InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);

		const { ElicitRequestSchema, ListRootsRequestSchema: ListRoots } = await import(
			"@modelcontextprotocol/sdk/types.js"
		);
		const client = new Client(
			{ name: "elicit-client", version: "0.0.0" },
			{ capabilities: { roots: {}, elicitation: {} } },
		);
		client.setRequestHandler(ListRoots, async () => ({
			roots: [{ uri: `file://${root}`, name: "root" }],
		}));
		let elicitMessage = "";
		client.setRequestHandler(ElicitRequestSchema, async (req) => {
			elicitMessage = req.params.message;
			return { action: "accept", content: { confirm: true } };
		});
		await client.connect(clientTransport);

		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "ovw", content: "REPLACED" },
		});
		const result = (
			await client.callTool({
				name: "artifact.materialize",
				arguments: {
					kind: "snippet",
					name: "ovw",
					path: `${root}/exists.ts`,
					conflict: "error",
				},
			})
		).structuredContent as { written: boolean };
		expect(result.written).toBe(true);
		expect(await Bun.file(`${root}/exists.ts`).text()).toBe("REPLACED");
		expect(elicitMessage).toContain("already exists");
		await client.close();
	});

	test("a 'decline' elicitation response surfaces the snippy.overwriteRefused error", async () => {
		const root = await tmpDir();
		await Bun.write(`${root}/keep.ts`, "ORIGINAL");
		const db = openMemoryDb();
		const repo = new ArtifactRepo(db);
		const server = buildServer({ repo });
		const [clientTransport, serverTransport] = (
			await import("@modelcontextprotocol/sdk/inMemory.js")
		).InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);

		const { ElicitRequestSchema, ListRootsRequestSchema: ListRoots } = await import(
			"@modelcontextprotocol/sdk/types.js"
		);
		const client = new Client(
			{ name: "elicit-decline", version: "0.0.0" },
			{ capabilities: { roots: {}, elicitation: {} } },
		);
		client.setRequestHandler(ListRoots, async () => ({
			roots: [{ uri: `file://${root}`, name: "root" }],
		}));
		client.setRequestHandler(ElicitRequestSchema, async () => ({
			action: "decline",
		}));
		await client.connect(clientTransport);

		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "k", content: "NEW" },
		});
		const res = await client.callTool({
			name: "artifact.materialize",
			arguments: {
				kind: "snippet",
				name: "k",
				path: `${root}/keep.ts`,
				conflict: "error",
			},
		});
		expect(res.isError).toBe(true);
		expect(await Bun.file(`${root}/keep.ts`).text()).toBe("ORIGINAL");
		await client.close();
	});
});

describe("MCP tool: artifact.rename", () => {
	test("rename exposes aliases on subsequent reads and makes old name resolvable", async () => {
		const client = await makeClient();
		const pushed = (
			await client.callTool({
				name: "artifact.push",
				arguments: { kind: "snippet", name: "foo", content: "x" },
			})
		).structuredContent as { artifact: { id: string } };
		const renamed = (
			await client.callTool({
				name: "artifact.rename",
				arguments: { id: pushed.artifact.id, newName: "bar" },
			})
		).structuredContent as {
			artifact: { id: string; name: string; aliases: string[] };
			previousName: string;
		};
		expect(renamed.artifact.name).toBe("bar");
		expect(renamed.artifact.aliases).toEqual(["foo"]);
		expect(renamed.previousName).toBe("foo");

		const byOld = (
			await client.callTool({
				name: "artifact.getByName",
				arguments: { kind: "snippet", name: "foo" },
			})
		).structuredContent as { artifact: { id: string } };
		expect(byOld.artifact.id).toBe(pushed.artifact.id);
		await client.close();
	});

	test("rename into an alias-occupied name reports AliasConflict as an error result", async () => {
		const client = await makeClient();
		const a = (
			await client.callTool({
				name: "artifact.push",
				arguments: { kind: "snippet", name: "a", content: "1" },
			})
		).structuredContent as { artifact: { id: string } };
		await client.callTool({
			name: "artifact.rename",
			arguments: { id: a.artifact.id, newName: "a2" },
		});
		const b = (
			await client.callTool({
				name: "artifact.push",
				arguments: { kind: "snippet", name: "b", content: "2" },
			})
		).structuredContent as { artifact: { id: string } };
		const conflict = await client.callTool({
			name: "artifact.rename",
			arguments: { id: b.artifact.id, newName: "a" },
		});
		expect(conflict.isError).toBe(true);
		await client.close();
	});
});

describe("MCP tool: artifact.history + artifact.rollback", () => {
	test("history returns revisions newest-first and rollback creates a new revision", async () => {
		const client = await makeClient();
		const pushed = (
			await client.callTool({
				name: "artifact.push",
				arguments: { kind: "snippet", name: "h", content: "v1" },
			})
		).structuredContent as { artifact: { id: string } };
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "h", content: "v2" },
		});
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "h", content: "v3" },
		});

		const hist = (
			await client.callTool({
				name: "artifact.history",
				arguments: { id: pushed.artifact.id, summary: false },
			})
		).structuredContent as {
			revisions: { version: number; content?: string }[];
		};
		expect(hist.revisions.map((r) => r.version)).toEqual([3, 2, 1]);
		expect(hist.revisions.map((r) => r.content)).toEqual(["v3", "v2", "v1"]);

		const back = (
			await client.callTool({
				name: "artifact.rollback",
				arguments: { id: pushed.artifact.id, toVersion: 1 },
			})
		).structuredContent as {
			artifact: { content: string };
			newVersion: number;
		};
		expect(back.artifact.content).toBe("v1");
		expect(back.newVersion).toBe(4);
		await client.close();
	});

	test("rollback to missing version is an error result", async () => {
		const client = await makeClient();
		const pushed = (
			await client.callTool({
				name: "artifact.push",
				arguments: { kind: "snippet", name: "m", content: "x" },
			})
		).structuredContent as { artifact: { id: string } };
		const res = await client.callTool({
			name: "artifact.rollback",
			arguments: { id: pushed.artifact.id, toVersion: 42 },
		});
		expect(res.isError).toBe(true);
		await client.close();
	});

	test("export includeHistory embeds _revisions; import includeHistory replaces history", async () => {
		const source = await makeClient();
		await source.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "e", content: "v1", tags: ["hist"] },
		});
		await source.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "e", content: "v2", tags: ["hist"] },
		});
		const exported = (
			await source.callTool({
				name: "artifact.export",
				arguments: { tags: ["hist"], includeHistory: true },
			})
		).structuredContent as { ndjson: string };
		const firstRow = JSON.parse(exported.ndjson.split("\n")[0] ?? "{}") as {
			_revisions?: { version: number; content: string }[];
		};
		expect(firstRow._revisions?.length).toBe(2);

		const target = await makeClient();
		await target.callTool({
			name: "artifact.import",
			arguments: { ndjson: exported.ndjson, conflict: "error", includeHistory: true },
		});
		const targetPushed = (
			await target.callTool({
				name: "artifact.getByName",
				arguments: { kind: "snippet", name: "e" },
			})
		).structuredContent as { artifact: { id: string } };
		const hist = (
			await target.callTool({
				name: "artifact.history",
				arguments: { id: targetPushed.artifact.id, summary: false },
			})
		).structuredContent as { revisions: { content: string }[] };
		expect(hist.revisions.map((r) => r.content)).toEqual(["v2", "v1"]);

		await source.close();
		await target.close();
	});
});

describe("MCP tool: export / import roundtrip", () => {
	test("export emits NDJSON and import rehydrates every artifact", async () => {
		const source = await makeClient();
		for (const name of ["a", "b", "c"]) {
			await source.callTool({
				name: "artifact.push",
				arguments: {
					kind: "snippet",
					name,
					language: "typescript",
					content: `console.log("${name}");`,
					tags: ["seed"],
				},
			});
		}
		const exported = (
			await source.callTool({
				name: "artifact.export",
				arguments: { tags: ["seed"] },
			})
		).structuredContent as { count: number; ndjson: string };
		expect(exported.count).toBe(3);

		const target = await makeClient();
		const imported = (
			await target.callTool({
				name: "artifact.import",
				arguments: { ndjson: exported.ndjson, conflict: "error" },
			})
		).structuredContent as {
			imported: number;
			skipped: number;
			overwritten: number;
			errors: unknown[];
		};
		expect(imported.imported).toBe(3);
		expect(imported.errors).toEqual([]);

		const listed = (await target.callTool({ name: "artifact.list", arguments: { tags: ["seed"] } }))
			.structuredContent as { artifacts: { name: string }[] };
		expect(listed.artifacts.map((a) => a.name).sort()).toEqual(["a", "b", "c"]);

		await source.close();
		await target.close();
	});

	test("export output does NOT include aliases field (aliases are a lookup artifact, not part of the portable shape)", async () => {
		const client = await makeClient();
		const { artifact } = (
			await client.callTool({
				name: "artifact.push",
				arguments: { kind: "snippet", name: "orig", content: "x", tags: ["exported"] },
			})
		).structuredContent as { artifact: { id: string } };
		await client.callTool({
			name: "artifact.rename",
			arguments: { id: artifact.id, newName: "after" },
		});
		const exported = (
			await client.callTool({
				name: "artifact.export",
				arguments: { tags: ["exported"] },
			})
		).structuredContent as { ndjson: string };
		for (const line of exported.ndjson.split("\n")) {
			const row = JSON.parse(line) as Record<string, unknown>;
			expect("aliases" in row).toBe(false);
		}
		await client.close();
	});

	test("import with conflict='skip' leaves existing artifacts untouched", async () => {
		const client = await makeClient();
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "keep", content: "original" },
		});
		const ndjson = JSON.stringify({ kind: "snippet", name: "keep", content: "replaced" });
		const result = (
			await client.callTool({
				name: "artifact.import",
				arguments: { ndjson, conflict: "skip" },
			})
		).structuredContent as { imported: number; skipped: number };
		expect(result.skipped).toBe(1);
		expect(result.imported).toBe(0);
		const fetched = (
			await client.callTool({
				name: "artifact.getByName",
				arguments: { kind: "snippet", name: "keep" },
			})
		).structuredContent as { artifact: { content: string } };
		expect(fetched.artifact.content).toBe("original");
		await client.close();
	});

	test("import collects per-line errors without aborting the batch", async () => {
		const client = await makeClient();
		const ndjson = [
			'{"kind":"snippet","name":"ok","content":"x"}',
			"not-json",
			'{"kind":"snippet"}',
		].join("\n");
		const result = (
			await client.callTool({
				name: "artifact.import",
				arguments: { ndjson, conflict: "error" },
			})
		).structuredContent as {
			imported: number;
			errors: { line: number }[];
		};
		expect(result.imported).toBe(1);
		expect(result.errors.map((e) => e.line).sort()).toEqual([2, 3]);
		await client.close();
	});
});

describe("MCP resource surface", () => {
	test("lists and reads artifacts as resources", async () => {
		const client = await makeClient();
		const push = (
			await client.callTool({
				name: "artifact.push",
				arguments: {
					kind: "snippet",
					name: "r1",
					language: "typescript",
					content: "export const n = 1;",
				},
			})
		).structuredContent as { artifact: { id: string } };
		const listed = await client.listResources();
		const uri = `snippet://default/snippet/${push.artifact.id}`;
		expect(listed.resources.some((r) => r.uri === uri)).toBe(true);
		const read = await client.readResource({ uri });
		const first = read.contents[0];
		expect(first).toBeDefined();
		if (first !== undefined && "text" in first) {
			expect(first.text).toBe("export const n = 1;");
			expect(first.mimeType).toBe("application/typescript");
		}
		await client.close();
	});
});

describe("MCP prompt surface", () => {
	test("apply-standard embeds the standard in a message", async () => {
		const client = await makeClient();
		await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "standard",
				name: "solid",
				description: "Do SOLID right",
				content: "S, O, L, I, D",
			},
		});
		const prompt = await client.getPrompt({
			name: "apply-standard",
			arguments: { name: "solid", targetLanguage: "typescript" },
		});
		expect(prompt.messages).toHaveLength(1);
		const first = prompt.messages[0];
		expect(first).toBeDefined();
		if (first !== undefined && first.content.type === "text") {
			expect(first.content.text).toContain("S, O, L, I, D");
			expect(first.content.text).toContain("typescript");
		}
		await client.close();
	});

	test("reuse-snippet renders with bindings and returns fenced code", async () => {
		const client = await makeClient();
		await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "snippet",
				name: "greet",
				language: "typescript",
				content: "console.log('hi ${name}');",
				variables: [{ name: "name" }],
			},
		});
		const prompt = await client.getPrompt({
			name: "reuse-snippet",
			arguments: { name: "greet", bindings: JSON.stringify({ name: "Alice" }) },
		});
		const first = prompt.messages[0];
		expect(first).toBeDefined();
		if (first !== undefined && first.content.type === "text") {
			expect(first.content.text).toContain("console.log('hi Alice');");
			expect(first.content.text).toContain("```typescript");
		}
		await client.close();
	});
});

describe("MCP tool: artifact.materialize (roots-gated)", () => {
	test("writes the artifact to disk inside an allowed root and returns no body", async () => {
		const root = await tmpDir();
		const client = await makeClientWithRoots([root]);
		await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "snippet",
				name: "say-hi",
				language: "typescript",
				content: 'console.log("hi ${who}");',
				variables: [{ name: "who" }],
			},
		});
		const target = `${root}/out/say-hi.ts`;
		const result = (
			await client.callTool({
				name: "artifact.materialize",
				arguments: {
					kind: "snippet",
					name: "say-hi",
					path: target,
					bindings: { who: "World" },
				},
			})
		).structuredContent as {
			path: string;
			bytes: number;
			sha256: string;
			written: boolean;
			rootSource: string;
		};
		expect(result.written).toBe(true);
		expect(result.path).toBe(target);
		expect(result.rootSource).toBe("client");
		const onDisk = await Bun.file(target).text();
		expect(onDisk).toBe('console.log("hi World");');
		// no `content` field in structuredContent — the file body never travels back through the protocol
		expect(Object.keys(result)).not.toContain("content");
		await client.close();
	});

	test("rejects writes outside the advertised root", async () => {
		const root = await tmpDir();
		const client = await makeClientWithRoots([root]);
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "x", content: "ok" },
		});
		const escaped = `${root}/../escape.ts`;
		const result = await client.callTool({
			name: "artifact.materialize",
			arguments: { kind: "snippet", name: "x", path: escaped },
		});
		expect(result.isError).toBe(true);
		const text = (result.content as { text?: string }[]).map((p) => p.text ?? "").join("\n");
		expect(text).toMatch(/outside the allowed roots/);
		await client.close();
	});

	test("rejects when no roots are advertised at all", async () => {
		const client = await makeClient();
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "x", content: "ok" },
		});
		const result = await client.callTool({
			name: "artifact.materialize",
			arguments: { kind: "snippet", name: "x", path: "/tmp/whatever.ts" },
		});
		expect(result.isError).toBe(true);
		const text = (result.content as { text?: string }[]).map((p) => p.text ?? "").join("\n");
		expect(text).toMatch(/No allowed roots/);
		await client.close();
	});

	test("conflict=skip leaves the existing file untouched", async () => {
		const root = await tmpDir();
		const client = await makeClientWithRoots([root]);
		await Bun.write(`${root}/keep.ts`, "ORIGINAL");
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "k", content: "REPLACED" },
		});
		const res = (
			await client.callTool({
				name: "artifact.materialize",
				arguments: {
					kind: "snippet",
					name: "k",
					path: `${root}/keep.ts`,
					conflict: "skip",
				},
			})
		).structuredContent as { written: boolean; existed: boolean };
		expect(res.written).toBe(false);
		expect(res.existed).toBe(true);
		expect(await Bun.file(`${root}/keep.ts`).text()).toBe("ORIGINAL");
		await client.close();
	});

	test("conflict=error refuses to clobber", async () => {
		const root = await tmpDir();
		const client = await makeClientWithRoots([root]);
		await Bun.write(`${root}/exists.ts`, "ORIGINAL");
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "e", content: "x" },
		});
		const result = await client.callTool({
			name: "artifact.materialize",
			arguments: {
				kind: "snippet",
				name: "e",
				path: `${root}/exists.ts`,
				conflict: "error",
			},
		});
		expect(result.isError).toBe(true);
		await client.close();
	});

	test("chmodX makes the file executable", async () => {
		const root = await tmpDir();
		const client = await makeClientWithRoots([root]);
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "tool", content: "#!/usr/bin/env bun\n" },
		});
		await client.callTool({
			name: "artifact.materialize",
			arguments: {
				kind: "snippet",
				name: "tool",
				path: `${root}/tool.ts`,
				chmodX: true,
			},
		});
		const stat = await Bun.file(`${root}/tool.ts`).stat();
		// owner-execute bit
		expect((stat.mode & 0o100) !== 0).toBe(true);
		await client.close();
	});
});

describe("MCP tool: artifact.materializeMany", () => {
	test("writes a tagged batch into a directory and reports per-artifact results", async () => {
		const root = await tmpDir();
		const client = await makeClientWithRoots([root]);
		for (const name of ["alpha", "beta", "gamma"]) {
			await client.callTool({
				name: "artifact.push",
				arguments: {
					kind: "snippet",
					name,
					language: "typescript",
					content: `export const n = "${name}";`,
					tags: ["seed"],
				},
			});
		}
		const result = (
			await client.callTool({
				name: "artifact.materializeMany",
				arguments: {
					tags: ["seed"],
					dir: `${root}/seeded`,
					conflict: "overwrite",
				},
			})
		).structuredContent as {
			written: { name: string; path: string }[];
			skipped: unknown[];
			errors: unknown[];
		};
		expect(result.errors).toEqual([]);
		expect(result.skipped).toEqual([]);
		const names = result.written.map((w) => w.name).sort();
		expect(names).toEqual(["alpha", "beta", "gamma"]);
		for (const w of result.written) {
			const exists = await Bun.file(w.path).exists();
			expect(exists).toBe(true);
			expect(w.path.endsWith(".ts")).toBe(true);
		}
		await client.close();
	});
});
