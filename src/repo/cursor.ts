import { z } from "zod";

const ListCursorSchema = z.object({
	t: z.literal("list"),
	updatedAt: z.number().int().nonnegative(),
	id: z.string().min(1),
});

const SearchCursorSchema = z.object({
	t: z.literal("search"),
	v: z.literal(2),
	q: z.string(),
	r: z.number(),
	id: z.number().int().nonnegative(),
});

const LegacySearchCursorSchema = z.object({
	t: z.literal("search"),
	offset: z.number().int().nonnegative(),
});

export type ListCursor = z.infer<typeof ListCursorSchema>;
export type SearchCursor = z.infer<typeof SearchCursorSchema>;

export class LegacySearchCursorError extends Error {
	constructor() {
		super(
			"search cursor format changed in v0.2.0; legacy offset-based cursors are no longer supported. Retry the search without a cursor.",
		);
		this.name = "LegacySearchCursorError";
	}
}

export class MalformedCursorError extends Error {
	constructor(readonly kind: "list" | "search") {
		super(`malformed ${kind} cursor`);
		this.name = "MalformedCursorError";
	}
}

function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(cursor: string): Uint8Array {
	let b64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
	while (b64.length % 4 !== 0) b64 += "=";
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode<T>(value: T): string {
	return toBase64Url(encoder.encode(JSON.stringify(value)));
}

function decode(cursor: string): unknown {
	try {
		return JSON.parse(decoder.decode(fromBase64Url(cursor)));
	} catch {
		return undefined;
	}
}

export function encodeListCursor(c: Omit<ListCursor, "t">): string {
	return encode({ t: "list", ...c });
}
export function decodeListCursor(cursor: string): ListCursor | undefined {
	const parsed = ListCursorSchema.safeParse(decode(cursor));
	return parsed.success ? parsed.data : undefined;
}

export function encodeSearchCursor(c: Omit<SearchCursor, "t" | "v">): string {
	return encode({ t: "search", v: 2, ...c });
}

export function decodeSearchCursor(cursor: string): SearchCursor {
	const raw = decode(cursor);
	const parsed = SearchCursorSchema.safeParse(raw);
	if (parsed.success) return parsed.data;
	const legacy = LegacySearchCursorSchema.safeParse(raw);
	if (legacy.success) throw new LegacySearchCursorError();
	throw new MalformedCursorError("search");
}
