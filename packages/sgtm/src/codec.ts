/**
 * Path derivation and request-token codec.
 *
 * Every browser-visible path is an HMAC-SHA256 derivation of the per-site secret, so a filter list
 * cannot hardcode it. Rotating the secret changes all of them.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Path prefix routed to sGTM. Must match the Server container URL path configured in GTM. */
export const DEFAULT_PREFIX = "/k7";

/** Cookies forwarded to sGTM by default. Everything else stays between the browser and the site. */
export const DEFAULT_COOKIE_ALLOW =
	/^(_ga|_gid|_gcl_|_fbp$|_fbc$|FPID$|FPLC$|FPAU$|FPGCL|FPGSID$|_gtmeec$)/;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_VALUES = new Map<string, number>(
	Array.from(BASE64URL_ALPHABET, (character, value) => [character, value]),
);

export interface SgtmPathOptions {
	/** Per-site secret; all public paths are derived from it with HMAC-SHA256. */
	secret: string;
	/** Path prefix routed to sGTM, default `/k7`. */
	prefix?: string;
}

export interface DerivedPaths {
	prefix: string;
	/** `/k7/<hash>.js` – the script the site loads instead of `gtm.js`. */
	loaderPath: string;
	/** `/k7/<hash>` – prefix of an encoded browser request. */
	encodedPrefix: string;
	/** 32-bit constant mixed into the shim's token keystream. Obfuscation, not security. */
	seed: number;
}

/** Normalizes a configured prefix to a leading slash and no trailing slash. */
export function normalizePrefix(prefix: string): string {
	const value = prefix.trim();
	if (!value.startsWith("/")) {
		throw new Error(`[sgtm] prefix must start with "/" (got "${prefix}").`);
	}
	const normalized = value.replace(/\/+$/, "");
	if (normalized === "") {
		throw new Error('[sgtm] prefix must not be "/"; use a dedicated path such as "/k7".');
	}
	if (normalized.includes("?") || normalized.includes("#") || normalized.includes("//")) {
		throw new Error(`[sgtm] prefix must be a plain single path (got "${prefix}").`);
	}
	return normalized;
}

/** URL-safe base64 without padding, so tokens survive path segments unchanged. */
export function base64url(bytes: Uint8Array): string {
	let output = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index]!;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		output += BASE64URL_ALPHABET.charAt(first >> 2);
		if (second === undefined) {
			output += BASE64URL_ALPHABET.charAt((first & 0b11) << 4);
			break;
		}
		output += BASE64URL_ALPHABET.charAt(((first & 0b11) << 4) | (second >> 4));
		if (third === undefined) {
			output += BASE64URL_ALPHABET.charAt((second & 0b1111) << 2);
			break;
		}
		output += BASE64URL_ALPHABET.charAt(((second & 0b1111) << 2) | (third >> 6));
		output += BASE64URL_ALPHABET.charAt(third & 0b111111);
	}
	return output;
}

/** Returns `null` for anything that is not unpadded base64url. */
export function fromBase64url(text: string): Uint8Array | null {
	if (text.length === 0) return null;
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const character of text) {
		const value = BASE64URL_VALUES.get(character);
		if (value === undefined) return null;
		buffer = (buffer << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0b11111111);
		}
	}
	return Uint8Array.from(bytes);
}

/** `mulberry32`, byte-for-byte identical to the copy baked into the shim. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value = (value + Math.imul(value ^ (value >>> 7), value | 61)) ^ value;
		return (value ^ (value >>> 14)) >>> 0;
	};
}

/** XORs `data` with a 4-bytes-per-word keystream. */
export function xorKeystream(data: Uint8Array, seed: number): Uint8Array {
	const next = mulberry32(seed);
	const output = new Uint8Array(data.length);
	for (let index = 0; index < data.length; index += 4) {
		const word = next();
		for (let offset = 0; offset < 4 && index + offset < data.length; offset += 1) {
			output[index + offset] = data[index + offset]! ^ ((word >>> (8 * offset)) & 0b11111111);
		}
	}
	return output;
}

