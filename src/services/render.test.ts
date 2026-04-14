import { describe, expect, test } from "bun:test";
import { RenderError, render } from "./render.ts";

describe("render", () => {
	test("substitutes declared variables from bindings", () => {
		const out = render({
			content: "hello ${name}",
			variables: [{ name: "name" }],
			bindings: { name: "world" },
		});
		expect(out).toBe("hello world");
	});

	test("falls back to variable default when binding omitted", () => {
		const out = render({
			content: "count=${n}",
			variables: [{ name: "n", default: "0" }],
			bindings: {},
		});
		expect(out).toBe("count=0");
	});

	test("collects ALL missing variables in one error (not fail-fast)", () => {
		try {
			render({
				content: "${a}-${b}-${c}-${a}",
				variables: [{ name: "a" }, { name: "b" }, { name: "c" }],
				bindings: { b: "two" },
			});
			throw new Error("expected RenderError");
		} catch (e) {
			expect(e).toBeInstanceOf(RenderError);
			if (e instanceof RenderError) {
				expect(e.missing.sort()).toEqual(["a", "c"]);
			}
		}
	});

	test("binding overrides default", () => {
		const out = render({
			content: "${x}",
			variables: [{ name: "x", default: "fallback" }],
			bindings: { x: "override" },
		});
		expect(out).toBe("override");
	});

	test("leaves malformed placeholders intact", () => {
		const out = render({
			content: "$a and ${1bad} and ${ }",
			variables: [],
			bindings: {},
		});
		expect(out).toBe("$a and ${1bad} and ${ }");
	});

	test("handles content without any placeholders", () => {
		const out = render({
			content: "plain text",
			variables: [{ name: "unused", default: "x" }],
			bindings: {},
		});
		expect(out).toBe("plain text");
	});

	test("leaves undeclared, unbound placeholders as literal source", () => {
		// e.g. a stored TypeScript file with template literals like `${target.bunTarget}`
		// must NOT be treated as snippy variables — only declared/bound names substitute.
		const out = render({
			content: "console.log(`hi ${who}`); const t = `${target.x}`;",
			variables: [{ name: "who" }],
			bindings: { who: "World" },
		});
		expect(out).toBe("console.log(`hi World`); const t = `${target.x}`;");
	});

	test("extra bindings (not in variables[]) still substitute", () => {
		const out = render({
			content: "a=${a} b=${b}",
			variables: [{ name: "a" }],
			bindings: { a: "1", b: "2" },
		});
		expect(out).toBe("a=1 b=2");
	});
});
