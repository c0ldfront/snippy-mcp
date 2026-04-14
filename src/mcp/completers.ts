import type { Database } from "bun:sqlite";
import type { Kind } from "../domain/artifact.ts";

const COMPLETION_LIMIT = 50;

export interface CompleterContext {
	arguments?: Record<string, string>;
}

export interface Completers {
	completeId(prefix: string): string[];
	completeArtifactName(prefix: string, ctx?: CompleterContext): string[];
	completeTag(prefix: string): string[];
}

export function buildCompleters(db: Database): Completers {
	return {
		completeId(prefix: string): string[] {
			const safe = sanitizeLikePattern(prefix);
			const rows = db
				.query(
					`SELECT id FROM artifacts
					 WHERE id LIKE $like ESCAPE '\\'
					 ORDER BY updated_at DESC
					 LIMIT $n`,
				)
				.all({ like: `${safe}%`, n: COMPLETION_LIMIT }) as { id: string }[];
			return rows.map((r) => r.id);
		},
		completeArtifactName(prefix: string, ctx?: CompleterContext): string[] {
			const kind = readKind(ctx);
			const safe = sanitizeLikePattern(prefix);
			const liveRows =
				kind !== null
					? (db
							.query(
								`SELECT name FROM artifacts WHERE kind = $kind AND name LIKE $like ESCAPE '\\'
								 ORDER BY updated_at DESC LIMIT $n`,
							)
							.all({ kind, like: `${safe}%`, n: COMPLETION_LIMIT }) as { name: string }[])
					: (db
							.query(
								`SELECT name FROM artifacts WHERE name LIKE $like ESCAPE '\\'
								 ORDER BY updated_at DESC LIMIT $n`,
							)
							.all({ like: `${safe}%`, n: COMPLETION_LIMIT }) as { name: string }[]);
			const live = liveRows.map((r) => r.name);
			const aliasRows =
				kind !== null
					? (db
							.query(
								"SELECT alias FROM aliases WHERE kind = $kind AND alias LIKE $like ESCAPE '\\' LIMIT $n",
							)
							.all({ kind, like: `${safe}%`, n: COMPLETION_LIMIT }) as { alias: string }[])
					: (db
							.query("SELECT alias FROM aliases WHERE alias LIKE $like ESCAPE '\\' LIMIT $n")
							.all({ like: `${safe}%`, n: COMPLETION_LIMIT }) as { alias: string }[]);
			const alias = aliasRows.map((r) => r.alias);
			const seen = new Set<string>();
			const out: string[] = [];
			for (const candidate of [...live, ...alias]) {
				if (seen.has(candidate)) continue;
				seen.add(candidate);
				out.push(candidate);
				if (out.length >= COMPLETION_LIMIT) break;
			}
			return out;
		},
		completeTag(prefix: string): string[] {
			const safe = sanitizeLikePattern(prefix);
			const rows = db
				.query(
					`SELECT DISTINCT tag FROM tags
					 WHERE tag LIKE $like ESCAPE '\\'
					 ORDER BY tag
					 LIMIT $n`,
				)
				.all({ like: `${safe}%`, n: COMPLETION_LIMIT }) as { tag: string }[];
			return rows.map((r) => r.tag);
		},
	};
}

function readKind(ctx: CompleterContext | undefined): Kind | null {
	const k = ctx?.arguments?.kind;
	if (k === "standard" || k === "snippet" || k === "resource") return k;
	return null;
}

function sanitizeLikePattern(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
