#!/usr/bin/env bun
/**
 * forge — drop-in release script for Bun apps.
 *
 * Identical file across every app. Per-project config lives in
 * `package.json#forge`:
 *
 *   "forge": {
 *     "entry":   "./src/bin/index.ts",       // default: auto-detect
 *     "binary":  "my-app",                   // default: package.json "name"
 *     "targets": "linux",                    // preset or array, default: "linux"
 *     "outDir":  "./target"                  // default
 *   }
 *
 * Subcommands are registered in the SUBCOMMANDS array at the bottom —
 * add new ones (sign, notarize, docker, …) without touching dispatch
 * plumbing.
 */
import { $, CryptoHasher } from "bun";
import { readdir, stat } from "node:fs/promises";

// ── Types ─────────────────────────────────────────────────────────

type Target = {
	bunTarget: string;
	windows?: boolean;
};

type Profile = "release" | "debug";

type ForgeConfig = {
	entry: string;
	binary: string;
	targets: Target[];
	outDir: string;
};

type Context = {
	config: ForgeConfig;
	version: string;
	packageJsonPath: string;
};

type Subcommand = {
	name: string;
	summary: string;
	usage: string;
	run: (ctx: Context, argv: readonly string[]) => Promise<void>;
};

// ── Target presets ────────────────────────────────────────────────

const LINUX_TARGETS: readonly Target[] = [
	{ bunTarget: "bun-linux-x64" },
	{ bunTarget: "bun-linux-arm64" },
	{ bunTarget: "bun-linux-x64-musl" },
	{ bunTarget: "bun-linux-arm64-musl" },
];

const DARWIN_TARGETS: readonly Target[] = [
	{ bunTarget: "bun-darwin-x64" },
	{ bunTarget: "bun-darwin-arm64" },
];

const WINDOWS_TARGETS: readonly Target[] = [
	{ bunTarget: "bun-windows-x64", windows: true },
	{ bunTarget: "bun-windows-arm64", windows: true },
];

const PRESETS: Record<string, readonly Target[]> = {
	linux: LINUX_TARGETS,
	darwin: DARWIN_TARGETS,
	macos: DARWIN_TARGETS,
	windows: WINDOWS_TARGETS,
	unix: [...LINUX_TARGETS, ...DARWIN_TARGETS],
	all: [...LINUX_TARGETS, ...DARWIN_TARGETS, ...WINDOWS_TARGETS],
};

// ── Config ────────────────────────────────────────────────────────

async function loadContext(): Promise<Context> {
	const pkgPath = "./package.json";
	const pkg = (await Bun.file(pkgPath).json()) as {
		name?: string;
		version?: string;
		forge?: {
			entry?: string;
			binary?: string;
			targets?: string | unknown[];
			outDir?: string;
		};
	};
	const forge = pkg.forge ?? {};
	const entry = forge.entry ?? (await autodetectEntry());
	const binary = forge.binary ?? stripScope(pkg.name ?? "app");
	const targets = resolveTargets(forge.targets);
	const outDir = forge.outDir ?? "./target";
	return {
		config: { entry, binary, targets, outDir },
		version: pkg.version ?? "0.0.0",
		packageJsonPath: pkgPath,
	};
}

async function autodetectEntry(): Promise<string> {
	const candidates = ["./src/bin/index.ts", "./src/index.ts", "./index.ts"];
	for (const c of candidates) {
		if (await Bun.file(c).exists()) return c;
	}
	throw new Error(
		`No entry point found. Add "forge.entry" to package.json or create one of: ${candidates.join(", ")}`,
	);
}

function stripScope(name: string): string {
	const slash = name.indexOf("/");
	return slash === -1 ? name : name.slice(slash + 1);
}

function resolveTargets(spec: string | unknown[] | undefined): Target[] {
	if (spec === undefined) return [...PRESETS["linux"]!];
	if (typeof spec === "string") {
		const preset = PRESETS[spec];
		if (!preset) {
			throw new Error(
				`Unknown target preset '${spec}'. Available: ${Object.keys(PRESETS).join(", ")}`,
			);
		}
		return [...preset];
	}
	if (!Array.isArray(spec)) {
		throw new Error(
			"forge.targets must be a preset name (string) or an array of { bunTarget }",
		);
	}
	return spec.map((t, i) => {
		if (!t || typeof t !== "object") {
			throw new Error(`forge.targets[${i}] is not an object`);
		}
		const obj = t as Record<string, unknown>;
		if (typeof obj["bunTarget"] !== "string") {
			throw new Error(`forge.targets[${i}].bunTarget must be a string`);
		}
		return {
			bunTarget: obj["bunTarget"],
			windows: obj["windows"] === true,
		};
	});
}

