import { Database } from "bun:sqlite";
import { applyMigrations } from "./migrations.ts";

export type Db = Database;

export function openDb(path: string): Db {
	const db = new Database(path, { create: true, strict: true });
	// Wait up to 5s on contended WAL locks instead of failing instantly. WAL
	// checkpoint-on-close briefly holds an exclusive lock; without this, a
	// fresh process opening the same file the moment the previous handle
	// closes (e.g. backup → restore → audit prune) hits SQLITE_BUSY.
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	db.run("PRAGMA synchronous = NORMAL");
	applyMigrations(db);
	return db;
}

export function openMemoryDb(): Db {
	return openDb(":memory:");
}
