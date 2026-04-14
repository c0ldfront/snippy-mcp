import { openMemoryDb } from "../src/db/connection.ts";
import { ArtifactRepo } from "../src/repo/artifact-repo.ts";
import { render } from "../src/services/render.ts";
import { type BenchResult, bench, compareToBaseline, reportResult } from "./_harness.ts";

const PUSH_N = 1_000;
const QUERY_DATASET = 10_000;
const QUERY_RUNS = 1_000;
const RENDER_RUNS = 5_000;

async function pushBench(): Promise<BenchResult> {
	const db = openMemoryDb();
	const repo = new ArtifactRepo(db);
	const result = await bench("push", PUSH_N, (i) => {
		repo.push({
			kind: "snippet",
			name: `bench-push-${i}`,
			language: "typescript",
			description: "",
			content: `console.log("${i}");`,
			variables: [],
			tags: ["bench"],
			dryRun: false,
		});
	});
	db.close();
	return result;
}

async function listBench(): Promise<BenchResult> {
	const db = openMemoryDb();
	const repo = new ArtifactRepo(db);
	for (let i = 0; i < QUERY_DATASET; i++) {
		repo.push({
			kind: "snippet",
			name: `dataset-${i}`,
			language: null,
			description: "",
			content: `body-${i}`,
			variables: [],
			tags: i % 7 === 0 ? ["even"] : ["odd"],
			dryRun: false,
		});
	}
	const result = await bench("list@10k_first_page", QUERY_RUNS, () => {
		repo.list({ limit: 25 });
	});
	db.close();
	return result;
}

async function searchBench(): Promise<BenchResult> {
	const db = openMemoryDb();
	const repo = new ArtifactRepo(db);
	for (let i = 0; i < QUERY_DATASET; i++) {
		repo.push({
			kind: "snippet",
			name: `s-${i}`,
			language: null,
			description: i % 17 === 0 ? "needle haystack" : "",
			content: i % 17 === 0 ? "the quick brown fox" : `body ${i}`,
			variables: [],
			tags: [],
			dryRun: false,
		});
	}
	const result = await bench("search@10k_needle", QUERY_RUNS, () => {
		repo.search({ query: "needle", limit: 25 });
	});
	db.close();
	return result;
}

async function renderBench(): Promise<BenchResult> {
	const variables = [{ name: "name" }, { name: "n", default: "0" }];
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${var}` placeholder is the input under test.
	const content = "hello ${name}, count=${n}, suffix=${name}-${n}";
	return bench("render_hot_path", RENDER_RUNS, () => {
		render({ content, variables, bindings: { name: "alice" } });
	});
}

async function main(): Promise<void> {
	const results = [await pushBench(), await listBench(), await searchBench(), await renderBench()];
	for (const r of results) reportResult(r);

	const baselinePath = `${import.meta.dir}/baseline.json`;
	const args = Bun.argv.slice(2);
	if (args.includes("--write-baseline")) {
		const out: Record<string, { p50Ms: number; p95Ms: number }> = {};
		for (const r of results) out[r.name] = { p50Ms: r.p50Ms, p95Ms: r.p95Ms };
		await Bun.write(baselinePath, JSON.stringify(out, null, 2));
		console.error(`baseline written: ${baselinePath}`);
		return;
	}

	const baselineFile = Bun.file(baselinePath);
	if (await baselineFile.exists()) {
		const baseline = (await baselineFile.json()) as Record<
			string,
			{ p50Ms: number; p95Ms: number }
		>;
		const cmp = compareToBaseline(results, baseline);
		if (cmp.improvements.length > 0) {
			console.error("improvements:");
			for (const i of cmp.improvements) {
				console.error(
					`  ${i.name} ${i.metric}: ${i.baseline.toFixed(3)}ms → ${i.current.toFixed(3)}ms (×${i.ratio.toFixed(2)})`,
				);
			}
		}
		if (cmp.regressions.length > 0) {
			console.error("regressions (p50 >=20% / p95 >=50% slower):");
			for (const r of cmp.regressions) {
				console.error(
					`  ${r.name} ${r.metric}: ${r.baseline.toFixed(3)}ms → ${r.current.toFixed(3)}ms (×${r.ratio.toFixed(2)})`,
				);
			}
			process.exit(1);
		}
	} else {
		console.error(
			`no baseline at ${baselinePath}; skip comparison (run with --write-baseline to seed).`,
		);
	}
}

await main();
