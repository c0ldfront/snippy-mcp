import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Artifact, Kind } from "../domain/artifact.ts";
import type { ArtifactRepo } from "../repo/artifact-repo.ts";
import { RenderError, render } from "../services/render.ts";
import type { ServerDeps } from "./deps.ts";
import { SNIPPY_ERROR_CODES, snippyMcpError } from "./errors.ts";

const bindingsHint =
	'Optional JSON object of `{variableName: value}` bindings. Example: `{"projectName": "acme"}`.';

function resolveArtifact(repo: ArtifactRepo, kind: Kind, name: string): Artifact {
	const artifact = repo.getByName(kind, name);
	if (artifact === null) {
		throw snippyMcpError({
			code: SNIPPY_ERROR_CODES.NotFound,
			message: `${kind} not found: ${name}`,
			data: { kind, name },
		});
	}
	return artifact;
}

function parseBindings(raw: string | undefined): Readonly<Record<string, string>> {
	if (raw === undefined || raw.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw snippyMcpError({
			code: SNIPPY_ERROR_CODES.InvalidBindings,
			message: "bindings must be a JSON object",
		});
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw snippyMcpError({
			code: SNIPPY_ERROR_CODES.InvalidBindings,
			message: "bindings must be a JSON object",
		});
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(parsed)) {
		if (typeof v !== "string") {
			throw snippyMcpError({
				code: SNIPPY_ERROR_CODES.InvalidBindings,
				message: `binding ${k} must be a string`,
				data: { binding: k },
			});
		}
		out[k] = v;
	}
	return out;
}

export function registerPrompts(server: McpServer, deps: ServerDeps): void {
	const { repo } = deps;

	server.registerPrompt(
		"apply-standard",
		{
			title: "Apply a coding standard",
			description:
				"Returns a message array that instructs the assistant to apply a named standard to the current task, optionally targeting a language.",
			argsSchema: {
				name: z.string().describe("Standard name (matches artifact kind='standard')"),
				targetLanguage: z
					.string()
					.optional()
					.describe("Optional language to scope the standard to"),
			},
		},
		(args) => {
			const standard = resolveArtifact(repo, "standard", args.name);
			const header = args.targetLanguage
				? `Apply the following standard when writing ${args.targetLanguage}.`
				: "Apply the following standard to the current task.";
			const body = `# ${standard.name}\n\n${standard.description || ""}\n\n${standard.content}`;
			return {
				description: `Apply the "${standard.name}" standard`,
				messages: [
					{
						role: "user",
						content: { type: "text", text: `${header}\n\n${body}` },
					},
				],
			};
		},
	);

	server.registerPrompt(
		"reuse-snippet",
		{
			title: "Reuse a snippet with bindings",
			description:
				"Renders a named snippet with provided bindings and returns a message array that seeds the assistant with the resulting code.",
			argsSchema: {
				name: z.string().describe("Snippet name (matches artifact kind='snippet')"),
				bindings: z.string().optional().describe(bindingsHint),
			},
		},
		(args) => {
			const snippet = resolveArtifact(repo, "snippet", args.name);
			const bindings = parseBindings(args.bindings);
			let content: string;
			try {
				content = render({
					content: snippet.content,
					variables: snippet.variables,
					bindings,
				});
			} catch (err) {
				if (err instanceof RenderError) {
					throw snippyMcpError({
						code: SNIPPY_ERROR_CODES.RenderMissingBindings,
						message: err.message,
						data: { missing: err.missing },
					});
				}
				throw err;
			}
			const lang = snippet.language ?? "";
			const fenced = `\`\`\`${lang}\n${content}\n\`\`\``;
			const intro = `Reuse the "${snippet.name}" snippet, adapted to the caller's bindings:`;
			return {
				description: `Reuse the "${snippet.name}" snippet`,
				messages: [
					{
						role: "user",
						content: { type: "text", text: `${intro}\n\n${fenced}` },
					},
				],
			};
		},
	);
}
