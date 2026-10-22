import { Effect, Layer, Logger, ManagedRuntime, Option } from "effect";

import { ProxyConfig, resolveOptions, type AnalyticsOptions } from "./config.js";
import { handle, ResponseCache, Upstreams } from "./handler.js";

export type { AnalyticsOptions, UpstreamBinding, UpstreamInput } from "./config.js";
export { loaderPath, OPENPANEL_PREFIX, PREFIX, PREFIXES, SGTM_PREFIX } from "./paths.js";
export type { UpstreamName } from "./paths.js";
export {
	createServerEvents,
	gcsOf,
	RequestContext,
	resolveServerEventsOptions,
	send,
	ServerEventRejected,
	ServerEvents,
	ServerEventUnavailable,
} from "./server/index.js";
export type {
	Consent,
	ConsentCategory,
	ServerEvent,
	ServerEventsClient,
	ServerEventsOptions,
	ServerEventsSettings,
} from "./server/index.js";

/** Answers the proxy's own requests; `null` means the request belongs to the site. */
export type ProxyHandler = (request: Request) => Promise<Response | null>;

const logger = Logger.layer([Logger.consoleJson]);

/**
 * Creates the proxy for one isolate. Parts with missing or invalid options log why once and turn
 * themselves off: the loader then serves an empty script and the prefix answers 404, so one build
 * serves production, previews and local development.
 */
export function createProxyHandler(options: AnalyticsOptions): ProxyHandler {
	const resolved = resolveOptions(options);
	if (resolved.warnings.length > 0) {
		Effect.runSync(
			Effect.logWarning(`analytics proxy: ${resolved.warnings.join("; ")}`).pipe(
				Effect.provide(logger),
			),
		);
	}

	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			ProxyConfig.layer(resolved),
			Upstreams.layer(resolved.upstreams),
			ResponseCache.workers,
			logger,
		),
	);
	return async (request) => {
		try {
			return await runtime.runPromise(handle(request).pipe(Effect.map(Option.getOrNull)), {
				signal: request.signal,
			});
		} catch (cause) {
			// An aborted request has nobody to answer; anything else is a bug and stays loud.
			if (request.signal.aborted) return null;
			throw cause;
		}
	};
}
