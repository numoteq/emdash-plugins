/** Script host rewriting, upstream request headers and response rebuilding. */

const encoder = new TextEncoder();

/** Cookies forwarded to sGTM. Everything else stays between the browser and the site. */
const COOKIE_ALLOW = /^(_ga|_gid|_gcl_|_fbp$|_fbc$|FPID$|FPLC$|FPAU$|FPGCL|FPGSID$|_gtmeec$)/;

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
	const last = haystack.length - needle.length;
	outer: for (let index = from; index <= last; index += 1) {
		for (let offset = 0; offset < needle.length; offset += 1) {
			if (haystack[index + offset] !== needle[offset]) continue outer;
		}
		return index;
	}
	return -1;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	return output;
}

/** Byte-level, because container bundles may carry non-ASCII data that re-encoding could corrupt. */
function replaceBytes(input: Uint8Array, from: Uint8Array, to: Uint8Array): Uint8Array {
	const chunks: Uint8Array[] = [];
	let cursor = 0;
	for (
		let found = indexOfBytes(input, from, 0);
		found !== -1;
		found = indexOfBytes(input, from, cursor)
	) {
		chunks.push(input.subarray(cursor, found), to);
		cursor = found + from.length;
	}
	if (cursor === 0) return input;
	chunks.push(input.subarray(cursor));
	return concatBytes(chunks);
}

/**
 * Points a served script at this site: `https://www.googletagmanager.com` becomes
 * `${origin}${prefix}` and the bare host in the container blob becomes `${host}${prefix}`. The
 * escaped `googletagmanager\.com` the container uses for its own hostname check stays untouched.
 */
export function rewriteGtmHosts(
	source: Uint8Array,
	site: { origin: string; host: string; prefix: string },
): Uint8Array {
	const withOrigin = replaceBytes(
		source,
		encoder.encode("https://www.googletagmanager.com"),
		encoder.encode(`${site.origin}${site.prefix}`),
	);
	return replaceBytes(
		withOrigin,
		encoder.encode("www.googletagmanager.com"),
		encoder.encode(`${site.host}${site.prefix}`),
	);
}

export function isJavaScript(response: Response): boolean {
	const type = response.headers.get("content-type")?.toLowerCase() ?? "";
	return type.includes("javascript") || type.includes("ecmascript");
}

export function filterCookies(header: string | null): string {
	if (!header) return "";
	return header
		.split(";")
		.map((pair) => pair.trim())
		.filter((pair) => pair !== "" && COOKIE_ALLOW.test(pair.split("=", 1)[0]!))
		.join("; ");
}

/** Drops Cloudflare headers, narrows cookies and records the original client and host. */
export function upstreamHeaders(request: Request, clientIp: string | undefined): Headers {
	const url = new URL(request.url);
	const headers = new Headers();
	for (const [name, value] of request.headers) {
		if (name.startsWith("cf-") || name === "cookie" || name === "x-forwarded-for") continue;
		headers.set(name, value);
	}
	const cookie = filterCookies(request.headers.get("cookie"));
	if (cookie !== "") headers.set("cookie", cookie);
	if (clientIp) headers.set("x-forwarded-for", clientIp);
	headers.set("x-forwarded-host", url.host);
	headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
	return headers;
}

/**
 * Wraps a new body in the upstream response's status and headers. Length, encoding and validators
 * describe the old body and are dropped; every `Set-Cookie` is kept.
 */
export function rebuildResponse(
	response: Response,
	body: Uint8Array,
	overrides: Record<string, string> = {},
): Response {
	const headers = new Headers();
	for (const [name, value] of response.headers) {
		if (["set-cookie", "content-length", "content-encoding", "etag"].includes(name)) continue;
		headers.set(name, value);
	}
	for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
	for (const [name, value] of Object.entries(overrides)) headers.set(name, value);
	return new Response(body as BodyInit, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
