const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;

function encodeTime(ms: number): string {
	let time = ms;
	const out = new Array<string>(TIME_LEN);
	for (let i = TIME_LEN - 1; i >= 0; i--) {
		const mod = time % 32;
		out[i] = ALPHABET[mod] ?? "0";
		time = Math.floor(time / 32);
	}
	return out.join("");
}

function encodeRandom(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < RAND_LEN; i++) {
		const b = bytes[i] ?? 0;
		out += ALPHABET[b % 32] ?? "0";
	}
	return out;
}

export function newId(now: number = Date.now()): string {
	const bytes = new Uint8Array(RAND_LEN);
	crypto.getRandomValues(bytes);
	return encodeTime(now) + encodeRandom(bytes);
}

export function isValidId(value: string): boolean {
	if (value.length !== TIME_LEN + RAND_LEN) return false;
	for (const ch of value) if (!ALPHABET.includes(ch)) return false;
	return true;
}
