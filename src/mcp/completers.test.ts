import { beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "../db/connection.ts";
import { openMemoryDb } from "../db/connection.ts";
import { ArtifactRepo } from "../repo/artifact-repo.ts";
import { buildCompleters } from "./completers.ts";

describe("completers", () => {
	let db: Db;
	let repo: ArtifactRepo;

	beforeEach(() => {
		db = openMemoryDb();
		repo = new ArtifactRepo(db);
	});

	test("completeArtifactName narrows by kind when context provided", () => {
		repo.push({
			kind: "snippet",
			name: "alpha-snip",
			language: null,
			description: "",
			content: "x",
			variables: [],
			tags: [],
			dryRun: false,
		});
		repo.push({
			kind: "standard",
			name: "alpha-std",
			language: null,
			description: "",
			content: "x",
			variables: [],
			tags: [],
			dryRun: false,
		});
		const c = buildCompleters(db);
		expect(c.completeArtifactName("alpha", { arguments: { kind: "snippet" } })).toEqual([
			"alpha-snip",
		]);
		expect(c.completeArtifactName("alpha")).toEqual(
			expect.arrayContaining(["alpha-snip", "alpha-std"]),
		);
	});

	test("completeArtifactName surfaces aliases", () => {
		const { artifact } = repo.push({
			kind: "snippet",
			name: "before-name",
			language: null,
			description: "",
			content: "x",
			variables: [],
			tags: [],
			dryRun: false,
		});
		repo.rename(artifact.id, "after-name");
		const c = buildCompleters(db);
		const names = c.completeArtifactName("be", { arguments: { kind: "snippet" } });
		expect(names).toContain("before-name");
	});

	test("completeId returns id prefixes", () => {
		const { artifact } = repo.push({
			kind: "snippet",
			name: "x",
			language: null,
			description: "",
			content: "x",
			variables: [],
			tags: [],
			dryRun: false,
		});
		const c = buildCompleters(db);
		const ids = c.completeId(artifact.id.slice(0, 3));
		expect(ids).toContain(artifact.id);
	});

	test("completeTag returns distinct matching tags", () => {
		repo.push({
			kind: "snippet",
			name: "a",
			language: null,
			description: "",
			content: "x",
			variables: [],
			tags: ["alpha", "beta"],
			dryRun: false,
		});
		repo.push({
			kind: "snippet",
			name: "b",
			language: null,
			description: "",
			content: "x",
			variables: [],
			tags: ["alpha", "gamma"],
			dryRun: false,
		});
		const c = buildCompleters(db);
		expect(c.completeTag("a")).toEqual(["alpha"]);
		expect(c.completeTag("")).toEqual(expect.arrayContaining(["alpha", "beta", "gamma"]));
	});

	test("LIKE special characters in input are escaped (no SQL injection / wildcards)", () => {
		repo.push({
			kind: "snippet",
			name: "literal-pct",
			language: null,
			description: "",
			content: "x",
			variables: [],
			tags: [],
			dryRun: false,
		});
		const c = buildCompleters(db);
		// '%' should NOT match "literal-pct" — it should be treated literally.
		expect(c.completeArtifactName("%")).toEqual([]);
	});
});
