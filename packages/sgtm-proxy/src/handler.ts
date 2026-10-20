import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect";

import { decodeToken } from "./codec.js";
import { SgtmConfig, type SgtmUpstream } from "./config.js";
import { encodedPrefix, SGTM_PREFIX, sgtmLoaderPath } from "./paths.js";
import {
	concatBytes,
	isJavaScript,
	rebuildResponse,
	rewriteGtmHosts,
	upstreamHeaders,
} from "./rewrite.js";
import { renderShim } from "./shim.js";

const encoder = new TextEncoder();

const LOADER_TIMEOUT = Duration.seconds(10);
const REQUEST_TIMEOUT = Duration.seconds(5);
const LOADER_TTL_SECONDS = 300;

/** sGTM did not answer in time, could not be reached, or answered the loader with a 5xx. */
export class UpstreamUnavailable extends Schema.TaggedError<UpstreamUnavailable>()(
	"UpstreamUnavailable",
	{ reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** The encoded path segment is not a token the shim issued. */
export class InvalidToken extends Schema.TaggedError<InvalidToken>()("InvalidToken", {}) {}

/** The sGTM container, reached through a binding or a base URL. */
export class Upstream extends Context.Service<
	Upstream,
	{
		readonly fetch: (
			path: string,
			init: RequestInit,
		) => Effect.Effect<Response, UpstreamUnavailable>;
	}
>()("@numoteq/sgtm-proxy/Upstream") {
	static layer(upstream: SgtmUpstream | URL): Layer.Layer<Upstream> {
		// A VPC binding routes by its own configuration, so the host of the URL is a placeholder.
		const send = (path: string, init: RequestInit) =>
			upstream instanceof URL
				? fetch(new URL(path, upstream), init)
				: upstream.fetch(new Request(`http://sgtm.internal${path}`, init));
		return Layer.succeed(Upstream, {
			fetch: (path, init) =>
				Effect.tryPromise({
					try: (signal) => send(path, { ...init, signal }),
					catch: (cause) => new UpstreamUnavailable({ reason: "fetch failed", cause }),
				}),
		});
	}
}

/** Shared cache for the assembled loader, so not every page view pulls gtm.js through the tunnel. */
export class LoaderCache extends Context.Service<
	LoaderCache,
	{
		readonly get: (key: string) => Effect.Effect<Option.Option<Response>>;
		readonly put: (key: string, response: Response) => Effect.Effect<void>;
	}
>()("@numoteq/sgtm-proxy/LoaderCache") {
	/** The Workers Cache API; a no-op where it does not exist. Failures only cost a cache miss. */
	static readonly workers: Layer.Layer<LoaderCache> = Layer.sync(LoaderCache, () => {
		const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
		return {
			get: (key) =>
				cache
					? Effect.tryPromise(() => cache.match(key)).pipe(
							Effect.map(Option.fromNullishOr),
							Effect.orElseSucceed(() => Option.none()),
						)
					: Effect.succeedNone,
			put: (key, response) =>
				cache ? Effect.tryPromise(() => cache.put(key, response)).pipe(Effect.ignore) : Effect.void,
		};
	});
}

export type Route = "loader" | "encoded" | "denied";

/** Which of the proxy's paths `url` is, or `null` when the request belongs to the site. */
export function routeOf(url: URL): Route | null {
	if (url.pathname === sgtmLoaderPath(url.host)) return "loader";
	if (url.pathname.startsWith(encodedPrefix(url.host))) return "encoded";
	if (url.pathname === SGTM_PREFIX || url.pathname.startsWith(`${SGTM_PREFIX}/`)) return "denied";
	return null;
}

const empty = (status: number) => new Response(null, { status });

const timeout = (duration: Duration.Duration) =>
	Effect.timeoutOrElse({
		duration,
		orElse: () => Effect.fail(new UpstreamUnavailable({ reason: "timeout" })),
	});

/** Rewrites script hosts so the container loads its dependencies first-party; `shim` goes in front. */
const servedScript = (request: Request, response: Response, shim?: string) =>
	Effect.tryPromise({
		try: () => response.arrayBuffer(),
		catch: (cause) => new UpstreamUnavailable({ reason: "body read failed", cause }),
	}).pipe(
		Effect.map((buffer) => {
			const url = new URL(request.url);
			const body = rewriteGtmHosts(new Uint8Array(buffer), {
				origin: url.origin,
				host: url.host,
				prefix: SGTM_PREFIX,
			});
			if (shim === undefined) return rebuildResponse(response, body);
			return rebuildResponse(response, concatBytes([encoder.encode(shim), body]), {
				"content-type": "application/javascript; charset=utf-8",
				"cache-control": `public, max-age=${LOADER_TTL_SECONDS}`,
			});
		}),
	);

/**
 * gtm.js with the shim in front. Retried, because loading it twice is harmless; cached unless the
 * request is a server-side preview or sGTM sets cookies on it.
 */
const serveLoader = Effect.fnUntraced(function* (request: Request, clientIp: string | undefined) {
	const { gtmId } = yield* SgtmConfig;
	const upstream = yield* Upstream;
	const cache = yield* LoaderCache;
	const url = new URL(request.url);
	const key = new URL(url.pathname, url).href;
	const cacheable = !request.headers.has("x-gtm-server-preview");

	if (cacheable) {
		const cached = yield* cache.get(key);
		if (Option.isSome(cached)) {
			yield* Effect.annotateCurrentSpan("sgtm.cache", "hit");
			return cached.value;
		}
	}

	const loader = yield* upstream
		.fetch(`${SGTM_PREFIX}/gtm.js?id=${encodeURIComponent(gtmId)}`, {
			headers: upstreamHeaders(request, clientIp),
			redirect: "manual",
		})
		.pipe(
			Effect.filterOrFail(
				(answer) => answer.status < 500,
				(answer) => new UpstreamUnavailable({ reason: `HTTP ${answer.status}` }),
			),
			Effect.flatMap((answer) =>
				answer.ok && isJavaScript(answer)
					? servedScript(request, answer, renderShim(encodedPrefix(url.host)))
					: Effect.succeed(answer),
			),
			timeout(LOADER_TIMEOUT),
			Effect.retry({ times: 2, schedule: Schedule.exponential("200 millis") }),
		);

	if (cacheable && loader.ok && isJavaScript(loader) && !loader.headers.has("set-cookie")) {
		yield* Effect.annotateCurrentSpan("sgtm.cache", "miss");
		yield* cache.put(key, loader.clone());
	}
	return loader;
});

/** A decoded browser request, forwarded once: retrying a hit could count it twice. */
const forwardEncoded = Effect.fnUntraced(function* (
	request: Request,
	clientIp: string | undefined,
) {
	const upstream = yield* Upstream;
	const url = new URL(request.url);
	const target = decodeToken(url.pathname.slice(encodedPrefix(url.host).length));
	if (target === null) return yield* new InvalidToken();

	const hasBody = request.method !== "GET" && request.method !== "HEAD";
	return yield* upstream
		.fetch(target, {
			method: request.method,
			headers: upstreamHeaders(request, clientIp),
			body: hasBody ? request.body : null,
			redirect: "manual",
			...(hasBody ? { duplex: "half" } : {}),
		})
		.pipe(
			// Scripts the container loads itself, such as gtag.js, need their hosts rewritten too.
			Effect.flatMap((response) =>
				response.ok && isJavaScript(response)
					? servedScript(request, response)
					: Effect.succeed(response),
			),
			timeout(REQUEST_TIMEOUT),
		);
});

/**
 * Answers the loader, encoded requests and everything else under the prefix (404: the shim never
 * sends plain requests). `None` means the request belongs to the site.
 */
export const handle = (request: Request) => {
	const route = routeOf(new URL(request.url));
	if (route === null) return Effect.succeedNone;
	const clientIp = request.headers.get("cf-connecting-ip") ?? undefined;

	const routed: Effect.Effect<
		Response,
		UpstreamUnavailable | InvalidToken,
		SgtmConfig | Upstream | LoaderCache
	> =
		route === "loader"
			? serveLoader(request, clientIp)
			: route === "encoded"
				? forwardEncoded(request, clientIp)
				: Effect.succeed(empty(404));

	return routed.pipe(
		Effect.catchTags({
			InvalidToken: () => Effect.succeed(empty(400)),
			UpstreamUnavailable: (error) =>
				Effect.logWarning(`sgtm upstream unavailable: ${error.reason}`).pipe(
					Effect.annotateLogs({
						route,
						cause: error.cause === undefined ? undefined : String(error.cause),
					}),
					Effect.as(empty(502)),
				),
		}),
		Effect.map(Option.some),
		Effect.withSpan("sgtm.request", { attributes: { "sgtm.route": route } }),
	);
};

/** Without sGTM the loader is an empty script, so pages load quietly; nothing else is served. */
export function handleDisabled(request: Request): Response | null {
	const route = routeOf(new URL(request.url));
	if (route === null) return null;
	if (route !== "loader") return empty(404);
	return new Response("", {
		headers: {
			"content-type": "application/javascript; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}
