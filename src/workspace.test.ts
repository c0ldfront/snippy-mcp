import { afterEach, describe, expect, test } from "bun:test";
import { parseWorkspaces, WorkspaceRegistry } from "./workspace.ts";

const tmpFiles: string[] = [];
function tmpDb(): string {
	const path = `${Bun.env.TMPDIR ?? "/tmp"}/snippy-ws-${crypto.randomUUID()}.db`;
	tmpFiles.push(path);
	return path;
}
afterEach(async () => {
	for (const f of tmpFiles.splice(0)) await Bun.$`rm -f ${f}`.quiet();
});

describe("parseWorkspaces", () => {
	test("falls back to a single 'default' workspace when env is missing", () => {
		const map = parseWorkspaces(undefined, "/tmp/fallback.db");
		expect([...map.keys()]).toEqual(["default"]);
		expect(map.get("default")?.dbPath).toBe("/tmp/fallback.db");
	});

	test("parses a JSON map and ensures 'default' is always present", () => {
		const map = parseWorkspaces(
			JSON.stringify({ team: "/tmp/team.db", personal: "/tmp/personal.db" }),
			"/tmp/fb.db",
		);
		expect(map.has("team")).toBe(true);
		expect(map.has("personal")).toBe(true);
		expect(map.get("default")?.dbPath).toBe("/tmp/fb.db");
	});

	test("rejects malformed JSON", () => {
		expect(() => parseWorkspaces("not-json", "/tmp/fb.db")).toThrow();
	});

	test("rejects invalid workspace identifiers", () => {
		expect(() =>
			parseWorkspaces(JSON.stringify({ "BadName!": "/tmp/x.db" }), "/tmp/fb.db"),
		).toThrow();
	});

	test("rejects non-string db paths", () => {
		expect(() => parseWorkspaces(JSON.stringify({ team: 42 }), "/tmp/fb.db")).toThrow();
	});
});

describe("WorkspaceRegistry", () => {
	test("opens distinct DBs per workspace lazily and caches them", () => {
		const dbA = tmpDb();
		const dbB = tmpDb();
		const registry = new WorkspaceRegistry(
			parseWorkspaces(JSON.stringify({ a: dbA, b: dbB }), tmpDb()),
		);
		expect(registry.has("a")).toBe(true);
		expect(registry.has("b")).toBe(true);
		expect(registry.has("nope")).toBe(false);

		const wsA1 = registry.get("a");
		const wsA2 = registry.get("a");
		expect(wsA1).toBe(wsA2); // cached

		// distinct DBs → independent state
		wsA1.repo.push({
			kind: "snippet",
			name: "in-a-only",
			language: null,
			description: "",
			content: "x",
			variables: [],
			tags: [],
			dryRun: false,
		});
		const wsB = registry.get("b");
		expect(wsB.repo.getByName("snippet", "in-a-only")).toBeNull();

		registry.closeAll();
	});

	test("get() throws on unknown workspace", () => {
		const registry = new WorkspaceRegistry(parseWorkspaces(undefined, tmpDb()));
		expect(() => registry.get("nope")).toThrow();
	});

	test("names() returns all declared workspaces, sorted", () => {
		const registry = new WorkspaceRegistry(
			parseWorkspaces(JSON.stringify({ zeta: tmpDb(), alpha: tmpDb() }), tmpDb()),
		);
		expect(registry.names()).toEqual(["alpha", "default", "zeta"]);
	});
});
