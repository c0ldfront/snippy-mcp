import { z } from "zod";
import {
	ArtifactNameSchema,
	KindSchema,
	LanguageSchema,
	TagSchema,
	VariableSchema,
} from "../domain/artifact.ts";

export const ArtifactOutShape = {
	id: z.string(),
	kind: KindSchema,
	name: ArtifactNameSchema,
	language: LanguageSchema.nullable(),
	description: z.string(),
	content: z.string(),
	variables: z.array(VariableSchema),
	tags: z.array(TagSchema),
	aliases: z.array(ArtifactNameSchema),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
} as const;

export const ArtifactObjectSchema = z.object(ArtifactOutShape);

export const ArtifactListItemSchema = z.object({
	id: z.string(),
	kind: KindSchema,
	name: ArtifactNameSchema,
	language: LanguageSchema.nullable(),
	description: z.string(),
	tags: z.array(TagSchema),
	aliases: z.array(ArtifactNameSchema),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	contentBytes: z.number().int().nonnegative(),
	variableCount: z.number().int().nonnegative(),
	content: z.string().optional(),
	variables: z.array(VariableSchema).optional(),
});

export const PushInputShape = {
	kind: KindSchema,
	name: ArtifactNameSchema,
	language: LanguageSchema.nullable().optional(),
	description: z.string().max(2000).optional(),
	content: z.string(),
	variables: z.array(VariableSchema).max(64).optional(),
	tags: z.array(TagSchema).max(32).optional(),
	dryRun: z.boolean().optional(),
} as const;

export const PushOutputShape = {
	artifact: ArtifactObjectSchema,
	existed: z.boolean(),
	previousUpdatedAt: z.number().int().nonnegative().nullable(),
	dryRun: z.boolean(),
} as const;

export const GetInputShape = { id: z.string().min(1) } as const;
export const GetByNameInputShape = {
	kind: KindSchema,
	name: ArtifactNameSchema,
} as const;
export const GetOutputShape = { artifact: ArtifactObjectSchema } as const;

export const ListInputShape = {
	kind: KindSchema.optional(),
	language: LanguageSchema.optional(),
	tags: z.array(TagSchema).optional(),
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(100).optional(),
	summary: z
		.boolean()
		.default(true)
		.describe("When true (default), omit content and variables to save tokens."),
} as const;

export const SearchInputShape = {
	query: z.string().min(1),
	kind: KindSchema.optional(),
	tags: z.array(TagSchema).optional(),
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(100).optional(),
	summary: z
		.boolean()
		.default(true)
		.describe("When true (default), omit content and variables to save tokens."),
} as const;

export const PageOutputShape = {
	artifacts: z.array(ArtifactListItemSchema),
	nextCursor: z.string().nullable(),
	summary: z.boolean(),
} as const;

export const TagInputShape = {
	id: z.string().min(1),
	tags: z.array(TagSchema).min(1),
} as const;

export const TagOutputShape = { tags: z.array(TagSchema) } as const;

export const DeleteInputShape = { id: z.string().min(1) } as const;
export const DeleteOutputShape = { deleted: z.boolean() } as const;

export const RenameInputShape = {
	id: z.string().min(1),
	newName: ArtifactNameSchema,
} as const;

export const RenameOutputShape = {
	artifact: ArtifactObjectSchema,
	previousName: ArtifactNameSchema,
} as const;

export const RevisionSummarySchema = z.object({
	id: z.string(),
	artifactId: z.string(),
	version: z.number().int().positive(),
	createdAt: z.number().int().nonnegative(),
	contentBytes: z.number().int().nonnegative(),
	variableCount: z.number().int().nonnegative(),
	content: z.string().optional(),
	variables: z.array(VariableSchema).optional(),
});

export const HistoryInputShape = {
	id: z.string().min(1),
	summary: z
		.boolean()
		.default(true)
		.describe("When true (default), omit content and variables from each revision."),
} as const;

export const HistoryOutputShape = {
	artifactId: z.string(),
	revisions: z.array(RevisionSummarySchema),
	summary: z.boolean(),
} as const;

export const RollbackInputShape = {
	id: z.string().min(1),
	toVersion: z.number().int().positive(),
} as const;

export const RollbackOutputShape = {
	artifact: ArtifactObjectSchema,
	newVersion: z.number().int().positive(),
} as const;

export const RenderInputShape = {
	id: z.string().min(1),
	bindings: z.record(z.string(), z.string()).optional(),
} as const;

export const RenderByNameInputShape = {
	kind: KindSchema,
	name: ArtifactNameSchema,
	bindings: z.record(z.string(), z.string()).optional(),
} as const;

export const RenderOutputShape = {
	id: z.string(),
	kind: KindSchema,
	name: ArtifactNameSchema,
	content: z.string(),
} as const;

const ConflictPolicySchema = z.enum(["skip", "overwrite", "error"]);

export const ExportOutputShape = {
	count: z.number().int().nonnegative(),
	ndjson: z.string(),
} as const;

export const ImportInputShape = {
	ndjson: z.string(),
	conflict: ConflictPolicySchema.default("error"),
	includeHistory: z
		.boolean()
		.default(false)
		.describe(
			"When true, if an NDJSON line includes _revisions, replace the artifact's revision history with the provided entries (wipes any existing rows).",
		),
} as const;

export const ImportOutputShape = {
	imported: z.number().int().nonnegative(),
	skipped: z.number().int().nonnegative(),
	overwritten: z.number().int().nonnegative(),
	errors: z.array(z.object({ line: z.number().int().nonnegative(), message: z.string() })),
} as const;

export const ExportInputShape = {
	kind: KindSchema.optional(),
	tags: z.array(TagSchema).optional(),
	includeHistory: z
		.boolean()
		.default(false)
		.describe("When true, emit a `_revisions` array on each line with full revision history."),
} as const;

const MaterializeConflictSchema = z.enum(["skip", "overwrite", "error"]);

export const MaterializeInputShape = {
	id: z.string().min(1).optional(),
	kind: KindSchema.optional(),
	name: ArtifactNameSchema.optional(),
	path: z.string().min(1),
	bindings: z.record(z.string(), z.string()).optional(),
	conflict: MaterializeConflictSchema.default("error"),
	chmodX: z.boolean().default(false),
} as const;

export const MaterializeOutputShape = {
	path: z.string(),
	bytes: z.number().int().nonnegative(),
	sha256: z.string(),
	written: z.boolean(),
	existed: z.boolean(),
	rootSource: z.enum(["client", "env"]),
} as const;

export const MaterializeManyInputShape = {
	ids: z.array(z.string().min(1)).optional(),
	kind: KindSchema.optional(),
	tags: z.array(TagSchema).optional(),
	dir: z.string().min(1),
	bindingsByName: z.record(z.string(), z.record(z.string(), z.string())).optional(),
	conflict: MaterializeConflictSchema.default("error"),
	extension: z.string().min(1).max(16).optional(),
} as const;

export const MaterializeManyOutputShape = {
	written: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			path: z.string(),
			bytes: z.number().int().nonnegative(),
			sha256: z.string(),
		}),
	),
	skipped: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() })),
	errors: z.array(z.object({ id: z.string(), name: z.string(), message: z.string() })),
	rootSource: z.enum(["client", "env"]),
} as const;
