import { describe, expect, test } from "bun:test";
import { openMemoryDb } from "./connection.ts";
import { appliedMigrationIds } from "./migrations.ts";

describe("openDb / openMemoryDb", () => {
	test("applies all migrations on a fresh db", () => {
		const db = openMemoryDb();
		expect(appliedMigrationIds(db)).toEqual([1, 2, 3, 4]);
		db.close();
	});

	test("enables foreign key enforcement", () => {
		const db = openMemoryDb();
		const row = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
		expect(row.foreign_keys).toBe(1);
		db.close();
	});

	test("FTS5 virtual table is created and usable", () => {
		const db = openMemoryDb();
		const now = Date.now();
		db.prepare(
			`INSERT INTO artifacts (id, kind, name, language, description, content, variables_json, created_at, updated_at)
				 VALUES ('a1', 'snippet', 'hello-world', 'typescript', 'hello world test', 'console.log("hi");', '[]', $t, $t)`,
		).run({ t: now });
		const rows = db
			.query("SELECT name FROM artifacts_fts WHERE artifacts_fts MATCH $q")
			.all({ q: "hello" }) as { name: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("hello-world");
		db.close();
	});

	test("ON DELETE CASCADE removes tags when artifact deleted", () => {
		const db = openMemoryDb();
		const now = Date.now();
		db.prepare(
			`INSERT INTO artifacts (id, kind, name, language, description, content, variables_json, created_at, updated_at)
				 VALUES ('b1', 'standard', 'solid', null, '', 'solid rules', '[]', $t, $t)`,
		).run({ t: now });
		db.run("INSERT INTO tags (artifact_id, tag) VALUES ('b1', 'solid'), ('b1', 'design')");
		db.run("DELETE FROM artifacts WHERE id = 'b1'");
		const tagCount = db.query("SELECT COUNT(*) AS n FROM tags").get() as { n: number };
		expect(tagCount.n).toBe(0);
		db.close();
	});

	test("migrations are idempotent (reapplying on same db is a no-op)", () => {
		const db = openMemoryDb();
		expect(appliedMigrationIds(db)).toEqual([1, 2, 3, 4]);
		expect(appliedMigrationIds(db)).toEqual([1, 2, 3, 4]);
		db.close();
	});

	test("unique(kind, name) constraint blocks duplicates", () => {
		const db = openMemoryDb();
		const now = Date.now();
		const insert = db.prepare(
			`INSERT INTO artifacts (id, kind, name, language, description, content, variables_json, created_at, updated_at)
			 VALUES ($id, 'snippet', 'dup', null, '', 'x', '[]', $t, $t)`,
		);
		insert.run({ id: "c1", t: now });
		expect(() => insert.run({ id: "c2", t: now })).toThrow();
		db.close();
	});
});
