import { describe, expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { SNIPPY_ERROR_CODES, snippyMcpError } from "./errors.ts";

describe("snippyMcpError", () => {
	test("returns an McpError with snippyCode merged into data", () => {
		const err = snippyMcpError({
			code: SNIPPY_ERROR_CODES.NotFound,
			message: "missing",
			data: { id: "x" },
		});
		expect(err).toBeInstanceOf(McpError);
		expect(err.code).toBe(ErrorCode.InvalidParams);
		expect(err.data).toEqual({ id: "x", snippyCode: "snippy.notFound" });
	});

	test("default mcp code is InvalidParams; can be overridden", () => {
		const err = snippyMcpError({
			code: SNIPPY_ERROR_CODES.Unauthorized,
			message: "no token",
			mcpCode: ErrorCode.MethodNotFound,
		});
		expect(err.code).toBe(ErrorCode.MethodNotFound);
	});

	test("every code is a stable kebab-cased string in the snippy.* namespace", () => {
		for (const code of Object.values(SNIPPY_ERROR_CODES)) {
			expect(code.startsWith("snippy.")).toBe(true);
			expect(code).toMatch(/^[a-z]+\.[a-zA-Z0-9]+$/);
		}
	});
});
