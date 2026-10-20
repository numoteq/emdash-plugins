/**
 * Derived paths and the request-token codec.
 *
 * Every browser-visible path is a hash of the GTM container id, so no two sites share a path and
 * the id itself never appears in a URL (filter lists match `GTM-`). This is obfuscation against
 * static URL patterns, not security: the shim carries everything needed to decode a token.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_VALUES = new Map<string, number>(
	Array.from(BASE64URL_ALPHABET, (character, value) => [character, value]),
);

export interface DerivedPaths {
	/** Path prefix routed to sGTM, e.g. `/k7`. */
	readonly prefix: string;
	/** `/k7/<hash>.js`: the script the site loads instead of `gtm.js`. */
	readonly loaderPath: string;
	/** `/k7/<hash>`: prefix of an encoded browser request. */
	readonly encodedPrefix: string;
	/** 32-bit constant mixed into the token keystream. */
	readonly seed: number;
}

/** `cyrb53`: a fast 53-bit string hash. Only has to look random, not resist an attacker. */
function hash53(input: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < input.length; index += 1) {
		const code = input.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (h2 & 0x1fffff) + (h1 >>> 0);
}

export function derivePaths(gtmId: string, prefix: string, pathSalt: string): DerivedPaths {
	const derive = (label: string) => hash53(`${label}\n${gtmId}\n${pathSalt}`);
	return {
		prefix,
		loaderPath: `${prefix}/${derive("loader").toString(36)}.js`,
		encodedPrefix: `${prefix}/${derive("encoded").toString(36)}`,
		seed: derive("seed") >>> 0,
	};
}

/** URL-safe base64 without padding, so tokens survive as a path segment. */
export function base64url(bytes: Uint8Array): string {
	let output = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index]!;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		output += BASE64URL_ALPHABET.charAt(first >> 2);
		if (second === undefined) {
			output += BASE64URL_ALPHABET.charAt((first & 3) << 4);
			break;
		}
		output += BASE64URL_ALPHABET.charAt(((first & 3) << 4) | (second >> 4));
		if (third === undefined) {
			output += BASE64URL_ALPHABET.charAt((second & 15) << 2);
			break;
		}
		output += BASE64URL_ALPHABET.charAt(((second & 15) << 2) | (third >> 6));
		output += BASE64URL_ALPHABET.charAt(third & 63);
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
			bytes.push((buffer >> bits) & 255);
		}
	}
	return Uint8Array.from(bytes);
}

/** `mulberry32`, identical to the copy in the shim. */
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

/** XORs `data` with a keystream of four bytes per `mulberry32` word. */
export function xorKeystream(data: Uint8Array, seed: number): Uint8Array {
	const next = mulberry32(seed);
	const output = new Uint8Array(data.length);
	for (let index = 0; index < data.length; index += 4) {
		const word = next();
		for (let offset = 0; offset < 4 && index + offset < data.length; offset += 1) {
			output[index + offset] = data[index + offset]! ^ ((word >>> (8 * offset)) & 255);
		}
	}
	return output;
}

function toWord(bytes: Uint8Array): number {
	return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
}

/**
 * `base64url(salt || XOR(utf8(plain), keystream(salt ^ seed)))`. The random 4-byte salt makes every
 * token different, so no part of the original URL survives as a pattern.
 */
export function encodeToken(plain: string, salt: Uint8Array, seed: number): string {
	const masked = xorKeystream(encoder.encode(plain), (toWord(salt) ^ seed) >>> 0);
	const token = new Uint8Array(4 + masked.length);
	token.set(salt.subarray(0, 4), 0);
	token.set(masked, 4);
	return base64url(token);
}

/**
 * Decodes a token into the path to forward, or `null` unless it is a canonical path under the
 * prefix. Canonicality keeps a crafted token from escaping it with `..`, `\` or an absolute URL.
 */
export function decodeToken(token: string, paths: DerivedPaths): string | null {
	const bytes = fromBase64url(token);
	if (!bytes || bytes.length < 5) return null;
	const plain = decoder.decode(
		xorKeystream(bytes.subarray(4), (toWord(bytes.subarray(0, 4)) ^ paths.seed) >>> 0),
	);

	let parsed: URL;
	try {
		parsed = new URL(plain, "https://sgtm.invalid");
	} catch {
		return null;
	}
	if (parsed.origin !== "https://sgtm.invalid") return null;
	if (`${parsed.pathname}${parsed.search}` !== plain) return null;
	if (!parsed.pathname.startsWith(`${paths.prefix}/`)) return null;
	return plain;
}
