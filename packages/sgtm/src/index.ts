import {
	DEFAULT_COOKIE_ALLOW,
	DEFAULT_PREFIX,
	decodeTarget,
	derivePaths,
	normalizePrefix,
	type SgtmPathOptions,
} from "./codec.js";
import {
	buildUpstreamHeaders,
	concatBytes,
	isJavaScript,
	rebuildResponse,
	rewriteGtmHosts,
} from "./rewrite.js";
import { renderSgtmShim } from "./shim.js";

const encoder = new TextEncoder();

/** Anything with a Workers `fetch`: a VPC service binding, a service binding or a plain object. */
export interface SgtmUpstream {
	fetch(request: Request): Promise<Response>;
}

export interface SgtmOptions {
	/** sGTM upstream: a fetch-capable binding (Workers VPC / service binding) or a base URL string. */
	upstream: SgtmUpstream | string;
	/** Web GTM container id, e.g. `GTM-NTQ37T97`. It never appears in a browser URL. */
	gtmId: string;
	/** Per-site secret; all public paths are derived from it with HMAC-SHA256. Rotating it changes every path. */
	secret: string;
	/** Path prefix routed to sGTM, default `/k7`. Must equal the Server container URL path in GTM. */
	prefix?: string;
	/** Cookie names forwarded to sGTM. Defaults to the analytics and first-party GTM cookies. */
	cookieAllow?: RegExp;
}

/** Returns `null` when the request is not ours, so the site can handle it. */
export type SgtmHandler = (request: Request, clientIp?: string) => Promise<Response | null>;

/** The subset of Astro's `APIContext` this middleware needs. */
export interface SgtmAstroContext {
	request: Request;
	locals?: unknown;
}

/** Compatible with Astro's `defineMiddleware` and `middleware.outer`. */
export type SgtmMiddleware = (
	context: SgtmAstroContext,
	next: () => Promise<Response>,
) => Promise<Response>;

export type { SgtmPathOptions };

function absoluteBase(upstream: string): URL {
	const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(upstream) ? upstream : `https://${upstream}`;
	return new URL(value);
}

function badRequest(): Response {
	return new Response("Bad request", {
		status: 400,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

interface ForwardOptions {
	request: Request;
	clientIp: string | undefined;
	upstream: SgtmUpstream | string;
	upstreamBase: URL | null;
	cookieAllow: RegExp;
	/** Path (with query) to send upstream, including the sGTM prefix. */
	target: string;
	origin: string;
	host: string;
	prefix: string;
	/** Prepended to a JavaScript response; only the loader path has one. */
	shim?: string;
}

async function forward(options: ForwardOptions): Promise<Response> {
	const { request } = options;
	const headers = buildUpstreamHeaders(request, options.clientIp, options.cookieAllow);
	const init: RequestInit & { duplex?: "half" } = {
		method: request.method,
		headers,
		redirect: "manual",
	};
	if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
		init.body = request.body;
		init.duplex = "half";
	}

	const response =
		typeof options.upstream === "string"
			? await fetch(new URL(options.target, options.upstreamBase ?? options.upstream), init)
			: await options.upstream.fetch(new Request(`http://sgtm.internal${options.target}`, init));

	if (!response.ok || response.status === 204 || response.status === 304) return response;
	if (!isJavaScript(response.headers.get("content-type"))) return response;

	const rewritten = rewriteGtmHosts(new Uint8Array(await response.arrayBuffer()), {
		origin: options.origin,
		host: options.host,
		prefix: options.prefix,
	});
	const body =
		options.shim === undefined ? rewritten : concatBytes([encoder.encode(options.shim), rewritten]);
	const contentType =
		options.shim === undefined ? undefined : "application/javascript; charset=utf-8";
	return rebuildResponse(response, body, contentType);
}

/**
 * Handles the loader path, encoded requests and plain requests under the sGTM prefix. Requests
 * outside the prefix return `null`; sGTM itself only ever sees a normal request.
 */
export function createSgtmHandler(options: SgtmOptions): SgtmHandler {
	const prefix = normalizePrefix(options.prefix ?? DEFAULT_PREFIX);
	const cookieAllow = options.cookieAllow ?? DEFAULT_COOKIE_ALLOW;
	const upstreamBase = typeof options.upstream === "string" ? absoluteBase(options.upstream) : null;
	// Validates the prefix and secret now and warms the per-secret cache.
	const pathsPromise = derivePaths({ secret: options.secret, prefix });

	return async (request, clientIp) => {
		const paths = await pathsPromise;
		const url = new URL(request.url);
		const pathname = url.pathname;

		let target: string;
		let shim: string | undefined;

		if (pathname === paths.loaderPath) {
			target = `${paths.prefix}/gtm.js?id=${encodeURIComponent(options.gtmId)}`;
			shim = renderSgtmShim(paths);
		} else if (pathname === paths.encodedPrefix || pathname.startsWith(`${paths.encodedPrefix}/`)) {
			const decoded = decodeTarget(
				pathname.slice(paths.encodedPrefix.length + 1),
				paths.seed,
				paths.prefix,
			);
			if (decoded === null) return badRequest();
			target = decoded;
		} else if (pathname === paths.prefix || pathname.startsWith(`${paths.prefix}/`)) {
			// Plain traffic under the prefix: service worker files, fallbacks, direct hits.
			target = `${pathname}${url.search}`;
		} else {
			return null;
		}

		return forward({
			request,
			clientIp,
			upstream: options.upstream,
			upstreamBase,
			cookieAllow,
			target,
			origin: url.origin,
			host: url.host,
			prefix: paths.prefix,
			shim,
		});
	};
}

/** The URL to put in the `<script src>`: `/k7/<hash>.js`. */
export async function sgtmLoaderPath(options: SgtmPathOptions): Promise<string> {
	return (await derivePaths(options)).loaderPath;
}

function middlewareEnv(context: SgtmAstroContext): unknown {
	const locals = context.locals as Record<string, unknown> | undefined;
	const runtime = locals?.["runtime"] as { env?: unknown } | undefined;
	// Astro's Cloudflare adapter puts the Worker env on `locals.runtime.env`.
	return runtime?.env ?? locals?.["env"] ?? locals ?? {};
}

/**
 * Astro `onRequest` middleware. Calls the handler and otherwise `next()`; the client IP comes from
 * `cf-connecting-ip`. Pass a function of the Worker env to read secrets per request.
 */
export function sgtmMiddleware(
	options: SgtmOptions | ((env: unknown) => SgtmOptions),
): SgtmMiddleware {
	let currentOptions: SgtmOptions | undefined;
	let currentHandler: SgtmHandler | undefined;

	return async (context, next) => {
		const resolved = typeof options === "function" ? options(middlewareEnv(context)) : options;
		if (resolved !== currentOptions) {
			currentOptions = resolved;
			currentHandler = createSgtmHandler(resolved);
		}

		const clientIp = context.request.headers.get("cf-connecting-ip") ?? undefined;
		const response = await currentHandler!(context.request, clientIp);
		return response ?? (await next());
	};
}
