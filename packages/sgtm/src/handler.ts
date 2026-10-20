import { Context, Data, Duration, Effect, Layer, Option, Schedule } from "effect";

import { decodeToken } from "./codec.js";
import type { SgtmConfig, SgtmUpstream } from "./config.js";
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
export class UpstreamUnavailable extends Data.TaggedError("UpstreamUnavailable")<{
	readonly reason: string;
}> {}

/** The encoded path segment is not a token this site issued. */
export class InvalidToken extends Data.TaggedError("InvalidToken")<{}> {}

/** The sGTM container, reached through a binding or a base URL. */
export class Upstream extends Context.Service<
	Upstream,
	{
		readonly fetch: (
			path: string,
			init: RequestInit,
		) => Effect.Effect<Response, UpstreamUnavailable>;
	}
>()("@numoteq/emdash-plugin-sgtm/Upstream") {
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
					catch: (error) => new UpstreamUnavailable({ reason: String(error) }),
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
>()("@numoteq/emdash-plugin-sgtm/LoaderCache") {
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

type Route = "loader" | "encoded" | "denied";

function routeOf(config: SgtmConfig, pathname: string): Route | null {
	const { paths } = config;
	if (pathname === paths.loaderPath) return "loader";
	if (pathname.startsWith(`${paths.encodedPrefix}/`)) return "encoded";
	if (pathname === paths.prefix || pathname.startsWith(`${paths.prefix}/`)) return "denied";
	return null;
}

const empty = (status: number) => new Response(null, { status });

/** Rewrites script hosts so the container loads its dependencies first-party; `shim` goes in front. */
const servedScript = (request: Request, config: SgtmConfig, response: Response, shim?: string) =>
	Effect.tryPromise({
		try: () => response.arrayBuffer(),
		catch: (error) => new UpstreamUnavailable({ reason: String(error) }),
	}).pipe(
		Effect.map((buffer) => {
			const url = new URL(request.url);
			const body = rewriteGtmHosts(new Uint8Array(buffer), {
				origin: url.origin,
				host: url.host,
				prefix: config.paths.prefix,
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
const serveLoader = Effect.fnUntraced(function* (
	config: SgtmConfig,
	request: Request,
	clientIp: string | undefined,
) {
	const upstream = yield* Upstream;
	const cache = yield* LoaderCache;
	const key = new URL(config.paths.loaderPath, request.url).href;
	const cacheable = !request.headers.has("x-gtm-server-preview");

	if (cacheable) {
		const cached = yield* cache.get(key);
		if (Option.isSome(cached)) {
			yield* Effect.annotateCurrentSpan("sgtm.cache", "hit");
			return cached.value;
		}
	}

	const response = yield* upstream
		.fetch(`${config.paths.prefix}/gtm.js?id=${encodeURIComponent(config.gtmId)}`, {
			headers: upstreamHeaders(request, clientIp),
			redirect: "manual",
		})
		.pipe(
			Effect.filterOrFail(
				(answer) => answer.status < 500,
				(answer) => new UpstreamUnavailable({ reason: `HTTP ${answer.status}` }),
			),
			Effect.timeoutOrElse({
				duration: LOADER_TIMEOUT,
				orElse: () => Effect.fail(new UpstreamUnavailable({ reason: "timeout" })),
			}),
			Effect.retry({ times: 2, schedule: Schedule.exponential("200 millis") }),
		);
	if (!response.ok || !isJavaScript(response)) return response;

	const loader = yield* servedScript(request, config, response, renderShim(config.paths));
	if (cacheable && !loader.headers.has("set-cookie")) {
		yield* Effect.annotateCurrentSpan("sgtm.cache", "miss");
		yield* cache.put(key, loader.clone());
	}
	return loader;
});

/** A decoded browser request, forwarded once: retrying a hit could count it twice. */
const forwardEncoded = Effect.fnUntraced(function* (
	config: SgtmConfig,
	request: Request,
	clientIp: string | undefined,
) {
	const upstream = yield* Upstream;
	const token = new URL(request.url).pathname.slice(config.paths.encodedPrefix.length + 1);
	const target = decodeToken(token, config.paths);
	if (target === null) return yield* new InvalidToken();

	const hasBody = request.method !== "GET" && request.method !== "HEAD";
	const response = yield* upstream
		.fetch(target, {
			method: request.method,
			headers: upstreamHeaders(request, clientIp),
			body: hasBody ? request.body : null,
			redirect: "manual",
			...(hasBody ? { duplex: "half" } : {}),
		})
		.pipe(
			Effect.timeoutOrElse({
				duration: REQUEST_TIMEOUT,
				orElse: () => Effect.fail(new UpstreamUnavailable({ reason: "timeout" })),
			}),
		);
	// Scripts the container loads itself, such as gtag.js, need their hosts rewritten too.
	return response.ok && isJavaScript(response)
		? yield* servedScript(request, config, response)
		: response;
});

/**
 * Answers the loader, encoded requests and everything else under the prefix (404: plain requests
 * would be blocked anyway, and refusing them disables the GTM service worker). `None` means the
 * request is not ours.
 */
export const handle = (config: SgtmConfig, request: Request, clientIp: string | undefined) => {
	const route = routeOf(config, new URL(request.url).pathname);
	if (route === null) return Effect.succeedNone;

	const routed: Effect.Effect<
		Response,
		UpstreamUnavailable | InvalidToken,
		Upstream | LoaderCache
	> =
		route === "loader"
			? serveLoader(config, request, clientIp)
			: route === "encoded"
				? forwardEncoded(config, request, clientIp)
				: Effect.succeed(empty(404));

	const answered = routed.pipe(
		Effect.catchTags({
			InvalidToken: () => Effect.succeed(empty(400)),
			UpstreamUnavailable: (error) =>
				Effect.logWarning("sgtm upstream unavailable").pipe(
					Effect.annotateLogs({ reason: error.reason }),
					Effect.as(empty(502)),
				),
		}),
	);

	return answered.pipe(
		Effect.timed,
		Effect.tap(([duration, response]) =>
			Effect.logInfo("sgtm").pipe(
				Effect.annotateLogs({
					route,
					method: request.method,
					status: response.status,
					ms: Math.round(Duration.toMillis(duration)),
				}),
			),
		),
		Effect.map(([, response]) => Option.some(response)),
		Effect.withSpan("sgtm.request", { attributes: { "sgtm.route": route } }),
	);
};
