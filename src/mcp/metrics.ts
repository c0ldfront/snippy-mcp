import type { Database } from "bun:sqlite";

export interface CounterKey {
	name: string;
	labels?: Readonly<Record<string, string>>;
}

interface CounterDef {
	help: string;
	values: Map<string, number>;
}

interface HistogramSeries {
	buckets: readonly number[];
	counts: number[];
	sum: number;
	count: number;
}

interface HistogramDef {
	help: string;
	buckets: readonly number[];
	series: Map<string, HistogramSeries>;
}

interface GaugeDef {
	help: string;
	read: () => number;
}

const DEFAULT_BUCKETS_SECONDS = [
	0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

export class MetricsRegistry {
	private readonly counters = new Map<string, CounterDef>();
	private readonly histograms = new Map<string, HistogramDef>();
	private readonly gauges = new Map<string, GaugeDef>();

	registerCounter(name: string, help: string): void {
		if (this.counters.has(name)) return;
		this.counters.set(name, { help, values: new Map() });
	}

	registerHistogram(
		name: string,
		help: string,
		buckets: readonly number[] = DEFAULT_BUCKETS_SECONDS,
	): void {
		if (this.histograms.has(name)) return;
		this.histograms.set(name, { help, buckets: [...buckets], series: new Map() });
	}

	registerGauge(name: string, help: string, read: () => number): void {
		this.gauges.set(name, { help, read });
	}

	incrementCounter(key: CounterKey, by = 1): void {
		const def = this.counters.get(key.name);
		if (def === undefined) return;
		const labelKey = encodeLabels(key.labels);
		def.values.set(labelKey, (def.values.get(labelKey) ?? 0) + by);
	}

	observeHistogram(key: CounterKey, valueSeconds: number): void {
		const def = this.histograms.get(key.name);
		if (def === undefined) return;
		const labelKey = encodeLabels(key.labels);
		let series = def.series.get(labelKey);
		if (series === undefined) {
			series = {
				buckets: def.buckets,
				counts: new Array<number>(def.buckets.length).fill(0),
				sum: 0,
				count: 0,
			};
			def.series.set(labelKey, series);
		}
		for (let i = 0; i < def.buckets.length; i++) {
			const upper = def.buckets[i];
			if (upper !== undefined && valueSeconds <= upper) {
				const cur = series.counts[i] ?? 0;
				series.counts[i] = cur + 1;
			}
		}
		series.sum += valueSeconds;
		series.count += 1;
	}

	render(): string {
		const lines: string[] = [];
		for (const [name, def] of this.counters) {
			lines.push(`# HELP ${name} ${def.help}`);
			lines.push(`# TYPE ${name} counter`);
			if (def.values.size === 0) {
				lines.push(`${name} 0`);
			} else {
				for (const [labelKey, value] of def.values) {
					lines.push(`${name}${formatLabels(labelKey)} ${value}`);
				}
			}
		}
		for (const [name, def] of this.histograms) {
			lines.push(`# HELP ${name} ${def.help}`);
			lines.push(`# TYPE ${name} histogram`);
			for (const [labelKey, series] of def.series) {
				for (let i = 0; i < def.buckets.length; i++) {
					const upper = def.buckets[i];
					if (upper === undefined) continue;
					const count = series.counts[i] ?? 0;
					lines.push(`${name}_bucket${formatLabels(labelKey, { le: upper.toString() })} ${count}`);
				}
				lines.push(`${name}_bucket${formatLabels(labelKey, { le: "+Inf" })} ${series.count}`);
				lines.push(`${name}_sum${formatLabels(labelKey)} ${series.sum}`);
				lines.push(`${name}_count${formatLabels(labelKey)} ${series.count}`);
			}
		}
		for (const [name, def] of this.gauges) {
			lines.push(`# HELP ${name} ${def.help}`);
			lines.push(`# TYPE ${name} gauge`);
			lines.push(`${name} ${safeRead(def.read)}`);
		}
		return `${lines.join("\n")}\n`;
	}
}

function safeRead(read: () => number): number {
	try {
		const v = read();
		return Number.isFinite(v) ? v : 0;
	} catch {
		return 0;
	}
}

function encodeLabels(labels: Readonly<Record<string, string>> | undefined): string {
	if (labels === undefined) return "";
	const keys = Object.keys(labels).sort();
	return keys.map((k) => `${k}=${labels[k]}`).join("\u0001");
}

function formatLabels(labelKey: string, extra?: Record<string, string>): string {
	const pairs: string[] = [];
	if (labelKey !== "") {
		for (const part of labelKey.split("\u0001")) {
			const idx = part.indexOf("=");
			if (idx <= 0) continue;
			pairs.push(`${part.slice(0, idx)}="${escapeLabel(part.slice(idx + 1))}"`);
		}
	}
	if (extra !== undefined) {
		for (const [k, v] of Object.entries(extra)) {
			pairs.push(`${k}="${escapeLabel(v)}"`);
		}
	}
	return pairs.length > 0 ? `{${pairs.join(",")}}` : "";
}

function escapeLabel(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export interface SnippyMetrics {
	registry: MetricsRegistry;
	recordToolCall(tool: string, resultCode: string, durationSeconds: number): void;
}

export function buildSnippyMetrics(db: Database): SnippyMetrics {
	const registry = new MetricsRegistry();
	registry.registerCounter(
		"snippy_tool_calls_total",
		"Total tool invocations by tool and snippyCode result.",
	);
	registry.registerHistogram(
		"snippy_tool_call_duration_seconds",
		"Tool invocation latency in seconds.",
	);
	registry.registerGauge("snippy_artifacts_total", "Live artifacts in the store.", () =>
		count(db, "artifacts"),
	);
	registry.registerGauge("snippy_audit_rows_total", "Persistent audit rows.", () =>
		count(db, "audit_log"),
	);
	registry.registerGauge("snippy_revisions_total", "Stored artifact revisions.", () =>
		count(db, "artifact_revisions"),
	);
	registry.registerGauge("snippy_fts_rows_total", "Rows in the FTS index.", () =>
		count(db, "artifacts_fts"),
	);
	registry.registerGauge("snippy_aliases_total", "Stored aliases.", () => count(db, "aliases"));
	return {
		registry,
		recordToolCall(tool, resultCode, durationSeconds): void {
			registry.incrementCounter({
				name: "snippy_tool_calls_total",
				labels: { tool, result: resultCode },
			});
			registry.observeHistogram(
				{ name: "snippy_tool_call_duration_seconds", labels: { tool } },
				durationSeconds,
			);
		},
	};
}

function count(db: Database, table: string): number {
	try {
		const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | null;
		return row?.n ?? 0;
	} catch {
		return 0;
	}
}
