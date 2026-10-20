import { Effect, Layer, ManagedRuntime, Option, Result } from "effect";

import { resolveConfig, type SgtmOptions } from "./config.js";
import { handle, LoaderCache, Upstream } from "./handler.js";

export type { SgtmOptions, SgtmUpstream } from "./config.js";

/** The subset of Astro's `APIContext` the middleware needs. */
export interface SgtmAstroContext {
	readonly request: Request;
}

/** Compatible with Astro's `defineMiddleware` and EmDash's `middleware.outer`. */
export type SgtmMiddleware = (
	context: SgtmAstroContext,
	next: () => Promise<Response>,
) => Promise<Response>;

/**
 * The `<script src>` that loads the container, or `undefined` when the options are incomplete, so
 * the page never points at a loader the middleware does not answer.
 */
export function sgtmLoaderPath(options: SgtmOptions): string | undefined {
	return Result.getOrUndefined(resolveConfig(options))?.paths.loaderPath;
}

/**
 * Astro middleware that answers everything under the prefix and passes the rest to `next()`.
 * `options` may be a function: it runs on the first request, where Worker bindings are available,
 * and the result is kept for the isolate. Incomplete options log why once and turn the proxy off.
 */
export function sgtmMiddleware(options: SgtmOptions | (() => SgtmOptions)): SgtmMiddleware {
	let proxy:
		| ((request: Request, clientIp: string | undefined) => Promise<Response | null>)
		| null
		| undefined;

	const start = () => {
		const config = resolveConfig(typeof options === "function" ? options() : options);
		if (Result.isFailure(config)) {
			Effect.runSync(Effect.logWarning(`sgtm disabled: ${config.failure}`));
			return null;
		}
		const runtime = ManagedRuntime.make(
			Layer.merge(Upstream.layer(config.success.upstream), LoaderCache.workers),
		);
		return (request: Request, clientIp: string | undefined) =>
			runtime.runPromise(
				handle(config.success, request, clientIp).pipe(Effect.map(Option.getOrNull)),
			);
	};

	return async (context, next) => {
		if (proxy === undefined) proxy = start();
		const response =
			proxy &&
			(await proxy(context.request, context.request.headers.get("cf-connecting-ip") ?? undefined));
		return response ?? next();
	};
}
