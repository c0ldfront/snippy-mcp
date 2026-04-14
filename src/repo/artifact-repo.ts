import type { Database } from "bun:sqlite";
import type { Artifact, Kind, PushInput, Revision, Variable } from "../domain/artifact.ts";
import { ArtifactNameSchema, MAX_ALIASES_PER_ARTIFACT, TagSchema } from "../domain/artifact.ts";
import { newId } from "../domain/id.ts";
import {
	decodeListCursor,
	decodeSearchCursor,
	encodeListCursor,
	encodeSearchCursor,
} from "./cursor.ts";

interface ArtifactRow {
	id: string;
	kind: Kind;
	name: string;
	language: string | null;
	description: string;
	content: string;
	variables_json: string;
	created_at: number;
	updated_at: number;
}

export interface PushResult {
	artifact: Artifact;
	existed: boolean;
	previousUpdatedAt: number | null;
	dryRun: boolean;
}

export class AliasConflictError extends Error {
	constructor(
		readonly kind: Kind,
		readonly alias: string,
		readonly holderId: string,
	) {
		super(`name '${alias}' is already an alias for ${kind}/${holderId}`);
		this.name = "AliasConflictError";
	}
}

export class ArtifactNotFoundError extends Error {
	constructor(readonly id: string) {
		super(`artifact not found: ${id}`);
		this.name = "ArtifactNotFoundError";
	}
}

export class NameTakenError extends Error {
	constructor(
		readonly kind: Kind,
		readonly takenName: string,
	) {
		super(`name '${takenName}' is already taken by another ${kind}`);
		this.name = "NameTakenError";
	}
}

export class TooManyAliasesError extends Error {
	constructor(readonly id: string) {
		super(`artifact ${id} already has ${MAX_ALIASES_PER_ARTIFACT} aliases`);
		this.name = "TooManyAliasesError";
	}
}

export class SearchCursorQueryMismatchError extends Error {
	constructor(
		readonly cursorQuery: string,
		readonly currentQuery: string,
	) {
		super(
			`search cursor was issued for query "${cursorQuery}" but current call uses "${currentQuery}"; pagination across changing queries is not supported`,
		);
		this.name = "SearchCursorQueryMismatchError";
	}
}

export class RevisionMissingError extends Error {
	constructor(
		readonly artifactId: string,
		readonly version: number,
	) {
		super(`revision not found: artifact=${artifactId} version=${version}`);
		this.name = "RevisionMissingError";
	}
}

export interface RenameResult {
	artifact: Artifact;
	previousName: string;
}

export interface RollbackResult {
	artifact: Artifact;
	newVersion: number;
}

interface RevisionRow {
	id: string;
	artifact_id: string;
	version: number;
	content: string;
	variables_json: string;
	created_at: number;
}

export interface ListInput {
	kind?: Kind;
	language?: string;
	tags?: string[];
	cursor?: string;
	limit?: number;
}

export interface SearchInput {
	query: string;
	kind?: Kind;
	tags?: string[];
	cursor?: string;
	limit?: number;
}

export interface PageResult {
	artifacts: Artifact[];
	nextCursor: string | null;
}

