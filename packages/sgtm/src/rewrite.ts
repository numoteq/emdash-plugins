/** Host rewriting for served scripts, request-header filtering and response pass-through. */

const encoder = new TextEncoder();

const GTM_ORIGIN = "https://www.googletagmanager.com";
const GTM_HOST = "www.googletagmanager.com";

export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
	const last = haystack.length - needle.length;
	outer: for (let index = Math.max(from, 0); index <= last; index += 1) {
		for (let offset = 0; offset < needle.length; offset += 1) {
			if (haystack[index + offset] !== needle[offset]) continue outer;
		}
		return index;
	}
	return -1;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const chunk of chunks) length += chunk.length;
	const output = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	return output;
}

/**
 * Replaces every occurrence of `from` with `to`. Byte-level, because container bundles are large and
 * may carry non-ASCII data; decoding and re-encoding them would risk corrupting it.
 */
export function replaceBytes(input: Uint8Array, from: Uint8Array, to: Uint8Array): Uint8Array {
	if (from.length === 0) return input;
	const chunks: Uint8Array[] = [];
	let cursor = 0;
	let found = indexOfBytes(input, from, cursor);
	if (found === -1) return input;
	while (found !== -1) {
		chunks.push(input.subarray(cursor, found), to);
		cursor = found + from.length;
		found = indexOfBytes(input, from, cursor);
	}
	chunks.push(input.subarray(cursor));
	return concatBytes(chunks);
}

/**
 * Points the container host inside a served script at this site.
 *
 * `https://www.googletagmanager.com` becomes `${origin}${prefix}` and the bare host string that the
 * container blob carries becomes `${host}${prefix}`. The escaped-dot regex `googletagmanager\.com`
 * that the container uses for its own hostname check is not a bare host, so it stays untouched.
 */
export function rewriteGtmHosts(
	source: Uint8Array,
	options: { origin: string; host: string; prefix: string },
): Uint8Array {
	const withOrigin = replaceBytes(
		source,
		encoder.encode(GTM_ORIGIN),
		encoder.encode(`${options.origin}${options.prefix}`),
	);
	return replaceBytes(
		withOrigin,
		encoder.encode(GTM_HOST),
		encoder.encode(`${options.host}${options.prefix}`),
	);
}

export function isJavaScript(contentType: string | null): boolean {
	if (!contentType) return false;
	const value = contentType.toLowerCase();
	return value.includes("javascript") || value.includes("ecmascript");
}

/** Keeps only the cookies an allow list matches; sGTM writes the rest as first-party cookies. */
export function filterCookies(header: string | null, allow: RegExp): string {
	if (!header) return "";
	const kept: string[] = [];
	for (const pair of header.split(";")) {
		const trimmed = pair.trim();
		if (trimmed === "") continue;
		const separator = trimmed.indexOf("=");
		const name = separator === -1 ? trimmed : trimmed.slice(0, separator);
		allow.lastIndex = 0;
		if (allow.test(name)) kept.push(trimmed);
	}
	return kept.join("; ");
}

/** Drops Cloudflare headers, narrows cookies and records the original client and host. */
export function buildUpstreamHeaders(
	request: Request,
	clientIp: string | undefined,
	cookieAllow: RegExp,
): Headers {
	const headers = new Headers(request.headers);
	const names: string[] = [];
	headers.forEach((_value, name) => names.push(name));
	for (const name of names) {
		if (name.toLowerCase().startsWith("cf-")) headers.delete(name);
	}

	headers.delete("cookie");
	const cookie = filterCookies(request.headers.get("cookie"), cookieAllow);
	if (cookie !== "") headers.set("cookie", cookie);

	const url = new URL(request.url);
	headers.delete("x-forwarded-for");
	if (clientIp) headers.set("x-forwarded-for", clientIp);
	headers.set("x-forwarded-host", request.headers.get("host") ?? url.host);
	headers.set("x-forwarded-proto", url.protocol.replace(/:$/, ""));
	return headers;
}

/** `Headers.getSetCookie` where available, with a fallback for older runtimes. */
export function getSetCookies(headers: Headers): string[] {
	const helper = headers as Headers & { getSetCookie?: () => string[] };
	if (typeof helper.getSetCookie === "function") return helper.getSetCookie();
	const single = headers.get("set-cookie");
	return single ? [single] : [];
}

/**
 * Rebuilds a response around a new body, preserving the status and every `Set-Cookie` header.
 * Length, encoding and validator headers describe the old body and are dropped; `cache-control` is
 * kept so the upstream caching policy still applies.
 */
export function rebuildResponse(
	response: Response,
	body: Uint8Array,
	contentType?: string,
): Response {
	const headers = new Headers();
	for (const [name, value] of response.headers) {
		const lower = name.toLowerCase();
		if (lower === "set-cookie" || lower === "content-length" || lower === "content-encoding")
			continue;
		if (lower === "etag") continue;
		headers.set(name, value);
	}
	for (const cookie of getSetCookies(response.headers)) headers.append("set-cookie", cookie);
	if (contentType) headers.set("content-type", contentType);

	return new Response(body as unknown as BodyInit, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
