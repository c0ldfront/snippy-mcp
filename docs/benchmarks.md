# Benchmarks

`bench/all.bench.ts` measures four hot paths against in-memory SQLite, with a 50-iteration warmup before timing.

| Bench                       | Workload                              |
| --------------------------- | ------------------------------------- |
| `push`                       | 1 000 inserts, fresh DB                |
| `list@10k_first_page`         | First 25-row page over 10 000 rows     |
| `search@10k_needle`           | FTS5 match (`"needle"`) over 10 000 rows |
| `render_hot_path`             | 5 000 renders of a 3-placeholder template |

## Running locally

```bash
bun run bench
```

Reports p50/p95/p99/mean per scenario as JSON on stdout. Exits non-zero if any bench p50 regresses ≥20% versus `bench/baseline.json`, or if any p95 regresses ≥50%. The asymmetric threshold reflects GitHub Actions runner noise: p50 is a stable central-tendency metric, while p95 on sub-millisecond benches swings ±15-30% run-to-run even at n=1000 samples — a real regression shifts p50 first anyway, and a tighter p95 threshold would just flake.

## Re-baselining

```bash
bun run bench:baseline
```

The committed `bench/baseline.json` reflects **GitHub Actions runner hardware** (ubuntu-24.04 shared VM), not a developer laptop — the regression gate runs in CI, so the baseline has to match the environment it gates. If you re-baseline locally on a faster machine and commit that, every CI run will fail with phantom 20-40% "regressions" that are just hardware jitter. Re-baseline by copying the p50/p95 numbers out of a green CI run (or run `bun run bench:baseline` inside the same runner image).

## Interpreting CI failures

A regression means *something in the hot path got slower*. Common culprits:

- An accidental N+1 in the repo layer (extra query per row).
- A new index missing on a frequently-queried column.
- A new tool wrapper that fires on every call (audit, metrics, etc. all run inside the wrapper).

Reproduce locally with `bun run bench` and bisect the recent diff. If the regression is real and accepted, re-baseline and commit the new file with a justification.

## Why no library?

Existing benchmark harnesses (mitata, tinybench, …) add a dependency for what is ultimately a `performance.now()` loop. The `_harness.ts` file is ~50 lines, has no dependencies, and produces stable JSON we can diff in CI.
