export type Role = "reader" | "writer" | "admin";

export const ROLES: readonly Role[] = ["reader", "writer", "admin"] as const;

const ROLE_LEVEL: Record<Role, number> = { reader: 0, writer: 1, admin: 2 };

export function roleAllows(actual: Role, required: Role): boolean {
	return ROLE_LEVEL[actual] >= ROLE_LEVEL[required];
}

export interface TokenMap {
	readonly map: ReadonlyMap<string, Role>;
	readonly enabled: boolean;
}

const EMPTY_TOKEN_MAP: TokenMap = { map: new Map(), enabled: false };

export function parseTokens(raw: string | undefined): TokenMap {
	if (raw === undefined || raw.trim() === "") return EMPTY_TOKEN_MAP;
	const map = new Map<string, Role>();
	for (const entry of raw.split(",")) {
		const trimmed = entry.trim();
		if (trimmed === "") continue;
		const idx = trimmed.lastIndexOf(":");
		if (idx <= 0 || idx >= trimmed.length - 1) {
			throw new Error(`SNIPPY_HTTP_TOKENS entry must look like 'token:role': '${trimmed}'`);
		}
		const token = trimmed.slice(0, idx);
		const roleStr = trimmed.slice(idx + 1);
		if (!isRole(roleStr)) {
			throw new Error(`unknown role '${roleStr}' in SNIPPY_HTTP_TOKENS (use reader|writer|admin)`);
		}
		map.set(token, roleStr);
	}
	return { map, enabled: map.size > 0 };
}

export function isRole(value: unknown): value is Role {
	return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function lookupRole(tokens: TokenMap, authHeader: string | null): Role | null {
	if (!tokens.enabled) return "admin";
	if (authHeader === null) return null;
	const trimmed = authHeader.trim();
	const match = /^Bearer\s+(.+)$/i.exec(trimmed);
	if (match === null || match[1] === undefined) return null;
	return tokens.map.get(match[1]) ?? null;
}

export const TOOL_REQUIRED_ROLES: Readonly<Record<string, Role>> = {
	"artifact.get": "reader",
	"artifact.getByName": "reader",
	"artifact.list": "reader",
	"artifact.search": "reader",
	"artifact.history": "reader",
	"artifact.render": "reader",
	"artifact.renderByName": "reader",
	"artifact.export": "reader",
	"artifact.push": "writer",
	"artifact.tag": "writer",
	"artifact.untag": "writer",
	"artifact.rename": "writer",
	"artifact.delete": "admin",
	"artifact.rollback": "admin",
	"artifact.import": "admin",
	"artifact.materialize": "admin",
	"artifact.materializeMany": "admin",
};
