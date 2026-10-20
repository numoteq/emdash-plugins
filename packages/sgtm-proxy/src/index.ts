import { Effect, Layer, Logger, ManagedRuntime, Option, Result } from "effect";

import { resolveOptions, SgtmConfig, type SgtmOptions } from "./config.js";
import { handle, handleDisabled, LoaderCache, Upstream } from "./handler.js";

export type { SgtmOptions, SgtmUpstream } from "./config.js";
export { sgtmLoaderPath } from "./paths.js";

/** Answers the proxy's own requests; `null` means the request belongs to the site. */
export type SgtmHandler = (request: Request) => Promise<Response | null>;

const logger = Logger.layer([Logger.consoleJson]);

/**
 * Creates the proxy for one isolate. Incomplete options log why once and turn it off: the loader
 * then answers an empty script, so one build serves production, previews and local development.
 */
export function createSgtmHandler(options: SgtmOptions): SgtmHandler {
	const resolved = resolveOptions(options);
	if (Result.isFailure(resolved)) {
		Effect.runSync(
			Effect.logWarning(`sgtm disabled: ${resolved.failure}`).pipe(Effect.provide(logger)),
		);
		return (request) => Promise.resolve(handleDisabled(request));
	}

	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			SgtmConfig.layer(resolved.success.gtmId),
			Upstream.layer(resolved.success.upstream),
			LoaderCache.workers,
			logger,
		),
	);
	return (request) =>
		runtime.runPromise(handle(request).pipe(Effect.map(Option.getOrNull)), {
			signal: request.signal,
		});
}
