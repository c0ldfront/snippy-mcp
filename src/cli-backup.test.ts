import { afterEach, describe, expect, test } from "bun:test";
import { openDb } from "./db/connection.ts";
import { ArtifactRepo } from "./repo/artifact-repo.ts";

const tmpFiles: string[] = [];
function tmpPath(suffix: string): string {
	const path = `${Bun.env.TMPDIR ?? "/tmp"}/snippy-cli-${crypto.randomUUID()}${suffix}`;
	tmpFiles.push(path);
	return path;
}
afterEach(async () => {
	for (const f of tmpFiles.splice(0)) await Bun.$`rm -rf ${f}`.quiet();
});

async function runCli(
	env: Record<string, string>,
	...args: string[]
): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
}> {
	const proc = Bun.spawn({
		cmd: ["bun", "run", `${import.meta.dir}/cli.ts`, ...args],
		env: { ...process.env, ...env } as Record<string, string>,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

function assertCliOk(
	what: string,
	res: { stdout: string; stderr: string; exitCode: number },
): void {
	if (res.exitCode === 0) return;
	throw new Error(
		`${what} exited ${res.exitCode}\n--- stderr ---\n${res.stderr}\n--- stdout ---\n${res.stdout}`,
	);
}

describe("snippy-mcp backup / restore", () => {
	test("backup writes a usable copy and restore re-applies it onto the source path", async () => {
		const sourceDb = tmpPath(".db");
		const backupOut = tmpPath("-backup.db");

		// Seed the DB directly so we don't depend on the MCP transport for setup.
		const seed = openDb(sourceDb);
		const repo = new ArtifactRepo(seed);
		repo.push({
			kind: "snippet",
			name: "backup-me",
			language: null,
			description: "",
			content: "BEFORE",
			variables: [],
			tags: [],
			dryRun: false,
		});
		seed.close();

		const backup = await runCli({ SNIPPY_DB: sourceDb }, "backup", "--out", backupOut);
		assertCliOk("backup", backup);
		expect(await Bun.file(backupOut).exists()).toBe(true);

		// Mutate the source DB after backup.
		const mid = openDb(sourceDb);
		const midRepo = new ArtifactRepo(mid);
		midRepo.push({
			kind: "snippet",
			name: "backup-me",
			language: null,
			description: "",
			content: "AFTER",
			variables: [],
			tags: [],
			dryRun: false,
		});
		mid.close();

		// Verify mutation persisted.
		const checkMutated = openDb(sourceDb);
		expect(
			checkMutated.query("SELECT content FROM artifacts WHERE name='backup-me'").get(),
		).toEqual({ content: "AFTER" });
		checkMutated.close();

		// Restore — should rewind to BEFORE.
		const restore = await runCli({ SNIPPY_DB: sourceDb }, "restore", "--in", backupOut);
		assertCliOk("restore", restore);

		const checkRestored = openDb(sourceDb);
		expect(
			checkRestored.query("SELECT content FROM artifacts WHERE name='backup-me'").get(),
		).toEqual({ content: "BEFORE" });
		checkRestored.close();
	}, 20_000);
});