export interface Clock {
	now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export class ArtifactRepo {
	constructor(
		private readonly db: Database,
		private readonly clock: Clock = systemClock,
	) {}

	push(input: PushInput): PushResult {
		for (const t of input.tags) TagSchema.parse(t);

		const now = this.clock.now();
		const existing = this.getByLiveName(input.kind, input.name);
		if (existing === null) {
			const aliasHolder = this.findAliasHolder(input.kind, input.name);
			if (aliasHolder !== null) {
				throw new AliasConflictError(input.kind, input.name, aliasHolder);
			}
		}
		const artifact: Artifact = existing
			? {
					...existing,
					language: input.language,
					description: input.description,
					content: input.content,
					variables: input.variables,
					tags: [...input.tags].sort(),
					updatedAt: now,
				}
			: {
					id: newId(now),
					kind: input.kind,
					name: input.name,
					language: input.language,
					description: input.description,
					content: input.content,
					variables: input.variables,
					tags: [...input.tags].sort(),
					aliases: [],
					createdAt: now,
					updatedAt: now,
				};

		if (input.dryRun) {
			return {
				artifact,
				existed: existing !== null,
				previousUpdatedAt: existing?.updatedAt ?? null,
				dryRun: true,
			};
		}

		const variablesJson = JSON.stringify(artifact.variables);

		this.db.transaction(() => {
			if (existing) {
				this.db
					.prepare(
						`UPDATE artifacts
						 SET language = $language,
						     description = $description,
						     content = $content,
						     variables_json = $variables_json,
						     updated_at = $updated_at
						 WHERE id = $id`,
					)
					.run({
						id: artifact.id,
						language: artifact.language,
						description: artifact.description,
						content: artifact.content,
						variables_json: variablesJson,
						updated_at: artifact.updatedAt,
					});
				this.db.prepare("DELETE FROM tags WHERE artifact_id = $id").run({ id: artifact.id });
			} else {
				this.db
					.prepare(
						`INSERT INTO artifacts
						   (id, kind, name, language, description, content, variables_json, created_at, updated_at)
						 VALUES
						   ($id, $kind, $name, $language, $description, $content, $variables_json, $created_at, $updated_at)`,
					)
					.run({
						id: artifact.id,
						kind: artifact.kind,
						name: artifact.name,
						language: artifact.language,
						description: artifact.description,
						content: artifact.content,
						variables_json: variablesJson,
						created_at: artifact.createdAt,
						updated_at: artifact.updatedAt,
					});
			}
			this.writeTags(artifact.id, artifact.tags);
			this.writeRevision(artifact.id, artifact.content, variablesJson, artifact.updatedAt);
		})();

		return {
			artifact,
			existed: existing !== null,
			previousUpdatedAt: existing?.updatedAt ?? null,
			dryRun: false,
		};
	}

	listRevisions(id: string): Revision[] {
		const rows = this.db
			.prepare(
				`SELECT id, artifact_id, version, content, variables_json, created_at
				 FROM artifact_revisions WHERE artifact_id = $id ORDER BY version DESC`,
			)
			.all({ id }) as RevisionRow[];
		return rows.map((r) => this.hydrateRevision(r));
	}

	getRevision(id: string, version: number): Revision | null {
		const row = this.db
			.prepare(
				`SELECT id, artifact_id, version, content, variables_json, created_at
				 FROM artifact_revisions WHERE artifact_id = $id AND version = $version`,
			)
			.get({ id, version }) as RevisionRow | null;
		return row ? this.hydrateRevision(row) : null;
	}

	rollback(id: string, toVersion: number): RollbackResult {
		const artifact = this.getById(id);
		if (artifact === null) throw new ArtifactNotFoundError(id);
		const revision = this.getRevision(id, toVersion);
		if (revision === null) throw new RevisionMissingError(id, toVersion);

		return this.db.transaction(() => {
			const now = this.clock.now();
			const variablesJson = JSON.stringify(revision.variables);
			this.db
				.prepare(
					`UPDATE artifacts
					 SET content = $content,
					     variables_json = $variables_json,
					     updated_at = $updated_at
					 WHERE id = $id`,
				)
				.run({
					id,
					content: revision.content,
					variables_json: variablesJson,
					updated_at: now,
				});
			const newVersion = this.writeRevision(id, revision.content, variablesJson, now);
			const after = this.getById(id);
			if (after === null) throw new ArtifactNotFoundError(id);
			return { artifact: after, newVersion };
		})();
	}

	private writeRevision(
		artifactId: string,
		content: string,
		variablesJson: string,
		createdAt: number,
	): number {
		const row = this.db
			.prepare(
				"SELECT COALESCE(MAX(version), 0) AS v FROM artifact_revisions WHERE artifact_id = $id",
			)
			.get({ id: artifactId }) as { v: number };
		const version = row.v + 1;
		this.db
			.prepare(
				`INSERT INTO artifact_revisions (id, artifact_id, version, content, variables_json, created_at)
				 VALUES ($id, $artifact_id, $version, $content, $variables_json, $created_at)`,
			)
			.run({
				id: newId(createdAt),
				artifact_id: artifactId,
				version,
				content,
				variables_json: variablesJson,
				created_at: createdAt,
			});
		return version;
	}

	private hydrateRevision(row: RevisionRow): Revision {
		return {
			id: row.id,
			artifactId: row.artifact_id,
			version: row.version,
			content: row.content,
			variables: parseVariables(row.variables_json),
			createdAt: row.created_at,
		};
	}

	replaceRevisions(
		artifactId: string,
		revisions: readonly {
			version: number;
			content: string;
			variables: Variable[];
			createdAt: number;
		}[],
	): void {
		this.db.transaction(() => {
			this.db
				.prepare("DELETE FROM artifact_revisions WHERE artifact_id = $id")
				.run({ id: artifactId });
			const insert = this.db.prepare(
				`INSERT INTO artifact_revisions (id, artifact_id, version, content, variables_json, created_at)
				 VALUES ($id, $artifact_id, $version, $content, $variables_json, $created_at)`,
			);
			for (const r of revisions) {
				insert.run({
					id: newId(r.createdAt),
					artifact_id: artifactId,
					version: r.version,
					content: r.content,
					variables_json: JSON.stringify(r.variables),
					created_at: r.createdAt,
				});
			}
		})();
	}

	getById(id: string): Artifact | null {
		const row = this.db
			.prepare("SELECT * FROM artifacts WHERE id = $id")
			.get({ id }) as ArtifactRow | null;
		return row ? this.hydrate(row) : null;
	}

	getByLiveName(kind: Kind, name: string): Artifact | null {
		const row = this.db
			.prepare("SELECT * FROM artifacts WHERE kind = $kind AND name = $name")
			.get({ kind, name }) as ArtifactRow | null;
		return row ? this.hydrate(row) : null;
	}

	getByName(kind: Kind, name: string): Artifact | null {
		const live = this.getByLiveName(kind, name);
		if (live !== null) return live;
		const holder = this.findAliasHolder(kind, name);
		if (holder === null) return null;
		return this.getById(holder);
	}

	findAliasHolder(kind: Kind, name: string): string | null {
		const row = this.db
			.prepare("SELECT artifact_id FROM aliases WHERE kind = $kind AND alias = $name")
			.get({ kind, name }) as { artifact_id: string } | null;
		return row ? row.artifact_id : null;
	}

	rename(id: string, newName: string): RenameResult {
		const parsed = ArtifactNameSchema.safeParse(newName);
		if (!parsed.success) {
			throw new Error(`invalid artifact name: ${parsed.error.message}`);
		}
		const current = this.getById(id);
		if (current === null) throw new ArtifactNotFoundError(id);
		if (current.name === newName) {
			return { artifact: current, previousName: current.name };
		}

		return this.db.transaction(() => {
			const collisionRow = this.db
				.prepare(
					`SELECT source, artifact_id FROM (
						SELECT 'live' AS source, id AS artifact_id FROM artifacts
							WHERE kind = $kind AND name = $name AND id != $id
						UNION ALL
						SELECT 'alias' AS source, artifact_id FROM aliases
							WHERE kind = $kind AND alias = $name AND artifact_id != $id
					) LIMIT 1`,
				)
				.get({ kind: current.kind, name: newName, id }) as {
				source: "live" | "alias";
				artifact_id: string;
			} | null;

			if (collisionRow !== null) {
				if (collisionRow.source === "live") {
					throw new NameTakenError(current.kind, newName);
				}
				throw new AliasConflictError(current.kind, newName, collisionRow.artifact_id);
			}

			this.db
				.prepare("DELETE FROM aliases WHERE kind = $kind AND alias = $name AND artifact_id = $id")
				.run({ kind: current.kind, name: newName, id });

			const existingAliases = this.readAliases(id);
			if (existingAliases.length >= MAX_ALIASES_PER_ARTIFACT) {
				throw new TooManyAliasesError(id);
			}

			const now = this.clock.now();
			this.db
				.prepare("UPDATE artifacts SET name = $name, updated_at = $updated_at WHERE id = $id")
				.run({ name: newName, updated_at: now, id });

			this.db
				.prepare(
					`INSERT OR IGNORE INTO aliases (artifact_id, kind, alias, created_at)
					 VALUES ($id, $kind, $alias, $created_at)`,
				)
				.run({ id, kind: current.kind, alias: current.name, created_at: now });

			const after = this.getById(id);
			if (after === null) throw new ArtifactNotFoundError(id);
			return { artifact: after, previousName: current.name };
		})();
	}

	delete(id: string): boolean {
		const res = this.db.prepare("DELETE FROM artifacts WHERE id = $id").run({ id });
		return res.changes > 0;
	}

	addTags(id: string, tags: string[]): string[] {
		for (const t of tags) TagSchema.parse(t);
		this.db.transaction(() => {
			const stmt = this.db.prepare(
				"INSERT OR IGNORE INTO tags (artifact_id, tag) VALUES ($id, $tag)",
			);
			for (const tag of tags) stmt.run({ id, tag });
		})();
		return this.readTags(id);
	}

	removeTags(id: string, tags: string[]): string[] {
		this.db.transaction(() => {
			const stmt = this.db.prepare("DELETE FROM tags WHERE artifact_id = $id AND tag = $tag");
			for (const tag of tags) stmt.run({ id, tag });
		})();
		return this.readTags(id);
	}

	list(input: ListInput): PageResult {
		const limit = clampLimit(input.limit);
		const cursor = input.cursor ? decodeListCursor(input.cursor) : undefined;
		const tags = normalizeTags(input.tags);

		const where: string[] = [];
		const params: Record<string, string | number | null> = {};

		if (input.kind !== undefined) {
			where.push("a.kind = $kind");
			params.kind = input.kind;
		}
		if (input.language !== undefined) {
			where.push("a.language = $language");
			params.language = input.language;
		}
		if (cursor !== undefined) {
			where.push(
				"(a.updated_at < $cursor_updated_at OR (a.updated_at = $cursor_updated_at AND a.id < $cursor_id))",
			);
			params.cursor_updated_at = cursor.updatedAt;
			params.cursor_id = cursor.id;
		}
		if (tags.length > 0) {
			const placeholders = tags.map((_, i) => `$tag_${i}`);
			for (let i = 0; i < tags.length; i++) {
				const ph = placeholders[i];
				const tag = tags[i];
				if (ph !== undefined && tag !== undefined) params[ph.slice(1)] = tag;
			}
			where.push(`(
				SELECT COUNT(DISTINCT tag) FROM tags
				WHERE artifact_id = a.id AND tag IN (${placeholders.join(", ")})
			) = ${tags.length}`);
		}

		const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
		const sql = `
			SELECT a.* FROM artifacts a
			${whereSql}
			ORDER BY a.updated_at DESC, a.id DESC
			LIMIT ${limit + 1}
		`;

		const rows = this.db.prepare(sql).all(params) as ArtifactRow[];
		return this.toPage(rows, limit, (last) =>
			encodeListCursor({ updatedAt: last.updatedAt, id: last.id }),
		);
	}

	search(input: SearchInput): PageResult {
		if (input.query.trim().length === 0) {
			return { artifacts: [], nextCursor: null };
		}
		const limit = clampLimit(input.limit);
		const cursor = input.cursor ? decodeSearchCursor(input.cursor) : undefined;
		if (cursor !== undefined && cursor.q !== input.query) {
			throw new SearchCursorQueryMismatchError(cursor.q, input.query);
		}
		const tags = normalizeTags(input.tags);

		const where: string[] = ["artifacts_fts MATCH $q"];
		const params: Record<string, string | number | null> = { q: input.query };

		if (input.kind !== undefined) {
			where.push("a.kind = $kind");
			params.kind = input.kind;
		}
		if (tags.length > 0) {
			const placeholders = tags.map((_, i) => `$tag_${i}`);
			for (let i = 0; i < tags.length; i++) {
				const ph = placeholders[i];
				const tag = tags[i];
				if (ph !== undefined && tag !== undefined) params[ph.slice(1)] = tag;
			}
			where.push(`(
				SELECT COUNT(DISTINCT tag) FROM tags
				WHERE artifact_id = a.id AND tag IN (${placeholders.join(", ")})
			) = ${tags.length}`);
		}

		if (cursor !== undefined) {
			where.push(
				"(bm25(artifacts_fts) > $cursor_rank OR (bm25(artifacts_fts) = $cursor_rank AND a.rowid > $cursor_rowid))",
			);
			params.cursor_rank = cursor.r;
			params.cursor_rowid = cursor.id;
		}

		const sql = `
			SELECT a.*, bm25(artifacts_fts) AS rank, a.rowid AS rowid
			FROM artifacts_fts
			JOIN artifacts a ON a.rowid = artifacts_fts.rowid
			WHERE ${where.join(" AND ")}
			ORDER BY bm25(artifacts_fts) ASC, a.rowid ASC
			LIMIT ${limit + 1}
		`;

		type SearchRow = ArtifactRow & { rank: number; rowid: number };
		const rows = this.db.prepare(sql).all(params) as SearchRow[];
		const hasMore = rows.length > limit;
		const sliced = hasMore ? rows.slice(0, limit) : rows;
		const artifacts = sliced.map((r) => this.hydrate(r));
		const lastRow = sliced.at(-1);
		const nextCursor =
			hasMore && lastRow !== undefined
				? encodeSearchCursor({ q: input.query, r: lastRow.rank, id: lastRow.rowid })
				: null;
		return { artifacts, nextCursor };
	}

	private readTags(id: string): string[] {
		const rows = this.db
			.prepare("SELECT tag FROM tags WHERE artifact_id = $id ORDER BY tag")
			.all({ id }) as { tag: string }[];
		return rows.map((r) => r.tag);
	}

	private readAliases(id: string): string[] {
		const rows = this.db
			.prepare("SELECT alias FROM aliases WHERE artifact_id = $id ORDER BY alias")
			.all({ id }) as { alias: string }[];
		return rows.map((r) => r.alias);
	}

	private writeTags(id: string, tags: string[]): void {
		if (tags.length === 0) return;
		const stmt = this.db.prepare(
			"INSERT OR IGNORE INTO tags (artifact_id, tag) VALUES ($id, $tag)",
		);
		for (const tag of tags) stmt.run({ id, tag });
	}

	private hydrate(row: ArtifactRow): Artifact {
		const variables = parseVariables(row.variables_json);
		const tags = this.readTags(row.id);
		const aliases = this.readAliases(row.id);
		return {
			id: row.id,
			kind: row.kind,
			name: row.name,
			language: row.language,
			description: row.description,
			content: row.content,
			variables,
			tags,
			aliases,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private toPage(
		rows: ArtifactRow[],
		limit: number,
		buildCursor: (last: Artifact) => string,
	): PageResult {
		const hasMore = rows.length > limit;
		const sliced = hasMore ? rows.slice(0, limit) : rows;
		const artifacts = sliced.map((r) => this.hydrate(r));
		const last = artifacts.at(-1);
		return {
			artifacts,
			nextCursor: hasMore && last !== undefined ? buildCursor(last) : null,
		};
	}
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	if (limit < 1) return 1;
	if (limit > MAX_LIMIT) return MAX_LIMIT;
	return Math.floor(limit);
}

function normalizeTags(tags: string[] | undefined): string[] {
	if (!tags || tags.length === 0) return [];
	const set = new Set<string>();
	for (const t of tags) set.add(t);
	return [...set];
}

function parseVariables(json: string): Variable[] {
	try {
		const parsed: unknown = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		const out: Variable[] = [];
		for (const v of parsed) {
			if (
				v !== null &&
				typeof v === "object" &&
				"name" in v &&
				typeof (v as { name: unknown }).name === "string"
			) {
				const typed = v as { name: string; description?: unknown; default?: unknown };
				const entry: Variable = { name: typed.name };
				if (typeof typed.description === "string") entry.description = typed.description;
				if (typeof typed.default === "string") entry.default = typed.default;
				out.push(entry);
			}
		}
		return out;
	} catch {
		return [];
	}
}
