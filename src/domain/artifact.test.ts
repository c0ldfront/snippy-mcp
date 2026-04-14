import { describe, expect, test } from "bun:test";
import {
	ArtifactNameSchema,
	ArtifactSchema,
	artifactIdentity,
	extractTemplateVariables,
	isKind,
	PushInputSchema,
	TagSchema,
	VariableSchema,
} from "./artifact.ts";

describe("KindSchema / isKind", () => {
	test("accepts the three supported kinds", () => {
		expect(isKind("standard")).toBe(true);
		expect(isKind("snippet")).toBe(true);
		expect(isKind("resource")).toBe(true);
	});
	test("rejects unknown strings and non-strings", () => {
		expect(isKind("prompt")).toBe(false);
		expect(isKind(42)).toBe(false);
		expect(isKind(null)).toBe(false);
	});
});

describe("ArtifactNameSchema", () => {
	test("accepts lowercase alphanumeric with . _ -", () => {
		expect(() => ArtifactNameSchema.parse("bun.test-setup_v1")).not.toThrow();
	});
	test("rejects uppercase, spaces, and empty", () => {
		expect(() => ArtifactNameSchema.parse("BadName")).toThrow();
		expect(() => ArtifactNameSchema.parse("has space")).toThrow();
		expect(() => ArtifactNameSchema.parse("")).toThrow();
	});
});

describe("TagSchema", () => {
	test("accepts lowercase hyphenated tags", () => {
		expect(TagSchema.parse("typescript")).toBe("typescript");
		expect(TagSchema.parse("react-hooks")).toBe("react-hooks");
	});
	test("rejects tags with underscores or uppercase", () => {
		expect(() => TagSchema.parse("foo_bar")).toThrow();
		expect(() => TagSchema.parse("Foo")).toThrow();
	});
});

describe("VariableSchema", () => {
	test("accepts identifier-style names", () => {
		expect(() => VariableSchema.parse({ name: "projectName" })).not.toThrow();
	});
	test("rejects names starting with a digit", () => {
		expect(() => VariableSchema.parse({ name: "1bad" })).toThrow();
	});
});

describe("ArtifactSchema", () => {
	test("parses a full artifact", () => {
		const a = ArtifactSchema.parse({
			id: "01H",
			kind: "snippet",
			name: "bun-test-hello",
			language: "typescript",
			description: "",
			content: 'import { test, expect } from "bun:test";',
			variables: [],
			tags: ["bun", "test"],
			aliases: [],
			createdAt: 0,
			updatedAt: 0,
		});
		expect(a.tags).toEqual(["bun", "test"]);
		expect(a.aliases).toEqual([]);
	});
});

describe("PushInputSchema", () => {
	test("applies defaults for optional fields", () => {
		const parsed = PushInputSchema.parse({
			kind: "standard",
			name: "solid-dry",
			content: "...",
		});
		expect(parsed.language).toBe(null);
		expect(parsed.description).toBe("");
		expect(parsed.variables).toEqual([]);
		expect(parsed.tags).toEqual([]);
		expect(parsed.dryRun).toBe(false);
	});
});

describe("artifactIdentity", () => {
	test("builds kind/name composite", () => {
		expect(artifactIdentity({ kind: "snippet", name: "foo" })).toBe("snippet/foo");
	});
});

describe("extractTemplateVariables", () => {
	test("returns unique variable names in first-seen order", () => {
		const vars = extractTemplateVariables("hello ${name}, id=${id}, again=${name}");
		expect(vars).toEqual(["name", "id"]);
	});
	test("returns empty array when no placeholders", () => {
		expect(extractTemplateVariables("static content")).toEqual([]);
	});
	test("ignores malformed braces", () => {
		expect(extractTemplateVariables("$name and ${ } and ${1bad}")).toEqual([]);
	});
});
