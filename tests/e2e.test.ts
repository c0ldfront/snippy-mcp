import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tmpDir = `${Bun.env.TMPDIR ?? "/tmp"}/snippy-mcp-e2e-${crypto.randomUUID()}`;
const dbPath = `${tmpDir}/snippy.db`;
const writeRoot = `${tmpDir}/repo`;

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
	await Bun.$`mkdir -p ${tmpDir} ${writeRoot}`;
	transport = new StdioClientTransport({
		command: "bun",
		args: ["run", `${import.meta.dir}/../src/cli.ts`],
		env: {
			...process.env,
			SNIPPY_DB: dbPath,
			SNIPPY_ROOTS: writeRoot,
		} as Record<string, string>,
		stderr: "inherit",
	});
	client = new Client(
		{ name: "snippy-mcp-e2e", version: "0.0.0" },
		{ capabilities: { roots: {} } },
	);
	client.setRequestHandler(ListRootsRequestSchema, async () => ({
		roots: [{ uri: `file://${writeRoot}`, name: "repo" }],
	}));
	await client.connect(transport);
});

afterAll(async () => {
	await client.close();
	await transport.close();
	await Bun.$`rm -rf ${tmpDir}`;
});

describe("e2e: snippy-mcp over stdio", () => {
	test("server advertises every tool, prompt, and the resource template", async () => {
		const tools = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(tools).toEqual(
			[
				"artifact.delete",
				"artifact.export",
				"artifact.get",
				"artifact.getByName",
				"artifact.history",
				"artifact.import",
				"artifact.list",
				"artifact.materialize",
				"artifact.materializeMany",
				"artifact.push",
				"artifact.rename",
				"artifact.render",
				"artifact.renderByName",
				"artifact.rollback",
				"artifact.search",
				"artifact.tag",
				"artifact.untag",
			].sort(),
		);
		const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
		expect(prompts).toEqual(["apply-standard", "reuse-snippet"]);
		const templates = (await client.listResourceTemplates()).resourceTemplates;
		expect(templates.some((t) => t.uriTemplate === "snippet://{workspace}/{kind}/{id}")).toBe(true);
	});

	test("push → list → search → tag → untag → delete round trip", async () => {
		const pushRes = await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "snippet",
				name: "bun-test-skel",
				language: "typescript",
				description: "Skeleton bun:test",
				content: 'import { test, expect } from "bun:test";\ntest("${case}", () => {});',
				variables: [{ name: "case", default: "smoke" }],
				tags: ["bun", "test"],
			},
		});
		expect(pushRes.isError).toBeFalsy();
		const pushed = pushRes.structuredContent as {
			artifact: { id: string; tags: string[] };
			existed: boolean;
		};
		expect(pushed.existed).toBe(false);
		const id = pushed.artifact.id;

		const listed = (
			await client.callTool({
				name: "artifact.list",
				arguments: { kind: "snippet", tags: ["bun"] },
			})
		).structuredContent as { artifacts: { id: string }[] };
		expect(listed.artifacts.some((a) => a.id === id)).toBe(true);

		const search = (
			await client.callTool({
				name: "artifact.search",
				arguments: { query: "skeleton" },
			})
		).structuredContent as { artifacts: { id: string }[] };
		expect(search.artifacts.some((a) => a.id === id)).toBe(true);

		const tagged = (
			await client.callTool({
				name: "artifact.tag",
				arguments: { id, tags: ["smoke"] },
			})
		).structuredContent as { tags: string[] };
		expect(tagged.tags).toEqual(["bun", "smoke", "test"]);

		const untagged = (
			await client.callTool({
				name: "artifact.untag",
				arguments: { id, tags: ["smoke"] },
			})
		).structuredContent as { tags: string[] };
		expect(untagged.tags).toEqual(["bun", "test"]);

		const deleted = (
			await client.callTool({
				name: "artifact.delete",
				arguments: { id },
			})
		).structuredContent as { deleted: boolean };
		expect(deleted.deleted).toBe(true);
	});

	test("render and renderByName apply variable substitution", async () => {
		await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "snippet",
				name: "render-target",
				content: "name=${who}",
				variables: [{ name: "who" }],
			},
		});
		const rendered = (
			await client.callTool({
				name: "artifact.renderByName",
				arguments: { kind: "snippet", name: "render-target", bindings: { who: "Bob" } },
			})
		).structuredContent as { content: string };
		expect(rendered.content).toBe("name=Bob");
	});

	test("resource read returns artifact content", async () => {
		const pushed = (
			await client.callTool({
				name: "artifact.push",
				arguments: {
					kind: "resource",
					name: "license",
					language: null,
					content: "MIT",
				},
			})
		).structuredContent as { artifact: { id: string } };
		const uri = `snippet://default/resource/${pushed.artifact.id}`;
		const res = await client.readResource({ uri });
		const first = res.contents[0];
		expect(first).toBeDefined();
		if (first !== undefined && "text" in first) {
			expect(first.text).toBe("MIT");
			expect(first.mimeType).toBe("text/plain");
		}
	});

	test("apply-standard prompt embeds the standard", async () => {
		await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "standard",
				name: "no-any",
				description: "Forbid TS any",
				content: "Use unknown + narrowing instead of any.",
			},
		});
		const prompt = await client.getPrompt({
			name: "apply-standard",
			arguments: { name: "no-any", targetLanguage: "typescript" },
		});
		expect(prompt.messages).toHaveLength(1);
		const first = prompt.messages[0];
		expect(first).toBeDefined();
		if (first !== undefined && first.content.type === "text") {
			expect(first.content.text).toContain("unknown");
			expect(first.content.text).toContain("typescript");
		}
	});

	test("reuse-snippet prompt renders bindings into a fenced code block", async () => {
		await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "snippet",
				name: "log-call",
				language: "typescript",
				content: 'console.log("${msg}");',
				variables: [{ name: "msg" }],
			},
		});
		const prompt = await client.getPrompt({
			name: "reuse-snippet",
			arguments: {
				name: "log-call",
				bindings: JSON.stringify({ msg: "hi" }),
			},
		});
		const first = prompt.messages[0];
		expect(first).toBeDefined();
		if (first !== undefined && first.content.type === "text") {
			expect(first.content.text).toContain('console.log("hi");');
			expect(first.content.text).toContain("```typescript");
		}
	});

	test("artifact.materialize writes a file inside the advertised root via the spawned binary", async () => {
		await client.callTool({
			name: "artifact.push",
			arguments: {
				kind: "snippet",
				name: "round-trip",
				language: "typescript",
				content: "export const v = ${value};",
				variables: [{ name: "value" }],
			},
		});
		const target = `${writeRoot}/out/round-trip.ts`;
		const res = (
			await client.callTool({
				name: "artifact.materialize",
				arguments: {
					kind: "snippet",
					name: "round-trip",
					path: target,
					bindings: { value: "42" },
					conflict: "overwrite",
				},
			})
		).structuredContent as { written: boolean; path: string; rootSource: string };
		expect(res.written).toBe(true);
		expect(res.rootSource).toBe("client");
		expect(await Bun.file(target).text()).toBe("export const v = 42;");
	});

	test("artifact.rename registers old name as alias and keeps getByName working", async () => {
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "renameable", content: "x" },
		});
		const before = (
			await client.callTool({
				name: "artifact.getByName",
				arguments: { kind: "snippet", name: "renameable" },
			})
		).structuredContent as { artifact: { id: string; aliases: string[] } };
		expect(before.artifact.aliases).toEqual([]);

		const renamed = (
			await client.callTool({
				name: "artifact.rename",
				arguments: { id: before.artifact.id, newName: "renamed-to" },
			})
		).structuredContent as {
			artifact: { id: string; name: string; aliases: string[] };
			previousName: string;
		};
		expect(renamed.previousName).toBe("renameable");
		expect(renamed.artifact.name).toBe("renamed-to");
		expect(renamed.artifact.aliases).toEqual(["renameable"]);

		const byOld = (
			await client.callTool({
				name: "artifact.getByName",
				arguments: { kind: "snippet", name: "renameable" },
			})
		).structuredContent as { artifact: { id: string } };
		expect(byOld.artifact.id).toBe(before.artifact.id);

		const rePush = await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "renameable", content: "other" },
		});
		expect(rePush.isError).toBe(true);
	});

	test("artifact.materialize refuses paths outside the advertised root", async () => {
		await client.callTool({
			name: "artifact.push",
			arguments: { kind: "snippet", name: "blocked", content: "x" },
		});
		const result = await client.callTool({
			name: "artifact.materialize",
			arguments: {
				kind: "snippet",
				name: "blocked",
				path: "/etc/passwd",
				conflict: "overwrite",
			},
		});
		expect(result.isError).toBe(true);
	});
});
