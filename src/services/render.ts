import type { Variable } from "../domain/artifact.ts";

export class RenderError extends Error {
	constructor(
		message: string,
		public readonly missing: string[],
	) {
		super(message);
		this.name = "RenderError";
	}
}

export interface RenderInput {
	content: string;
	variables: Variable[];
	bindings: Readonly<Record<string, string>>;
}

export function render({ content, variables, bindings }: RenderInput): string {
	const declared = new Set<string>();
	const resolved = new Map<string, string>();
	const missing: string[] = [];

	for (const v of variables) {
		declared.add(v.name);
		const provided = bindings[v.name];
		if (typeof provided === "string") {
			resolved.set(v.name, provided);
		} else if (typeof v.default === "string") {
			resolved.set(v.name, v.default);
		} else {
			missing.push(v.name);
		}
	}
	for (const [name, value] of Object.entries(bindings)) {
		if (!resolved.has(name)) resolved.set(name, value);
	}

	const re = /\$\{([a-zA-Z_][a-zA-Z0-9_]{0,63})\}/g;
	const output = content.replace(re, (match, name: string) => {
		if (resolved.has(name)) return resolved.get(name) ?? "";
		// Undeclared, unbound placeholders are treated as literal source —
		// only names listed in variables[] or bindings are substituted.
		return match;
	});

	if (missing.length > 0) {
		const unique = [...new Set(missing)];
		throw new RenderError(`Missing bindings for variables: ${unique.join(", ")}`, unique);
	}
	return output;
}
