import { Database } from "bun:sqlite";
import { applyMigrations } from "./migrations.ts";

export type Db = Database;

export function openDb(path: string): Db {
	const db = new Database(path, { create: true, strict: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	db.run("PRAGMA synchronous = NORMAL");
	applyMigrations(db);
	return db;
}

export function openMemoryDb(): Db {
	return openDb(":memory:");
}
