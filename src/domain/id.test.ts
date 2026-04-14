import { describe, expect, test } from "bun:test";
import { isValidId, newId } from "./id.ts";

describe("newId", () => {
	test("produces a 26-char Crockford-base32 id", () => {
		const id = newId();
		expect(id).toHaveLength(26);
		expect(isValidId(id)).toBe(true);
	});
	test("is monotonic across timestamps (time prefix sorts)", () => {
		const a = newId(1000);
		const b = newId(2000);
		expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
	});
	test("is unique across many invocations", () => {
		const set = new Set<string>();
		for (let i = 0; i < 1000; i++) set.add(newId());
		expect(set.size).toBe(1000);
	});
});

describe("isValidId", () => {
	test("rejects wrong length", () => {
		expect(isValidId("ABC")).toBe(false);
	});
	test("rejects invalid characters (I, L, O, U excluded)", () => {
		expect(isValidId("IIIIIIIIIIIIIIIIIIIIIIIIII")).toBe(false);
	});
});
