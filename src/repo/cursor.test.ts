import { describe, expect, test } from "bun:test";
import {
	decodeListCursor,
	decodeSearchCursor,
	encodeListCursor,
	encodeSearchCursor,
	LegacySearchCursorError,
	MalformedCursorError,
} from "./cursor.ts";

function encodeBase64UrlJson(value: unknown): string {
	const bin = new TextEncoder().encode(JSON.stringify(value));
	let s = "";
	for (const b of bin) s += String.fromCharCode(b);
	return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

describe("list cursor", () => {
	test("roundtrips", () => {
		const c = encodeListCursor({ updatedAt: 12345, id: "abc" });
		expect(decodeListCursor(c)).toEqual({ t: "list", updatedAt: 12345, id: "abc" });
	});
	test("returns undefined on malformed input", () => {
		expect(decodeListCursor("not-base64-json")).toBeUndefined();
	});
	test("rejects a search cursor as a list cursor", () => {
		const search = encodeSearchCursor({ q: "x", r: 0, id: 1 });
		expect(decodeListCursor(search)).toBeUndefined();
	});
});

describe("search cursor", () => {
	test("roundtrips", () => {
		const c = encodeSearchCursor({ q: "needle", r: -1.5, id: 42 });
		expect(decodeSearchCursor(c)).toEqual({
			t: "search",
			v: 2,
			q: "needle",
			r: -1.5,
			id: 42,
		});
	});

	test("legacy offset cursors throw LegacySearchCursorError", () => {
		const legacy = encodeBase64UrlJson({ t: "search", offset: 5 });
		expect(() => decodeSearchCursor(legacy)).toThrow(LegacySearchCursorError);
	});

	test("malformed shapes throw MalformedCursorError", () => {
		const garbage = encodeBase64UrlJson({ t: "search", v: 99 });
		expect(() => decodeSearchCursor(garbage)).toThrow(MalformedCursorError);
	});
});
