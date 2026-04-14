import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export const SNIPPY_ERROR_CODES = {
	NotFound: "snippy.notFound",
	NameConflict: "snippy.nameConflict",
	AliasConflict: "snippy.aliasConflict",
	TooManyAliases: "snippy.tooManyAliases",
	InvalidName: "snippy.invalidName",
	InvalidBindings: "snippy.invalidBindings",
	RenderMissingBindings: "snippy.renderMissingBindings",
	RootViolation: "snippy.rootViolation",
	NoRootsAdvertised: "snippy.noRootsAdvertised",
	OverwriteRefused: "snippy.overwriteRefused",
	RevisionMissing: "snippy.revisionMissing",
	LegacyCursor: "snippy.legacyCursor",
	MalformedCursor: "snippy.malformedCursor",
	SearchCursorQueryMismatch: "snippy.searchCursorQueryMismatch",
	ImportLineInvalid: "snippy.importLineInvalid",
	Unauthorized: "snippy.unauthorized",
	Forbidden: "snippy.forbidden",
	WorkspaceUnknown: "snippy.workspaceUnknown",
	Cancelled: "snippy.cancelled",
} as const;

export type SnippyErrorCode = (typeof SNIPPY_ERROR_CODES)[keyof typeof SNIPPY_ERROR_CODES];

interface SnippyMcpErrorOptions {
	code: SnippyErrorCode;
	message: string;
	data?: Record<string, unknown>;
	mcpCode?: ErrorCode;
}

export function snippyMcpError(opts: SnippyMcpErrorOptions): McpError {
	const data: Record<string, unknown> = { ...(opts.data ?? {}), snippyCode: opts.code };
	return new McpError(opts.mcpCode ?? ErrorCode.InvalidParams, opts.message, data);
}
