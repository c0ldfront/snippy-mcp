import type { Database } from "bun:sqlite";
import { newId } from "../domain/id.ts";

export interface AuditEntry {
	id: string;
	ts: number;
	actor: string;
	tool: string;
	argsJson: string;
	resultCode: string;
	artifactId: string | null;
	correlationId: string | null;
}

export interface AuditRecordInput {
	actor: string;
	tool: string;
	args: unknown;
	resultCode: string;
	artifactId?: string;
	correlationId?: string;
}

const MAX_ARGS_BYTES = 8192;

export class AuditWriter {
	constructor(private readonly db: Database) {}

	record(input: AuditRecordInput): void {
		try {
			const ts = Date.now();
			const argsJson = serializeArgs(input.args);
			this.db
				.prepare(
					`INSERT INTO audit_log
						(id, ts, actor, tool, args_json, result_code, artifact_id, correlation_id)
					 VALUES
						($id, $ts, $actor, $tool, $args, $code, $artifact, $cid)`,
				)
				.run({
					id: newId(ts),
					ts,
					actor: input.actor,
					tool: input.tool,
					args: argsJson,
					code: input.resultCode,
					artifact: input.artifactId ?? null,
					cid: input.correlationId ?? null,
				});
		} catch {
			// Audit is best-effort; never block the primary operation.
		}
	}

	tail(limit: number): AuditEntry[] {
		const safe = Math.max(1, Math.min(1000, Math.floor(limit)));
		const rows = this.db
			.query(
				`SELECT id, ts, actor, tool, args_json, result_code, artifact_id, correlation_id
				 FROM audit_log ORDER BY ts DESC, id DESC LIMIT $n`,
			)
			.all({ n: safe }) as RawRow[];
		return rows.map(toEntry);
	}

	pruneOlderThan(retentionMs: number): number {
		if (retentionMs <= 0) return 0;
		const cutoff = Date.now() - retentionMs;
		const res = this.db.prepare("DELETE FROM audit_log WHERE ts < $cutoff").run({ cutoff });
		return res.changes;
	}

	count(): number {
		const row = this.db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
		return row.n;
	}
}

interface RawRow {
	id: string;
	ts: number;
	actor: string;
	tool: string;
	args_json: string;
	result_code: string;
	artifact_id: string | null;
	correlation_id: string | null;
}

function toEntry(row: RawRow): AuditEntry {
	return {
		id: row.id,
		ts: row.ts,
		actor: row.actor,
		tool: row.tool,
		argsJson: row.args_json,
		resultCode: row.result_code,
		artifactId: row.artifact_id,
		correlationId: row.correlation_id,
	};
}

function serializeArgs(value: unknown): string {
	let json: string;
	try {
		json = JSON.stringify(value ?? null);
	} catch {
		json = '"<unserializable>"';
	}
	if (json.length > MAX_ARGS_BYTES) {
		return `${json.slice(0, MAX_ARGS_BYTES)}…<truncated>`;
	}
	return json;
}

export function resolveRetentionMs(env: string | undefined): number {
	const days = Number.parseInt(env ?? "90", 10);
	if (!Number.isFinite(days) || days < 0) return 90 * 86_400_000;
	return days * 86_400_000;
}
