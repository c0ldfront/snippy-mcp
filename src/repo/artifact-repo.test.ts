import { beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "../db/connection.ts";
import { openMemoryDb } from "../db/connection.ts";
import type { PushInput } from "../domain/artifact.ts";
import {
	AliasConflictError,
	ArtifactNotFoundError,
	ArtifactRepo,
	type Clock,
	NameTakenError,
	RevisionMissingError,
} from "./artifact-repo.ts";

function fixedClock(start = 1_700_000_000_000): Clock & { advance(ms: number): void } {
	let t = start;
	return {
		now: () => t,
		advance(ms: number): void {
			t += ms;
		},
	};
}

function push(repo: ArtifactRepo, overrides: Partial<PushInput> = {}) {
	const input: PushInput = {
		kind: "snippet",
		name: overrides.name ?? "hello-world",
		language: overrides.language ?? "typescript",
		description: overrides.description ?? "",
		content: overrides.content ?? 'console.log("hi");',
		variables: overrides.variables ?? [],
		tags: overrides.tags ?? [],
		dryRun: overrides.dryRun ?? false,
		...overrides,
	};
	return repo.push(input);
}

describe("ArtifactRepo.push", () => {
	let db: Db;
	let repo: ArtifactRepo;
	beforeEach(() => {
		db = openMemoryDb();
		repo = new ArtifactRepo(db, fixedClock());
	});

	test("creates a new artifact and reports existed=false", () => {
		const res = push(repo, { name: "a", tags: ["ts", "bun"] });
		expect(res.existed).toBe(false);
		expect(res.previousUpdatedAt).toBeNull();
		expect(res.artifact.name).toBe("a");
		expect(res.artifact.tags).toEqual(["bun", "ts"]);
	});

	test("upserts an existing (kind, name) and reports existed=true with prior updatedAt", () => {
		const clock = fixedClock(1000);
		const r = new ArtifactRepo(db, clock);
		const first = push(r, { name: "a", content: "v1" });
		clock.advance(500);
		const second = push(r, { name: "a", content: "v2" });
		expect(second.existed).toBe(true);
		expect(second.previousUpdatedAt).toBe(first.artifact.updatedAt);
		expect(second.artifact.content).toBe("v2");
		expect(second.artifact.id).toBe(first.artifact.id);
	});

	test("dryRun does not persist", () => {
		const res = push(repo, { name: "ghost", dryRun: true });
		expect(res.dryRun).toBe(true);
		expect(repo.getByName("snippet", "ghost")).toBeNull();
	});

	test("rejects malformed tags", () => {
		expect(() => push(repo, { name: "bad", tags: ["UPPERCASE"] })).toThrow();
	});
});

describe("ArtifactRepo.getById / getByName / delete", () => {
	test("getByName returns null when not present", () => {
		const repo = new ArtifactRepo(openMemoryDb(), fixedClock());
		expect(repo.getByName("snippet", "missing")).toBeNull();
	});

	test("delete removes artifact and cascades tags", () => {
		const db = openMemoryDb();
		const repo = new ArtifactRepo(db, fixedClock());
		const { artifact } = push(repo, { name: "gone", tags: ["a", "b"] });
		expect(repo.delete(artifact.id)).toBe(true);
		expect(repo.getById(artifact.id)).toBeNull();
		const remaining = db.query("SELECT COUNT(*) AS n FROM tags").get() as { n: number };
		expect(remaining.n).toBe(0);
	});

	test("delete returns false when id does not exist", () => {
		const repo = new ArtifactRepo(openMemoryDb(), fixedClock());
		expect(repo.delete("nope")).toBe(false);
	});
});

describe("ArtifactRepo tag ops", () => {
	test("addTags is idempotent and returns sorted tags", () => {
		const repo = new ArtifactRepo(openMemoryDb(), fixedClock());
		const { artifact } = push(repo, { tags: ["b"] });
		const tags = repo.addTags(artifact.id, ["a", "b", "c"]);
		expect(tags).toEqual(["a", "b", "c"]);
	});

	test("removeTags drops requested tags only", () => {
		const repo = new ArtifactRepo(openMemoryDb(), fixedClock());
		const { artifact } = push(repo, { tags: ["a", "b", "c"] });
		const tags = repo.removeTags(artifact.id, ["b", "missing"]);
		expect(tags).toEqual(["a", "c"]);
	});
});

describe("ArtifactRepo.list", () => {
	test("filters by kind", () => {
		const clock = fixedClock();
		const repo = new ArtifactRepo(openMemoryDb(), clock);
		push(repo, { kind: "snippet", name: "s1" });
		clock.advance(10);
		push(repo, { kind: "standard", name: "s2" });
		const page = repo.list({ kind: "standard" });
		expect(page.artifacts.map((a) => a.name)).toEqual(["s2"]);
	});

	test("filters by tag (AND semantics across multiple tags)", () => {
		const clock = fixedClock();
		const repo = new ArtifactRepo(openMemoryDb(), clock);
		push(repo, { name: "a", tags: ["x", "y"] });
		clock.advance(10);
		push(repo, { name: "b", tags: ["x"] });
		const onlyXY = repo.list({ tags: ["x", "y"] });
		expect(onlyXY.artifacts.map((a) => a.name)).toEqual(["a"]);
	});

	test("paginates deterministically via keyset cursor", () => {
		const clock = fixedClock();
		const repo = new ArtifactRepo(openMemoryDb(), clock);
		for (let i = 0; i < 5; i++) {
			push(repo, { name: `n${i}` });
			clock.advance(1);
		}
		const first = repo.list({ limit: 2 });
		expect(first.artifacts).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();
		const second = repo.list({ limit: 2, cursor: first.nextCursor ?? undefined });
		expect(second.artifacts).toHaveLength(2);
		const firstIds = new Set(first.artifacts.map((a) => a.id));
		for (const a of second.artifacts) expect(firstIds.has(a.id)).toBe(false);
	});
});

describe("ArtifactRepo.search", () => {
	test("returns matching artifacts by FTS query", () => {
		const repo = new ArtifactRepo(openMemoryDb(), fixedClock());
		push(repo, { name: "alpha", content: "the quick brown fox", description: "animals" });
		push(repo, { name: "beta", content: "lorem ipsum dolor", description: "latin" });
		const res = repo.search({ query: "fox" });
		expect(res.artifacts.map((a) => a.name)).toEqual(["alpha"]);
	});

	test("empty query returns empty page", () => {
		const repo = new ArtifactRepo(openMemoryDb(), fixedClock());
		push(repo, { name: "alpha", content: "foo" });
		expect(repo.search({ query: "   " }).artifacts).toEqual([]);
	});

	test("respects tag filter", () => {
		const repo = new ArtifactRepo(openMemoryDb(), fixedClock());
		push(repo, { name: "alpha", content: "fox", tags: ["animal"] });
		push(repo, { name: "beta", content: "fox", tags: ["plant"] });
		const res = repo.search({ query: "fox", tags: ["animal"] });
		expect(res.artifacts.map((a) => a.name)).toEqual(["alpha"]);
	});

	test("paginates via keyset cursor without skipping or duplicating across pages", () => {
		const repo = new ArtifactRepo(openMemoryDb(), fixedClock());
		for (let i = 0; i < 5; i++) push(repo, { name: `n${i}`, content: "needle" });
		const first = repo.search({ query: "needle", limit: 2 });
		expect(first.artifacts).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();
		const second = repo.search({
			query: "needle",
			limit: 2,
			cursor: first.nextCursor ?? undefined,
		});
		const firstIds = new Set(first.artifacts.map((a) => a.id));
		for (const a of second.artifacts) expect(firstIds.has(a.id)).toBe(false);
		const third = repo.search({
			query: "needle",
			limit: 2,
			cursor: second.nextCursor ?? undefined,
		});
		expect(third.artifacts).toHaveLength(1);
		expect(third.nextCursor).toBeNull();
		const all = [...first.artifacts, ...second.artifacts, ...third.artifacts];
		expect(new Set(all.map((a) => a.id)).size).toBe(5);
	});

	test("rejects pagination when the query changes mid-stream", () => {
		const repo = new ArtifactRepo(openMemoryDb(), fixedClock());
		push(repo, { name: "a", content: "needle" });
		push(repo, { name: "b", content: "needle haystack" });
		const first = repo.search({ query: "needle", limit: 1 });
		expect(first.nextCursor).not.toBeNull();
		expect(() =>
			repo.search({ query: "different", limit: 1, cursor: first.nextCursor ?? undefined }),
		).toThrow();
	});
});

describe("ArtifactRepo.rename", () => {
	let clock: Clock & { advance(ms: number): void };
	let repo: ArtifactRepo;
	beforeEach(() => {
		clock = fixedClock();
		repo = new ArtifactRepo(openMemoryDb(), clock);
	});

	test("renames an artifact and registers the old name as an alias", () => {
		const { artifact } = push(repo, { name: "old-name" });
		clock.advance(10);
		const result = repo.rename(artifact.id, "new-name");
		expect(result.previousName).toBe("old-name");
		expect(result.artifact.name).toBe("new-name");
		expect(result.artifact.aliases).toEqual(["old-name"]);
		expect(result.artifact.updatedAt).toBe(artifact.updatedAt + 10);
	});

	test("getByName resolves the old name to the same artifact after rename", () => {
		const { artifact } = push(repo, { name: "before" });
		repo.rename(artifact.id, "after");
		const byOld = repo.getByName("snippet", "before");
		const byNew = repo.getByName("snippet", "after");
		expect(byOld?.id).toBe(artifact.id);
		expect(byNew?.id).toBe(artifact.id);
	});

	test("getByLiveName does NOT follow aliases", () => {
		const { artifact } = push(repo, { name: "before" });
		repo.rename(artifact.id, "after");
		expect(repo.getByLiveName("snippet", "before")).toBeNull();
		expect(repo.getByLiveName("snippet", "after")?.id).toBe(artifact.id);
	});

	test("same-name rename is a no-op", () => {
		const { artifact } = push(repo, { name: "stable" });
		const result = repo.rename(artifact.id, "stable");
		expect(result.previousName).toBe("stable");
		expect(result.artifact.aliases).toEqual([]);
	});

	test("throws NameTakenError when target is a live name of another artifact", () => {
		const a = push(repo, { name: "aa" }).artifact;
		push(repo, { name: "bb" });
		expect(() => repo.rename(a.id, "bb")).toThrow(NameTakenError);
	});

	test("throws AliasConflictError when target is an alias of another artifact", () => {
		const a = push(repo, { name: "a" }).artifact;
		repo.rename(a.id, "a2"); // a now has alias "a"
		const b = push(repo, { name: "b" }).artifact;
		expect(() => repo.rename(b.id, "a")).toThrow(AliasConflictError);
	});

	test("round-trip rename promotes the old-name alias back to a live name", () => {
		const { artifact } = push(repo, { name: "one" });
		repo.rename(artifact.id, "two"); // one -> two, alias: one
		clock.advance(5);
		const back = repo.rename(artifact.id, "one"); // two -> one, alias: two
		expect(back.artifact.name).toBe("one");
		expect(back.artifact.aliases).toEqual(["two"]);
		expect(repo.getByLiveName("snippet", "one")?.id).toBe(artifact.id);
	});

	test("different kinds may share the same alias namespace", () => {
		const snip = push(repo, { kind: "snippet", name: "shared" }).artifact;
		const std = push(repo, { kind: "standard", name: "shared-std" }).artifact;
		repo.rename(std.id, "shared"); // different kind, no collision
		expect(repo.getByName("snippet", "shared")?.id).toBe(snip.id);
		expect(repo.getByName("standard", "shared")?.id).toBe(std.id);
	});

	test("throws ArtifactNotFoundError for unknown id", () => {
		expect(() => repo.rename("missing", "anything")).toThrow(ArtifactNotFoundError);
	});

	test("delete cascades aliases", () => {
		const db = openMemoryDb();
		const r = new ArtifactRepo(db, fixedClock());
		const { artifact } = push(r, { name: "doomed" });
		r.rename(artifact.id, "doomed2");
		expect(r.delete(artifact.id)).toBe(true);
		const remaining = db.query("SELECT COUNT(*) AS n FROM aliases").get() as { n: number };
		expect(remaining.n).toBe(0);
	});

	test("push into a name that is an alias of another artifact fails with AliasConflictError", () => {
		const a = push(repo, { name: "a" }).artifact;
		repo.rename(a.id, "a2"); // alias "a" now points to a
		expect(() => push(repo, { name: "a", content: "other" })).toThrow(AliasConflictError);
	});
});

describe("ArtifactRepo revisions", () => {
	let clock: Clock & { advance(ms: number): void };
	let repo: ArtifactRepo;
	beforeEach(() => {
		clock = fixedClock();
		repo = new ArtifactRepo(openMemoryDb(), clock);
	});

	test("push records a revision per write with monotonically increasing version", () => {
		const { artifact } = push(repo, { name: "r", content: "v1" });
		clock.advance(5);
		push(repo, { name: "r", content: "v2" });
		clock.advance(5);
		push(repo, { name: "r", content: "v3" });
		const history = repo.listRevisions(artifact.id);
		expect(history.map((r) => r.version)).toEqual([3, 2, 1]);
		expect(history.map((r) => r.content)).toEqual(["v3", "v2", "v1"]);
	});

	test("dryRun does not insert a revision", () => {
		push(repo, { name: "r", content: "keeper" });
		const { artifact } = push(repo, { name: "r", content: "ghost", dryRun: true });
		expect(repo.listRevisions(artifact.id).map((r) => r.content)).toEqual(["keeper"]);
	});

	test("rollback replays a prior revision into a new version", () => {
		const { artifact } = push(repo, { name: "r", content: "v1" });
		clock.advance(5);
		push(repo, { name: "r", content: "v2" });
		clock.advance(5);
		const back = repo.rollback(artifact.id, 1);
		expect(back.newVersion).toBe(3);
		expect(back.artifact.content).toBe("v1");
		const history = repo.listRevisions(artifact.id);
		expect(history.map((r) => r.version)).toEqual([3, 2, 1]);
		expect(history[0]?.content).toBe("v1");
	});

	test("rollback to missing version throws RevisionMissingError", () => {
		const { artifact } = push(repo, { name: "r" });
		expect(() => repo.rollback(artifact.id, 99)).toThrow(RevisionMissingError);
	});

	test("rollback for unknown artifact throws ArtifactNotFoundError", () => {
		expect(() => repo.rollback("missing", 1)).toThrow(ArtifactNotFoundError);
	});

	test("delete cascades revisions", () => {
		const db = openMemoryDb();
		const r = new ArtifactRepo(db, fixedClock());
		const { artifact } = push(r, { name: "ephemeral" });
		expect(r.listRevisions(artifact.id)).toHaveLength(1);
		r.delete(artifact.id);
		const count = db.query("SELECT COUNT(*) AS n FROM artifact_revisions").get() as { n: number };
		expect(count.n).toBe(0);
	});

	test("replaceRevisions swaps out the full revision set atomically", () => {
		const { artifact } = push(repo, { name: "replace-me", content: "now" });
		clock.advance(1);
		push(repo, { name: "replace-me", content: "now2" });
		repo.replaceRevisions(artifact.id, [
			{ version: 1, content: "hist-1", variables: [], createdAt: 10 },
			{ version: 2, content: "hist-2", variables: [], createdAt: 20 },
		]);
		const history = repo.listRevisions(artifact.id);
		expect(history.map((r) => r.content)).toEqual(["hist-2", "hist-1"]);
	});
});
