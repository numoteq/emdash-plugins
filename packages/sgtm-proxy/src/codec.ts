/**
 * The request token: `base64url(salt + XOR(path, salt repeated))` over the path after the prefix.
 * The random 4-byte salt makes every token different, so no part of the URL survives as a pattern
 * for filter lists. Obfuscation, not security: the shim carries everything needed to decode it.
 */

import { SGTM_PREFIX } from "./paths.js";

function mask(text: string, salt: string): string {
	let output = "";
	for (let index = 0; index < text.length; index += 1) {
		output += String.fromCharCode(text.charCodeAt(index) ^ salt.charCodeAt(index % 4));
	}
	return output;
}

/** `plain` is the ASCII `pathname + search` after the prefix; the shim has a copy of this. */
export function encodeToken(plain: string, salt: Uint8Array): string {
	const saltText = String.fromCharCode(...salt.subarray(0, 4));
	return btoa(saltText + mask(plain, saltText))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Decodes a token into the path to forward, prefix included, or `null` unless it is a canonical
 * path under the prefix. Canonicality keeps a crafted token from escaping it with `..`, `\` or an
 * absolute URL.
 */
export function decodeToken(token: string): string | null {
	if (!/^[A-Za-z0-9_-]{7,}$/.test(token)) return null;
	let bytes: string;
	try {
		bytes = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
	} catch {
		return null;
	}
	const target = SGTM_PREFIX + mask(bytes.slice(4), bytes.slice(0, 4));

	let parsed: URL;
	try {
		parsed = new URL(target, "https://sgtm.invalid");
	} catch {
		return null;
	}
	if (parsed.origin !== "https://sgtm.invalid") return null;
	if (`${parsed.pathname}${parsed.search}` !== target) return null;
	if (!parsed.pathname.startsWith(`${SGTM_PREFIX}/`)) return null;
	return target;
}
