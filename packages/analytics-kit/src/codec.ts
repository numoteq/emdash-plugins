/**
 * The request token: `base64url(salt + XOR(path, salt repeated))` over the path after the encoded
 * prefix, prefix of the upstream included. The random 4-byte salt makes every token different, so
 * no part of the URL survives as a pattern for filter lists. Obfuscation, not security: the shim
 * carries everything needed to decode it.
 */

function mask(text: string, salt: string): string {
	let output = "";
	for (let index = 0; index < text.length; index += 1) {
		output += String.fromCharCode(text.charCodeAt(index) ^ salt.charCodeAt(index % 4));
	}
	return output;
}

/** `plain` is the ASCII `pathname + search`, starting with an upstream prefix; the shim has a copy. */
export function encodeToken(plain: string, salt: Uint8Array): string {
	const saltText = String.fromCharCode(...salt.subarray(0, 4));
	return btoa(saltText + mask(plain, saltText))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Decodes a token into the internal path, or `null` unless it is a canonical path. Canonicality
 * keeps a crafted token from turning into `..`, `\` or an absolute URL.
 */
export function decodeToken(token: string): string | null {
	if (!/^[A-Za-z0-9_-]{7,}$/.test(token)) return null;
	let bytes: string;
	try {
		bytes = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
	} catch {
		return null;
	}
	const target = mask(bytes.slice(4), bytes.slice(0, 4));

	let parsed: URL;
	try {
		parsed = new URL(target, "https://sgtm.invalid");
	} catch {
		return null;
	}
	if (parsed.origin !== "https://sgtm.invalid") return null;
	if (`${parsed.pathname}${parsed.search}` !== target) return null;
	if (!target.startsWith("/")) return null;
	return target;
}
