import { describe, expect, test } from "bun:test";
import { openMemoryDb } from "../db/connection.ts";
import { AuditWriter, resolveRetentionMs } from "./audit.ts";

describe("AuditWriter", () => {
	test("records and tails entries", () => {
		const db = openMemoryDb();
		const audit = new AuditWriter(db);
		audit.record({ actor: "stdio", tool: "artifact.push", args: { name: "a" }, resultCode: "ok" });
		audit.record({ actor: "stdio", tool: "artifact.delete", args: { id: "x" }, resultCode: "ok" });
		const tail = audit.tail(10);
		expect(tail).toHaveLength(2);
		expect(tail.map((r) => r.tool).sort()).toEqual(["artifact.delete", "artifact.push"]);
	});

	test("never throws when the underlying insert fails", () => {
		const db = openMemoryDb();
		db.run("DROP TABLE audit_log");
		const audit = new AuditWriter(db);
		expect(() => audit.record({ actor: "x", tool: "y", args: {}, resultCode: "ok" })).not.toThrow();
	});

	test("truncates very large args payloads", () => {
		const db = openMemoryDb();
		const audit = new AuditWriter(db);
		const huge = "x".repeat(20_000);
		audit.record({ actor: "stdio", tool: "artifact.push", args: { huge }, resultCode: "ok" });
		const [row] = audit.tail(1);
		expect(row).toBeDefined();
		expect(row?.argsJson.length).toBeLessThan(20_000);
		expect(row?.argsJson.endsWith("…<truncated>")).toBe(true);
	});

	test("pruneOlderThan deletes rows older than the cutoff", () => {
		const db = openMemoryDb();
		db.run(
			"INSERT INTO audit_log (id, ts, actor, tool, args_json, result_code) VALUES ('old', 1, 's', 't', '{}', 'ok')",
		);
		db.prepare(
			`INSERT INTO audit_log (id, ts, actor, tool, args_json, result_code) VALUES ('new', $now, 's', 't', '{}', 'ok')`,
		).run({ now: Date.now() });
		const audit = new AuditWriter(db);
		const removed = audit.pruneOlderThan(60_000);
		expect(removed).toBe(1);
		expect(audit.count()).toBe(1);
	});

	test("pruneOlderThan with retentionMs <= 0 is a no-op", () => {
		const db = openMemoryDb();
		const audit = new AuditWriter(db);
		audit.record({ actor: "s", tool: "t", args: {}, resultCode: "ok" });
		expect(audit.pruneOlderThan(0)).toBe(0);
		expect(audit.count()).toBe(1);
	});
});

describe("resolveRetentionMs", () => {
	test("default is 90 days when env is unset/garbage", () => {
		expect(resolveRetentionMs(undefined)).toBe(90 * 86_400_000);
		expect(resolveRetentionMs("not-a-number")).toBe(90 * 86_400_000);
	});

	test("parses positive integer day counts", () => {
		expect(resolveRetentionMs("7")).toBe(7 * 86_400_000);
	});

	test("0 is a sentinel for 'never prune'", () => {
		expect(resolveRetentionMs("0")).toBe(0);
	});
});
