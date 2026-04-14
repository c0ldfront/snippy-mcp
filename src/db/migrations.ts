import type { Database } from "bun:sqlite";

interface Migration {
	readonly id: number;
	readonly name: string;
	readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
	{
		id: 1,
		name: "initial_schema",
		sql: `
			CREATE TABLE IF NOT EXISTS artifacts (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL CHECK (kind IN ('standard','snippet','resource')),
				name TEXT NOT NULL,
				language TEXT,
				description TEXT NOT NULL DEFAULT '',
				content TEXT NOT NULL,
				variables_json TEXT NOT NULL DEFAULT '[]',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(kind, name)
			);

			CREATE INDEX IF NOT EXISTS idx_artifacts_kind_updated
				ON artifacts(kind, updated_at DESC, id DESC);
			CREATE INDEX IF NOT EXISTS idx_artifacts_language
				ON artifacts(language);

			CREATE TABLE IF NOT EXISTS tags (
				artifact_id TEXT NOT NULL,
				tag TEXT NOT NULL,
				PRIMARY KEY (artifact_id, tag),
				FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

			CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
				name, description, content,
				content='artifacts',
				content_rowid='rowid',
				tokenize='porter unicode61'
			);

			CREATE TRIGGER IF NOT EXISTS artifacts_ai
				AFTER INSERT ON artifacts BEGIN
					INSERT INTO artifacts_fts(rowid, name, description, content)
					VALUES (new.rowid, new.name, new.description, new.content);
				END;

			CREATE TRIGGER IF NOT EXISTS artifacts_ad
				AFTER DELETE ON artifacts BEGIN
					INSERT INTO artifacts_fts(artifacts_fts, rowid, name, description, content)
					VALUES ('delete', old.rowid, old.name, old.description, old.content);
				END;

			CREATE TRIGGER IF NOT EXISTS artifacts_au
				AFTER UPDATE ON artifacts BEGIN
					INSERT INTO artifacts_fts(artifacts_fts, rowid, name, description, content)
					VALUES ('delete', old.rowid, old.name, old.description, old.content);
					INSERT INTO artifacts_fts(rowid, name, description, content)
					VALUES (new.rowid, new.name, new.description, new.content);
				END;
		`,
	},
	{
		id: 2,
		name: "aliases",
		sql: `
			CREATE TABLE IF NOT EXISTS aliases (
				artifact_id TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('standard','snippet','resource')),
				alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 100),
				created_at INTEGER NOT NULL,
				PRIMARY KEY (kind, alias),
				FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS idx_aliases_artifact ON aliases(artifact_id);
		`,
	},
	{
		id: 3,
		name: "artifact_revisions",
		sql: `
			CREATE TABLE IF NOT EXISTS artifact_revisions (
				id TEXT PRIMARY KEY,
				artifact_id TEXT NOT NULL,
				version INTEGER NOT NULL,
				content TEXT NOT NULL,
				variables_json TEXT NOT NULL DEFAULT '[]',
				created_at INTEGER NOT NULL,
				UNIQUE (artifact_id, version),
				FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS idx_revisions_artifact
				ON artifact_revisions(artifact_id, version DESC);
		`,
	},
	{
		id: 4,
		name: "audit_log",
		sql: `
			CREATE TABLE IF NOT EXISTS audit_log (
				id TEXT PRIMARY KEY,
				ts INTEGER NOT NULL,
				actor TEXT NOT NULL,
				tool TEXT NOT NULL,
				args_json TEXT NOT NULL DEFAULT '{}',
				result_code TEXT NOT NULL,
				artifact_id TEXT,
				correlation_id TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
			CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_log(tool, ts DESC);
			CREATE INDEX IF NOT EXISTS idx_audit_artifact ON audit_log(artifact_id);
		`,
	},
];

export function applyMigrations(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		);
	`);

	const applied = new Set<number>();
	for (const row of db.query("SELECT id FROM schema_migrations").all() as { id: number }[]) {
		applied.add(row.id);
	}

	const insertStmt = db.prepare(
		"INSERT INTO schema_migrations (id, name, applied_at) VALUES ($id, $name, $applied_at)",
	);

	for (const m of MIGRATIONS) {
		if (applied.has(m.id)) continue;
		db.transaction(() => {
			db.run(m.sql);
			insertStmt.run({ id: m.id, name: m.name, applied_at: Date.now() });
		})();
	}
}

export function appliedMigrationIds(db: Database): number[] {
	const rows = db.query("SELECT id FROM schema_migrations ORDER BY id").all() as {
		id: number;
	}[];
	return rows.map((r) => r.id);
}
