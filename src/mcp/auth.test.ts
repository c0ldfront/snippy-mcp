import { describe, expect, test } from "bun:test";
import { lookupRole, parseTokens, roleAllows, TOOL_REQUIRED_ROLES } from "./auth.ts";

describe("parseTokens", () => {
	test("returns disabled token map when env is unset/empty", () => {
		expect(parseTokens(undefined).enabled).toBe(false);
		expect(parseTokens("").enabled).toBe(false);
	});

	test("parses 'token:role' pairs separated by commas", () => {
		const tokens = parseTokens("alice:admin,bob:writer,carol:reader");
		expect(tokens.enabled).toBe(true);
		expect(tokens.map.get("alice")).toBe("admin");
		expect(tokens.map.get("bob")).toBe("writer");
		expect(tokens.map.get("carol")).toBe("reader");
	});

	test("supports tokens that contain colons (only splits on the last colon)", () => {
		const tokens = parseTokens("base64:abc:def:writer");
		expect(tokens.map.get("base64:abc:def")).toBe("writer");
	});

	test("rejects unknown roles", () => {
		expect(() => parseTokens("x:guest")).toThrow();
	});

	test("rejects malformed entries", () => {
		expect(() => parseTokens("just-a-token")).toThrow();
		expect(() => parseTokens(":admin")).toThrow();
		expect(() => parseTokens("tok:")).toThrow();
	});
});

describe("lookupRole", () => {
	test("disabled token map → admin role for all callers", () => {
		const tokens = parseTokens(undefined);
		expect(lookupRole(tokens, null)).toBe("admin");
		expect(lookupRole(tokens, "anything")).toBe("admin");
	});

	test("missing or malformed Authorization header → null", () => {
		const tokens = parseTokens("alice:writer");
		expect(lookupRole(tokens, null)).toBeNull();
		expect(lookupRole(tokens, "Basic xyz")).toBeNull();
		expect(lookupRole(tokens, "Bearer ")).toBeNull();
	});

	test("Bearer match → declared role; mismatch → null", () => {
		const tokens = parseTokens("alice:writer");
		expect(lookupRole(tokens, "Bearer alice")).toBe("writer");
		expect(lookupRole(tokens, "bearer alice")).toBe("writer");
		expect(lookupRole(tokens, "Bearer mallory")).toBeNull();
	});
});

describe("roleAllows", () => {
	test("admin > writer > reader", () => {
		expect(roleAllows("admin", "reader")).toBe(true);
		expect(roleAllows("admin", "writer")).toBe(true);
		expect(roleAllows("admin", "admin")).toBe(true);
		expect(roleAllows("writer", "reader")).toBe(true);
		expect(roleAllows("writer", "admin")).toBe(false);
		expect(roleAllows("reader", "writer")).toBe(false);
		expect(roleAllows("reader", "admin")).toBe(false);
	});
});

describe("TOOL_REQUIRED_ROLES", () => {
	test("destructive operations require admin", () => {
		expect(TOOL_REQUIRED_ROLES["artifact.delete"]).toBe("admin");
		expect(TOOL_REQUIRED_ROLES["artifact.import"]).toBe("admin");
		expect(TOOL_REQUIRED_ROLES["artifact.materialize"]).toBe("admin");
		expect(TOOL_REQUIRED_ROLES["artifact.materializeMany"]).toBe("admin");
		expect(TOOL_REQUIRED_ROLES["artifact.rollback"]).toBe("admin");
	});

	test("plain reads are reader-grade", () => {
		expect(TOOL_REQUIRED_ROLES["artifact.list"]).toBe("reader");
		expect(TOOL_REQUIRED_ROLES["artifact.search"]).toBe("reader");
		expect(TOOL_REQUIRED_ROLES["artifact.history"]).toBe("reader");
	});

	test("non-destructive mutations are writer-grade", () => {
		expect(TOOL_REQUIRED_ROLES["artifact.push"]).toBe("writer");
		expect(TOOL_REQUIRED_ROLES["artifact.tag"]).toBe("writer");
		expect(TOOL_REQUIRED_ROLES["artifact.rename"]).toBe("writer");
	});
});