/** Big-endian 32-bit view of the first four bytes. */
function toWord(bytes: Uint8Array, offset = 0): number {
	return (
		((bytes[offset]! << 24) |
			(bytes[offset + 1]! << 16) |
			(bytes[offset + 2]! << 8) |
			bytes[offset + 3]!) >>>
		0
	);
}

/** First six bytes as base 36, the short label used in derived paths. */
function toBase36(bytes: Uint8Array): string {
	let value = 0;
	for (const byte of bytes) value = value * 256 + byte;
	return value.toString(36);
}

async function hmac(secret: string, label: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(label));
	return new Uint8Array(signature);
}

const derivedCache = new Map<string, Promise<DerivedPaths>>();

/** Derives (and caches) the loader path, encoded prefix and shim seed for a secret. */
export function derivePaths(options: SgtmPathOptions): Promise<DerivedPaths> {
	const prefix = normalizePrefix(options.prefix ?? DEFAULT_PREFIX);
	const secret = options.secret;
	if (!secret) {
		throw new Error("[sgtm] secret must not be empty.");
	}

	const cacheKey = `${prefix}\n${secret}`;
	const cached = derivedCache.get(cacheKey);
	if (cached) return cached;

	const derived = (async (): Promise<DerivedPaths> => {
		const [loaderLabel, encodedLabel, seedLabel] = await Promise.all([
			hmac(secret, "loader"),
			hmac(secret, "e"),
			hmac(secret, "shim"),
		]);
		return {
			prefix,
			loaderPath: `${prefix}/${toBase36(loaderLabel.subarray(0, 6))}.js`,
			encodedPrefix: `${prefix}/${toBase36(encodedLabel.subarray(0, 6))}`,
			seed: toWord(seedLabel),
		};
	})();

	derivedCache.set(cacheKey, derived);
	// A failing derivation must not be cached; secrets rotate rarely, so the cache stays small.
	derived.catch(() => derivedCache.delete(cacheKey));
	if (derivedCache.size > 64) {
		const oldest = derivedCache.keys().next().value;
		if (oldest !== undefined && oldest !== cacheKey) derivedCache.delete(oldest);
	}
	return derived;
}

/**
 * Wraps `pathname + search` into a shim token: `base64url(salt || XOR(utf8(plain), keystream(salt)))`.
 * The keystream is seeded from a random 4-byte salt XOR the secret-derived seed, so the salt can
 * travel inside the token. This is obfuscation, not encryption.
 */
export function encodeToken(plain: string, salt: Uint8Array, seed: number): string {
	const masked = xorKeystream(encoder.encode(plain), (toWord(salt.subarray(0, 4)) ^ seed) >>> 0);
	const token = new Uint8Array(4 + masked.length);
	token.set(salt.subarray(0, 4), 0);
	token.set(masked, 4);
	return base64url(token);
}

/** Reverses {@link encodeToken}. Returns `null` for anything malformed. */
export function decodeToken(token: string, seed: number): string | null {
	const bytes = fromBase64url(token);
	if (!bytes || bytes.length < 5) return null;
	const salt = toWord(bytes.subarray(0, 4));
	const plain = xorKeystream(bytes.subarray(4), (salt ^ seed) >>> 0);
	return decoder.decode(plain);
}

/**
 * Decodes a token and returns the path to forward, or `null` when the plaintext is not a canonical
 * path under the prefix. Canonicality is what keeps a crafted token from escaping the prefix with
 * `..`, backslashes or an absolute URL.
 */
export function decodeTarget(token: string, seed: number, prefix: string): string | null {
	const plain = decodeToken(token, seed);
	if (plain === null) return null;

	let parsed: URL;
	try {
		parsed = new URL(plain, "https://sgtm.invalid");
	} catch {
		return null;
	}
	if (parsed.origin !== "https://sgtm.invalid") return null;
	if (`${parsed.pathname}${parsed.search}` !== plain) return null;
	if (!parsed.pathname.startsWith(`${prefix}/`)) return null;
	return plain;
}
