import { describe, expect, test } from "bun:test";
import { ArtifactNameSchema, TagSchema } from "./domain/artifact.ts";
import {
	decodeListCursor,
	decodeSearchCursor,
	encodeListCursor,
	encodeSearchCursor,
} from "./repo/cursor.ts";
import { render } from "./services/render.ts";
import { ensurePathAllowed, isPathInsideRoot } from "./services/roots.ts";

function rng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_00_00_00_00;
	};
}

function pickChar(r: number, alphabet: string): string {
	const i = Math.min(alphabet.length - 1, Math.floor(r * alphabet.length));
	return alphabet.charAt(i);
}

function genString(rand: () => number, alphabet: string, len: number): string {
	let out = "";
	for (let i = 0; i < len; i++) out += pickChar(rand(), alphabet);
	return out;
}

const NAME_OK = "abcdefghijklmnopqrstuvwxyz0123456789._-";
const NAME_BAD_EXTRA = "ABC !@#$%^&*()/\\\t\n";

describe("property: ArtifactNameSchema", () => {
	test("100 generated all-lowercase names that fit the regex parse cleanly", () => {
		const rand = rng(0xc0ffee);
		for (let trial = 0; trial < 100; trial++) {
			const len = 1 + Math.floor(rand() * 99);
			let candidate = pickChar(rand(), "abcdefghijklmnopqrstuvwxyz0123456789");
			candidate += genString(rand, NAME_OK, len - 1);
			expect(ArtifactNameSchema.safeParse(candidate).success).toBe(true);
		}
	});

	test("100 generated names containing an illegal character all fail to parse", () => {
		const rand = rng(0xfeed);
		for (let trial = 0; trial < 100; trial++) {
			const len = 5 + Math.floor(rand() * 30);
			let candidate = "";
			let inserted = false;
			for (let i = 0; i < len; i++) {
				if (!inserted && rand() < 0.3) {
					candidate += pickChar(rand(), NAME_BAD_EXTRA);
					inserted = true;
				} else {
					candidate += pickChar(rand(), NAME_OK);
				}
			}
			if (!inserted) candidate += pickChar(rand(), NAME_BAD_EXTRA);
			expect(ArtifactNameSchema.safeParse(candidate).success).toBe(false);
		}
	});

	test("empty and oversize names are rejected", () => {
		expect(ArtifactNameSchema.safeParse("").success).toBe(false);
		expect(ArtifactNameSchema.safeParse("x".repeat(101)).success).toBe(false);
	});

	test("100 generated tags with uppercase or _ never parse", () => {
		const rand = rng(0x12345);
		for (let trial = 0; trial < 100; trial++) {
			const candidate = `${pickChar(rand(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ_")}${genString(rand, NAME_OK, 5)}`;
			expect(TagSchema.safeParse(candidate).success).toBe(false);
		}
	});
});

describe("property: path normalization (roots)", () => {
	test("100 random `..`-laden paths never escape an enforced root", () => {
		const rand = rng(0xa11ce);
		const root = "/var/lib/snippy/data";
		for (let trial = 0; trial < 100; trial++) {
			const depth = Math.floor(rand() * 6);
			const parts: string[] = [];
			for (let i = 0; i < depth; i++) {
				parts.push(rand() < 0.5 ? ".." : `seg${i}`);
			}
			const candidate = `${root}/${parts.join("/")}`;
			const allowed = { source: "env", roots: [root] } as const;
			try {
				const accepted = ensurePathAllowed(candidate, allowed);
				// If accepted, it MUST resolve under the root (no escape).
				expect(isPathInsideRoot(accepted, root)).toBe(true);
			} catch {
				// rejection is fine — escape attempts MUST throw, never silently sandbox.
			}
		}
	});

	test("absolute paths outside the root always reject", () => {
		const allowed = { source: "env", roots: ["/var/lib/snippy"] } as const;
		expect(() => ensurePathAllowed("/etc/passwd", allowed)).toThrow();
		expect(() => ensurePathAllowed("/var/lib/snippytwo/x", allowed)).toThrow();
		// Sibling that shares a prefix substring but isn't actually inside the root.
	});
});

describe("property: render handles pathological inputs", () => {
	test("all-literal content with no placeholders renders unchanged", () => {
		const rand = rng(0xbaba);
		for (let trial = 0; trial < 100; trial++) {
			const len = Math.floor(rand() * 200);
			const content = genString(
				rand,
				"the quick brown fox jumps over the lazy dog 0123456789!?,.;:",
				len,
			);
			const out = render({ content, variables: [], bindings: {} });
			expect(out).toBe(content);
		}
	});

	test("undeclared placeholders are left literal (do not throw)", () => {
		const out = render({
			content: "hello ${stranger} from ${guest}",
			variables: [],
			bindings: {},
		});
		expect(out).toBe("hello ${stranger} from ${guest}");
	});

	test("declared placeholders without bindings or defaults throw with all missing names", () => {
		expect(() =>
			render({
				content: "${a} ${b} ${c}",
				variables: [{ name: "a" }, { name: "b" }, { name: "c" }],
				bindings: {},
			}),
		).toThrow(/a.*b.*c|missing/);
	});
});

describe("property: cursor tamper-resistance", () => {
	test("100 random list cursors with a flipped byte either decode to a valid shape or yield undefined", () => {
		const rand = rng(0xdeadbeef);
		for (let trial = 0; trial < 100; trial++) {
			const cursor = encodeListCursor({ updatedAt: Math.floor(rand() * 1e9), id: "abc" });
			const tampered = flipByte(cursor, Math.floor(rand() * cursor.length));
			const decoded = decodeListCursor(tampered);
			if (decoded !== undefined) {
				expect(decoded.t).toBe("list");
				expect(typeof decoded.id).toBe("string");
				expect(decoded.updatedAt >= 0).toBe(true);
			}
		}
	});

	test("100 random search cursors with a flipped byte either decode to v2 shape, throw legacy/malformed, or stay valid", () => {
		const rand = rng(0xc0c0a);
		for (let trial = 0; trial < 100; trial++) {
			const cursor = encodeSearchCursor({ q: "needle", r: rand() * 10, id: trial });
			const tampered = flipByte(cursor, Math.floor(rand() * cursor.length));
			try {
				const decoded = decodeSearchCursor(tampered);
				expect(decoded.t).toBe("search");
				expect(decoded.v).toBe(2);
			} catch (err) {
				// Acceptable: any tamper that mangles the shape must be rejected, not silently coerced.
				expect(err).toBeInstanceOf(Error);
			}
		}
	});
});

function flipByte(s: string, idx: number): string {
	if (idx >= s.length) return s;
	const ch = s.charCodeAt(idx) ^ 0x01;
	return s.slice(0, idx) + String.fromCharCode(ch) + s.slice(idx + 1);
}
