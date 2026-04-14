import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Artifact, isKind, KIND_VALUES, type Kind } from "../domain/artifact.ts";
import { buildCompleters } from "./completers.ts";
import type { ServerDeps } from "./deps.ts";
import { SNIPPY_ERROR_CODES, snippyMcpError } from "./errors.ts";

const URI_TEMPLATE = "snippet://{workspace}/{kind}/{id}";
const RESOURCE_NAME = "artifact";

const LANGUAGE_MIME: Readonly<Record<string, string>> = {
	typescript: "application/typescript",
	tsx: "application/typescript",
	javascript: "application/javascript",
	jsx: "application/javascript",
	json: "application/json",
	html: "text/html",
	css: "text/css",
	markdown: "text/markdown",
	md: "text/markdown",
	yaml: "application/yaml",
	yml: "application/yaml",
	toml: "application/toml",
	sh: "application/x-sh",
	bash: "application/x-sh",
	python: "text/x-python",
	rust: "text/x-rust",
	go: "text/x-go",
	sql: "application/sql",
};

function mimeTypeFor(artifact: Artifact): string {
	if (artifact.language === null) return "text/plain";
	return LANGUAGE_MIME[artifact.language] ?? "text/plain";
}

function artifactUri(workspace: string, artifact: Artifact): string {
	return `snippet://${workspace}/${artifact.kind}/${artifact.id}`;
}

export function registerResources(server: McpServer, deps: ServerDeps): void {
	const { repo, db } = deps;
	const workspace = deps.workspace ?? "default";
	const completers = db !== undefined ? buildCompleters(db) : null;

	const template = new ResourceTemplate(URI_TEMPLATE, {
		list: () => {
			const resources: {
				uri: string;
				name: string;
				title: string;
				description: string;
				mimeType: string;
				annotations: { audience: ["user", "assistant"]; priority: number };
			}[] = [];
			let cursor: string | null = null;
			do {
				const page = repo.list({ limit: 100, ...(cursor ? { cursor } : {}) });
				for (const artifact of page.artifacts) {
					resources.push({
						uri: artifactUri(workspace, artifact),
						name: `${artifact.kind}/${artifact.name}`,
						title: artifact.name,
						description: artifact.description || `${artifact.kind} ${artifact.name}`,
						mimeType: mimeTypeFor(artifact),
						annotations: { audience: ["user", "assistant"], priority: 0.5 },
					});
				}
				cursor = page.nextCursor;
			} while (cursor !== null);
			return { resources };
		},
		complete: {
			kind: (prefix) => KIND_VALUES.filter((k) => k.startsWith(prefix.toLowerCase())).map((k) => k),
			...(completers !== null ? { id: (prefix: string) => completers.completeId(prefix) } : {}),
		},
	});

	server.registerResource(
		RESOURCE_NAME,
		template,
		{
			title: "snippy-mcp artifact",
			description: "A stored standard, snippet, or resource",
			mimeType: "text/plain",
		},
		(uri, variables) => {
			const kind = asSingle(variables.kind);
			const id = asSingle(variables.id);
			if (!isKind(kind)) {
				throw snippyMcpError({
					code: SNIPPY_ERROR_CODES.InvalidBindings,
					message: `Unknown artifact kind: ${kind}`,
					data: { kind },
				});
			}
			const artifact = repo.getById(id);
			if (artifact === null || artifact.kind !== (kind as Kind)) {
				throw snippyMcpError({
					code: SNIPPY_ERROR_CODES.NotFound,
					message: `Artifact not found at ${uri.href}`,
					data: { uri: uri.href },
				});
			}
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: mimeTypeFor(artifact),
						text: artifact.content,
					},
				],
			};
		},
	);
}

function asSingle(value: string | string[] | undefined): string {
	if (value === undefined) return "";
	return Array.isArray(value) ? (value[0] ?? "") : value;
}
