import { z } from "zod";

export const KIND_VALUES = ["standard", "snippet", "resource"] as const;
export type Kind = (typeof KIND_VALUES)[number];

const namePattern = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const tagPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const variableNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

export const KindSchema = z.enum(KIND_VALUES);
export const ArtifactNameSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(namePattern, "name must be lowercase alphanumeric with . _ -");
export const TagSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(tagPattern, "tag must be lowercase alphanumeric with -");
export const LanguageSchema = z
	.string()
	.min(1)
	.max(32)
	.regex(/^[a-z0-9+#-]+$/);

export const VariableSchema = z.object({
	name: z.string().regex(variableNamePattern, "variable name must be a C-style identifier"),
	description: z.string().max(500).optional(),
	default: z.string().optional(),
});
export type Variable = z.infer<typeof VariableSchema>;

export const MAX_ALIASES_PER_ARTIFACT = 32;

export const ArtifactSchema = z.object({
	id: z.string().min(1),
	kind: KindSchema,
	name: ArtifactNameSchema,
	language: LanguageSchema.nullable(),
	description: z.string().max(2000),
	content: z.string(),
	variables: z.array(VariableSchema).max(64),
	tags: z.array(TagSchema).max(32),
	aliases: z.array(ArtifactNameSchema).max(MAX_ALIASES_PER_ARTIFACT),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const PushInputSchema = z.object({
	kind: KindSchema,
	name: ArtifactNameSchema,
	language: LanguageSchema.nullable().default(null),
	description: z.string().max(2000).default(""),
	content: z.string(),
	variables: z.array(VariableSchema).max(64).default([]),
	tags: z.array(TagSchema).max(32).default([]),
	dryRun: z.boolean().default(false),
});
export type PushInput = z.infer<typeof PushInputSchema>;

export function isKind(value: unknown): value is Kind {
	return typeof value === "string" && (KIND_VALUES as readonly string[]).includes(value);
}

export function artifactIdentity(a: Pick<Artifact, "kind" | "name">): string {
	return `${a.kind}/${a.name}`;
}

export const RevisionSchema = z.object({
	id: z.string().min(1),
	artifactId: z.string().min(1),
	version: z.number().int().positive(),
	content: z.string(),
	variables: z.array(VariableSchema),
	createdAt: z.number().int().nonnegative(),
});
export type Revision = z.infer<typeof RevisionSchema>;

export function extractTemplateVariables(content: string): string[] {
	const seen = new Set<string>();
	const re = /\$\{([a-zA-Z_][a-zA-Z0-9_]{0,63})\}/g;
	for (const match of content.matchAll(re)) {
		const name = match[1];
		if (name !== undefined) seen.add(name);
	}
	return [...seen];
}
