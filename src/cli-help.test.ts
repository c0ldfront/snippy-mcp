import { describe, expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { helpText, VERSION } from "./cli.ts";
import { FORMATS } from "./cli-generate.ts";

async function runCli(...args: string[]): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
}> {
	const proc = Bun.spawn({
		cmd: ["bun", "run", `${import.meta.dir}/cli.ts`, ...args],
		env: { ...process.env, SNIPPY_DB: "/tmp/should-not-open.db" } as Record<string, string>,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("snippy-mcp --help / --version", () => {
	test("VERSION matches package.json", () => {
		expect(VERSION).toBe(pkg.version);
	});

	test("helpText lists every subcommand and every generate format", () => {
		const text = helpText();
		for (const sub of ["--stdio", "--http", "audit tail", "backup", "restore", "generate"]) {
			expect(text).toContain(sub);
		}
		for (const f of FORMATS) expect(text).toContain(f);
		expect(text).toContain(`snippy-mcp ${VERSION}`);
	});

	test("--help prints usage to stdout and exits 0 without opening the DB", async () => {
		const { stdout, exitCode } = await runCli("--help");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage:");
		expect(stdout).toContain(`snippy-mcp ${VERSION}`);
	});

	test("-h is an alias for --help", async () => {
		const { stdout, exitCode } = await runCli("-h");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage:");
	});

	test("--version prints the version to stdout and exits 0", async () => {
		const { stdout, exitCode } = await runCli("--version");
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe(VERSION);
	});

	test("-v is an alias for --version", async () => {
		const { stdout, exitCode } = await runCli("-v");
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe(VERSION);
	});
});
