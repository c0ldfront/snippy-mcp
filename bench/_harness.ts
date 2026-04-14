export interface BenchResult {
	name: string;
	iterations: number;
	totalMs: number;
	meanMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	minMs: number;
	maxMs: number;
}

export async function bench(
	name: string,
	iterations: number,
	body: (i: number) => Promise<unknown> | unknown,
): Promise<BenchResult> {
	// warmup
	for (let i = 0; i < Math.min(50, iterations); i++) await body(i);
	const samples = new Float64Array(iterations);
	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		const t0 = performance.now();
		await body(i);
		samples[i] = performance.now() - t0;
	}
	const totalMs = performance.now() - start;
	const sorted = Array.from(samples).sort((a, b) => a - b);
	const pct = (p: number): number =>
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
	const sum = sorted.reduce((a, b) => a + b, 0);
	return {
		name,
		iterations,
		totalMs,
		meanMs: sum / iterations,
		p50Ms: pct(0.5),
		p95Ms: pct(0.95),
		p99Ms: pct(0.99),
		minMs: sorted[0] ?? 0,
		maxMs: sorted[sorted.length - 1] ?? 0,
	};
}

export function reportResult(result: BenchResult): void {
	console.log(JSON.stringify(result, null, 2));
}

export interface BaselineEntry {
	p95Ms: number;
	p50Ms: number;
}

export interface CompareResult {
	regressions: {
		name: string;
		metric: "p50Ms" | "p95Ms";
		baseline: number;
		current: number;
		ratio: number;
	}[];
	improvements: {
		name: string;
		metric: "p50Ms" | "p95Ms";
		baseline: number;
		current: number;
		ratio: number;
	}[];
}

export interface CompareThresholds {
	p50: number;
	p95: number;
}

// Default thresholds reflect the empirical noise profile on GitHub Actions
// shared runners: p50 is a central-tendency metric and stays within ±5% run
// to run, so the 20% contract lands real regressions without false alarms.
// p95 is a tail metric and swings ±15-30% on sub-millisecond benches even
// at n=1000, so 50% is the tightest threshold that doesn't flake on CI.
// A real regression shifts p50 first anyway, so loosening p95 doesn't lose
// signal worth keeping.
export const DEFAULT_THRESHOLDS: CompareThresholds = { p50: 1.2, p95: 1.5 };

export function compareToBaseline(
	current: BenchResult[],
	baseline: Record<string, BaselineEntry>,
	thresholds: CompareThresholds = DEFAULT_THRESHOLDS,
): CompareResult {
	const regressions: CompareResult["regressions"] = [];
	const improvements: CompareResult["improvements"] = [];
	for (const r of current) {
		const base = baseline[r.name];
		if (base === undefined) continue;
		for (const metric of ["p50Ms", "p95Ms"] as const) {
			const cur = r[metric];
			const ref = base[metric];
			if (ref <= 0) continue;
			const ratio = cur / ref;
			const threshold = metric === "p50Ms" ? thresholds.p50 : thresholds.p95;
			if (ratio >= threshold)
				regressions.push({ name: r.name, metric, baseline: ref, current: cur, ratio });
			else if (ratio <= 1 / threshold)
				improvements.push({ name: r.name, metric, baseline: ref, current: cur, ratio });
		}
	}
	return { regressions, improvements };
}