// ── Helpers ───────────────────────────────────────────────────────

// Slug used in artifact filenames and `--only=` filters. Strips Bun's
// redundant `bun-` prefix so artifacts read like `snippy-mcp-linux-x64`
// rather than the noisier rust-style triple.
function slugOf(target: Target): string {
	return target.bunTarget.startsWith("bun-")
		? target.bunTarget.slice(4)
		: target.bunTarget;
}

function artifactName(binary: string, target: Target): string {
	const base = `${binary}-${slugOf(target)}`;
	return target.windows ? `${base}.exe` : base;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function filterTargets(targets: readonly Target[], only: string | null): Target[] {
	if (!only) return [...targets];
	// Exact slug/bunTarget match wins — comma-separated list supported. Prevents
	// `--only=linux-x64` from also matching `linux-x64-musl` (canary Bun
	// sometimes lags musl sidecars by a day, so the smoke build needs to pin one).
	const wanted = only
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	const exact = targets.filter(
		(t) => wanted.includes(slugOf(t)) || wanted.includes(t.bunTarget),
	);
	if (exact.length > 0) return exact;
	const matches = targets.filter(
		(t) => slugOf(t).includes(only) || t.bunTarget.includes(only),
	);
	if (matches.length === 0) {
		throw new Error(`No targets match filter '${only}'`);
	}
	return matches;
}

async function ensureDir(path: string): Promise<void> {
	await $`mkdir -p ${path}`.quiet();
}

async function sha256(path: string): Promise<string> {
	const bytes = await Bun.file(path).bytes();
	const hasher = new CryptoHasher("sha256");
	hasher.update(bytes);
	return hasher.digest("hex");
}

// ── Subcommand: build ─────────────────────────────────────────────

const buildCmd: Subcommand = {
	name: "build",
	summary: "Compile standalone executables for each target",
	usage: `forge build [--profile=<release|debug>] [--only=<filter>]

Options:
  --profile=<release|debug>   Build profile (default: release)
  --release                   Shorthand for --profile=release
  --debug                     Shorthand for --profile=debug
  --only=<filter>             Only targets whose slug or bunTarget matches <filter> (comma-separated)`,
	async run(ctx, argv) {
		const { profile, only } = parseBuildArgs(argv);
		const targets = filterTargets(ctx.config.targets, only);
		const outDir = `${ctx.config.outDir}/${profile}`;
		await ensureDir(outDir);

		console.log(
			`Building ${ctx.config.binary} v${ctx.version} [${profile}] for ${targets.length} target(s)`,
		);
		console.log(`Entry:   ${ctx.config.entry}`);
		console.log(`Output:  ${outDir}/\n`);

		type Result = {
			target: Target;
			ok: boolean;
			outfile: string;
			bytes?: number;
			error?: string;
		};
		const results: Result[] = [];

		for (const target of targets) {
			const outfile = `${outDir}/${artifactName(ctx.config.binary, target)}`;
			const label = slugOf(target).padEnd(20);
			process.stdout.write(`  ${label} ... `);
			try {
				if (profile === "release") {
					await $`bun build --compile --minify --target=${target.bunTarget} ${ctx.config.entry} --outfile=${outfile}`.quiet();
				} else {
					await $`bun build --compile --target=${target.bunTarget} ${ctx.config.entry} --outfile=${outfile}`.quiet();
				}
				const bytes = (await stat(outfile)).size;
				console.log(`OK (${formatBytes(bytes)})`);
				results.push({ target, ok: true, outfile, bytes });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.log("FAIL");
				results.push({ target, ok: false, outfile, error: message });
			}
		}

		const failed = results.filter((r) => !r.ok);
		console.log("\nSummary:");
		for (const r of results) {
			const mark = r.ok ? "[ok]" : "[FAIL]";
			const size = r.bytes !== undefined ? ` (${formatBytes(r.bytes)})` : "";
			console.log(`  ${mark} ${r.outfile}${size}`);
		}

		if (failed.length > 0) {
			console.error(`\n${failed.length} of ${results.length} target(s) failed:`);
			for (const r of failed) {
				console.error(`  - ${slugOf(r.target)}`);
				if (r.error) console.error(`    ${r.error.split("\n")[0]}`);
			}
			process.exit(1);
		}
		console.log(`\nAll ${results.length} target(s) built successfully.`);
	},
};

function parseBuildArgs(argv: readonly string[]): {
	profile: Profile;
	only: string | null;
} {
	let profile: Profile = "release";
	let only: string | null = null;
	for (const arg of argv) {
		if (arg === "--release") profile = "release";
		else if (arg === "--debug") profile = "debug";
		else if (arg.startsWith("--profile=")) {
			const v = arg.slice("--profile=".length);
			if (v !== "release" && v !== "debug") {
				throw new Error(`Invalid --profile: ${v}`);
			}
			profile = v;
		} else if (arg.startsWith("--only=")) {
			only = arg.slice("--only=".length);
		} else {
			throw new Error(`Unknown build argument: ${arg}`);
		}
	}
	return { profile, only };
}

// ── Subcommand: package ───────────────────────────────────────────

const packageCmd: Subcommand = {
	name: "package",
	summary: "Tar.gz existing build artifacts and write SHA256SUMS.txt",
	usage: `forge package [--profile=<release|debug>]

Packages every binary found in <outDir>/<profile>/ into a .tar.gz with
the same base name, then writes a SHA256SUMS.txt manifest verifiable
with 'sha256sum -c SHA256SUMS.txt'.

Options:
  --profile=<release|debug>   Which profile directory to package (default: release)
  --release                   Shorthand for --profile=release
  --debug                     Shorthand for --profile=debug`,
	async run(ctx, argv) {
		const { profile } = parsePackageArgs(argv);
		const fromDir = `${ctx.config.outDir}/${profile}`;
		const toDir = `${ctx.config.outDir}/packages`;
		await ensureDir(toDir);

		let entries: string[];
		try {
			entries = await readdir(fromDir);
		} catch {
			throw new Error(
				`No build artifacts in ${fromDir}. Run 'bun forge.ts build --profile=${profile}' first.`,
			);
		}
		const binaries = entries.filter((n) =>
			n.startsWith(`${ctx.config.binary}-`),
		);
		if (binaries.length === 0) {
			throw new Error(`No '${ctx.config.binary}-*' binaries in ${fromDir}`);
		}

		console.log(
			`Packaging ${ctx.config.binary} v${ctx.version} [${profile}] — ${binaries.length} artifact(s)`,
		);
		console.log(`From:    ${fromDir}/`);
		console.log(`To:      ${toDir}/\n`);

		for (const bin of binaries) {
			const archive = `${toDir}/${bin}.tar.gz`;
			process.stdout.write(`  ${bin.padEnd(48)} ... `);
			// -C into the source dir so the tar entry is just the binary name
			await $`tar -czf ${archive} -C ${fromDir} ${bin}`.quiet();
			const bytes = (await stat(archive)).size;
			console.log(`OK (${formatBytes(bytes)})`);
		}

		await writeManifest(toDir);
		console.log(`\nAll ${binaries.length} artifact(s) packaged. Manifest: ${toDir}/SHA256SUMS.txt`);
	},
};

function parsePackageArgs(argv: readonly string[]): { profile: Profile } {
	let profile: Profile = "release";
	for (const arg of argv) {
		if (arg === "--release") profile = "release";
		else if (arg === "--debug") profile = "debug";
		else if (arg.startsWith("--profile=")) {
			const v = arg.slice("--profile=".length);
			if (v !== "release" && v !== "debug") {
				throw new Error(`Invalid --profile: ${v}`);
			}
			profile = v;
		} else {
			throw new Error(`Unknown package argument: ${arg}`);
		}
	}
	return { profile };
}

async function writeManifest(dir: string): Promise<void> {
	const names = (await readdir(dir))
		.filter((n) => n.endsWith(".tar.gz"))
		.sort((a, b) => a.localeCompare(b));
	const lines: string[] = [];
	for (const name of names) {
		const hash = await sha256(`${dir}/${name}`);
		lines.push(`${hash}  ${name}`);
	}
	await Bun.write(`${dir}/SHA256SUMS.txt`, `${lines.join("\n")}\n`);
}

// ── Subcommand: source ────────────────────────────────────────────

const sourceCmd: Subcommand = {
	name: "source",
	summary: "Archive the git-tracked source tree into a tarball",
	usage: `forge source [--ref=<ref>]

Uses 'git archive' so only tracked files are included — .gitignore
patterns (node_modules/, target/, .env files, build artifacts, etc.)
are excluded automatically. Output lands at
<outDir>/packages/<binary>-<version>-source.tar.gz and is added to
the SHA256SUMS.txt manifest alongside any binary archives.

Options:
  --ref=<ref>   Git ref to archive (default: HEAD)`,
	async run(ctx, argv) {
		const { ref } = parseSourceArgs(argv);
		try {
			await $`git rev-parse --git-dir`.quiet();
		} catch {
			throw new Error(
				"'forge source' requires a git repository. Run 'git init' and commit at least once first.",
			);
		}

		const toDir = `${ctx.config.outDir}/packages`;
		await ensureDir(toDir);
		const archive = `${toDir}/${ctx.config.binary}-${ctx.version}-source.tar.gz`;
		const prefix = `${ctx.config.binary}-${ctx.version}/`;

		console.log(
			`Archiving source for ${ctx.config.binary} v${ctx.version} (ref: ${ref})`,
		);
		console.log(`To:      ${archive}\n`);

		process.stdout.write(`  git archive ${ref.padEnd(20)} ... `);
		await $`git archive --format=tar.gz --prefix=${prefix} --output=${archive} ${ref}`.quiet();
		const bytes = (await stat(archive)).size;
		console.log(`OK (${formatBytes(bytes)})`);

		await writeManifest(toDir);
		console.log(`\nSource archived. Manifest: ${toDir}/SHA256SUMS.txt`);
	},
};

function parseSourceArgs(argv: readonly string[]): { ref: string } {
	let ref = "HEAD";
	for (const arg of argv) {
		if (arg.startsWith("--ref=")) {
			ref = arg.slice("--ref=".length);
		} else {
			throw new Error(`Unknown source argument: ${arg}`);
		}
	}
	return { ref };
}

// ── Subcommand: release ───────────────────────────────────────────

const releaseCmd: Subcommand = {
	name: "release",
	summary: "Run build, package, and source (cuts a full release)",
	usage: `forge release [--profile=<release|debug>] [--only=<filter>] [--no-source]

Runs 'build' → 'package' → 'source' in sequence. Exits on first
failure. The source step needs a git repo; pass --no-source to skip
it (e.g. when cutting a dev release before the first commit).`,
	async run(ctx, argv) {
		const skipSource = argv.includes("--no-source");
		const forward = argv.filter((a) => a !== "--no-source");
		await buildCmd.run(ctx, forward);
		// package doesn't take --only; strip it before forwarding
		const pkgArgs = forward.filter(
			(a) => !a.startsWith("--only=") && !a.startsWith("--ref="),
		);
		await packageCmd.run(ctx, pkgArgs);
		if (!skipSource) {
			const srcArgs = forward.filter((a) => a.startsWith("--ref="));
			await sourceCmd.run(ctx, srcArgs);
		}
	},
};

// ── Subcommand: targets ───────────────────────────────────────────

const targetsCmd: Subcommand = {
	name: "targets",
	summary: "List the target matrix resolved from package.json#forge",
	usage: "forge targets",
	async run(ctx) {
		console.log(`Targets for ${ctx.config.binary} v${ctx.version}:`);
		for (const t of ctx.config.targets) {
			console.log(`  ${slugOf(t).padEnd(20)}  (bun: ${t.bunTarget})`);
		}
	},
};

// ── Subcommand: sbom ──────────────────────────────────────────────

const sbomCmd: Subcommand = {
	name: "sbom",
	summary: "Emit a CycloneDX 1.5 SBOM for the dependency tree",
	usage: "forge sbom [--out=path/to/sbom.json]",
	async run(ctx, argv) {
		let outPath = `${ctx.config.outDir}/SBOM.cyclonedx.json`;
		for (let i = 0; i < argv.length; i++) {
			const arg = argv[i];
			if (arg === undefined) continue;
			if (arg.startsWith("--out=")) outPath = arg.slice("--out=".length);
			else if (arg === "--out") {
				const next = argv[i + 1];
				if (next === undefined) throw new Error("--out requires a value");
				outPath = next;
				i += 1;
			}
		}
		const components = await scanNodeModules("./node_modules");
		const bom = {
			bomFormat: "CycloneDX",
			specVersion: "1.5",
			serialNumber: `urn:uuid:${crypto.randomUUID()}`,
			version: 1,
			metadata: {
				timestamp: new Date().toISOString(),
				tools: [{ vendor: "snippy", name: "forge", version: "1.0" }],
				component: {
					type: "application",
					name: ctx.config.binary,
					version: ctx.version,
					purl: `pkg:bun/${ctx.config.binary}@${ctx.version}`,
				},
			},
			components,
		};
		await Bun.write(outPath, JSON.stringify(bom, null, 2));
		console.log(
			`SBOM written: ${outPath} (${components.length} components)`,
		);
	},
};

// Note: bun.lock is JSONC with unquoted keys; rather than ship a bespoke parser we walk
// node_modules/* and read each package.json — same source of truth, fewer surprises.
async function scanNodeModules(
	root: string,
): Promise<{ type: "library"; name: string; version: string; purl: string }[]> {
	const out: { type: "library"; name: string; version: string; purl: string }[] = [];
	const seen = new Set<string>();
	const queue: string[] = [root];
	while (queue.length > 0) {
		const dir = queue.shift();
		if (dir === undefined) break;
		let entries: string[] = [];
		try {
			entries = await readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.startsWith(".")) continue;
			const path = `${dir}/${entry}`;
			if (entry.startsWith("@")) {
				queue.push(path);
				continue;
			}
			try {
				const pkgPath = `${path}/package.json`;
				const pkgJson = (await Bun.file(pkgPath).json()) as { name?: string; version?: string };
				if (typeof pkgJson.name !== "string" || typeof pkgJson.version !== "string") continue;
				const key = `${pkgJson.name}@${pkgJson.version}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({
					type: "library",
					name: pkgJson.name,
					version: pkgJson.version,
					purl: `pkg:npm/${pkgJson.name}@${pkgJson.version}`,
				});
				const nested = `${path}/node_modules`;
				try {
					const st = await stat(nested);
					if (st.isDirectory()) queue.push(nested);
				} catch {}
			} catch {}
		}
	}
	out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return out;
}

// ── Registry ──────────────────────────────────────────────────────
// Add future subcommands (sign, notarize, docker, publish) to this
// list — dispatch and help pick them up automatically.

const SUBCOMMANDS: readonly Subcommand[] = [
	buildCmd,
	packageCmd,
	sourceCmd,
	releaseCmd,
	sbomCmd,
	targetsCmd,
];

// ── Dispatch ──────────────────────────────────────────────────────

function topLevelHelp(): string {
	const width = Math.max(...SUBCOMMANDS.map((c) => c.name.length));
	const lines = [
		"Usage: bun forge.ts <subcommand> [options]",
		"",
		"Subcommands:",
		...SUBCOMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
		"",
		"Run 'bun forge.ts <subcommand> --help' for per-command options.",
	];
	return lines.join("\n");
}

function findSubcommand(name: string): Subcommand | undefined {
	return SUBCOMMANDS.find((c) => c.name === name);
}

async function main(): Promise<void> {
	const [first, ...rest] = Bun.argv.slice(2);
	if (!first || first === "-h" || first === "--help") {
		console.log(topLevelHelp());
		process.exit(0);
	}
	const cmd = findSubcommand(first);
	if (!cmd) {
		console.error(`Unknown subcommand: ${first}`);
		console.error(topLevelHelp());
		process.exit(2);
	}
	if (rest.includes("-h") || rest.includes("--help")) {
		console.log(cmd.usage);
		process.exit(0);
	}

	let ctx: Context;
	try {
		ctx = await loadContext();
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	try {
		await cmd.run(ctx, rest);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

await main();
