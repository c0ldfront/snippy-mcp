import { describe, expect, test } from "bun:test";
import { ensurePathAllowed, isPathInsideRoot } from "./roots.ts";

describe("isPathInsideRoot", () => {
	test("matches the root itself and its descendants", () => {
		expect(isPathInsideRoot("/a/b", "/a/b")).toBe(true);
		expect(isPathInsideRoot("/a/b/c", "/a/b")).toBe(true);
	});
	test("rejects siblings whose name starts with the root", () => {
		expect(isPathInsideRoot("/a/bc", "/a/b")).toBe(false);
	});
	test("rejects parent directories", () => {
		expect(isPathInsideRoot("/a", "/a/b")).toBe(false);
	});
});

describe("ensurePathAllowed", () => {
	test("returns absolute path when inside an allowed root", () => {
		const abs = ensurePathAllowed("/tmp/foo/bar.ts", {
			source: "env",
			roots: ["/tmp/foo"],
		});
		expect(abs).toBe("/tmp/foo/bar.ts");
	});
	test("throws when no roots are configured", () => {
		expect(() => ensurePathAllowed("/anything", { source: "none", roots: [] })).toThrow(
			/No allowed roots/,
		);
	});
	test("throws when path is outside every root", () => {
		expect(() => ensurePathAllowed("/etc/passwd", { source: "env", roots: ["/tmp/foo"] })).toThrow(
			/outside the allowed roots/,
		);
	});
	test("blocks .. traversal that escapes a root", () => {
		expect(() =>
			ensurePathAllowed("/tmp/foo/../../etc/passwd", {
				source: "env",
				roots: ["/tmp/foo"],
			}),
		).toThrow(/outside the allowed roots/);
	});
});
