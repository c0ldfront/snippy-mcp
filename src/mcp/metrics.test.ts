import { describe, expect, test } from "bun:test";
import { openMemoryDb } from "../db/connection.ts";
import { ArtifactRepo } from "../repo/artifact-repo.ts";
import { buildSnippyMetrics, MetricsRegistry } from "./metrics.ts";

describe("MetricsRegistry", () => {
	test("counters render with sorted labels and HELP/TYPE comments", () => {
		const r = new MetricsRegistry();
		r.registerCounter("calls_total", "Test counter.");
		r.incrementCounter({ name: "calls_total", labels: { tool: "x", result: "ok" } });
		r.incrementCounter({ name: "calls_total", labels: { tool: "x", result: "ok" } }, 2);
		const out = r.render();
		expect(out).toContain("# HELP calls_total Test counter.");
		expect(out).toContain("# TYPE calls_total counter");
		expect(out).toContain('calls_total{result="ok",tool="x"} 3');
	});

	test("histograms emit cumulative buckets, _sum, and _count", () => {
		const r = new MetricsRegistry();
		r.registerHistogram("d_seconds", "Duration.", [0.1, 0.5, 1]);
		r.observeHistogram({ name: "d_seconds", labels: { tool: "x" } }, 0.05);
		r.observeHistogram({ name: "d_seconds", labels: { tool: "x" } }, 0.7);
		const out = r.render();
		expect(out).toContain('d_seconds_bucket{tool="x",le="0.1"} 1');
		expect(out).toContain('d_seconds_bucket{tool="x",le="0.5"} 1');
		expect(out).toContain('d_seconds_bucket{tool="x",le="1"} 2');
		expect(out).toContain('d_seconds_bucket{tool="x",le="+Inf"} 2');
		expect(out).toContain('d_seconds_count{tool="x"} 2');
	});

	test("counters with no observations emit a zero baseline", () => {
		const r = new MetricsRegistry();
		r.registerCounter("idle", "No fires yet.");
		expect(r.render()).toContain("idle 0");
	});

	test("gauges read live values from the registered callback", () => {
		const r = new MetricsRegistry();
		let value = 7;
		r.registerGauge("live", "Reads at render time.", () => value);
		expect(r.render()).toContain("live 7");
		value = 12;
		expect(r.render()).toContain("live 12");
	});

	test("a throwing gauge renders 0 instead of crashing", () => {
		const r = new MetricsRegistry();
		r.registerGauge("oops", "Throws.", () => {
			throw new Error("boom");
		});
		expect(r.render()).toContain("oops 0");
	});

	test("escapes special characters in label values", () => {
		const r = new MetricsRegistry();
		r.registerCounter("c", "Test.");
		r.incrementCounter({ name: "c", labels: { msg: 'has "quote" and \\back' } });
		const out = r.render();
		expect(out).toContain('msg="has \\"quote\\" and \\\\back"');
	});
});

describe("buildSnippyMetrics", () => {
	test("gauges reflect live db row counts", () => {
		const db = openMemoryDb();
		const repo = new ArtifactRepo(db);
		const m = buildSnippyMetrics(db);
		expect(m.registry.render()).toContain("snippy_artifacts_total 0");
		repo.push({
			kind: "snippet",
			name: "metric-test",
			language: null,
			description: "",
			content: "x",
			variables: [],
			tags: [],
			dryRun: false,
		});
		expect(m.registry.render()).toContain("snippy_artifacts_total 1");
		expect(m.registry.render()).toContain("snippy_revisions_total 1");
	});

	test("recordToolCall emits both counter and histogram series", () => {
		const db = openMemoryDb();
		const m = buildSnippyMetrics(db);
		m.recordToolCall("artifact.list", "ok", 0.005);
		m.recordToolCall("artifact.list", "ok", 0.5);
		const out = m.registry.render();
		expect(out).toContain('snippy_tool_calls_total{result="ok",tool="artifact.list"} 2');
		expect(out).toMatch(/snippy_tool_call_duration_seconds_count\{tool="artifact\.list"\} 2/);
	});
});
