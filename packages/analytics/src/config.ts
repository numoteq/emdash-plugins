import { Context, Layer, Result } from "effect";

import { type UpstreamName } from "./paths.js";
import { decodePart, GtmId, Upstream } from "./schema.js";
import { toTarget, type UpstreamInput, type UpstreamTarget } from "./upstream.js";

export type { UpstreamBinding, UpstreamInput } from "./upstream.js";

/**
 * What a site passes in, usually straight from its Worker env. Every part is optional and turns
 * only itself off when missing, so previews and local development stay quiet while a site can run
 * the proxy without OpenPanel or without server-side GTM.
 */
export interface AnalyticsOptions {
	/** Id of the web container (`GTM-…`) whose `gtm.js` is loaded, not of the server container. */
	readonly gtmId?: string | undefined;
	/** Server-side GTM: a Workers VPC or service binding, or a base URL. */
	readonly sgtm?: UpstreamInput | undefined;
	/** OpenPanel: a Workers VPC or service binding, or a base URL of the instance. */
	readonly openpanel?: UpstreamInput | undefined;
}

export interface ResolvedOptions {
	readonly gtmId: string | undefined;
	readonly upstreams: Partial<Record<UpstreamName, UpstreamTarget>>;
	/** Why a part is off, in plain language; logged once when the proxy is created. */
	readonly warnings: readonly string[];
}

/** What a missing part costs, used in the one log line that says why it is off. */
const CONSEQUENCE = {
	sgtm: "the loader serves an empty script and /_sgtm answers 404",
	openpanel: "/_op answers 404",
} as const;

export class ProxyConfig extends Context.Service<ProxyConfig, ResolvedOptions>()(
	"@numoteq/analytics/ProxyConfig",
) {
	static layer(options: ResolvedOptions): Layer.Layer<ProxyConfig> {
		return Layer.succeed(ProxyConfig, options);
	}
}

/** Validates each part on its own; a broken OpenPanel does not take sGTM down with it. */
export function resolveOptions(options: AnalyticsOptions): ResolvedOptions {
	const gtmId = decodePart(GtmId, options.gtmId, "gtmId", "the loader serves an empty script");
	const sgtm = decodePart(Upstream, options.sgtm, "sgtm", CONSEQUENCE.sgtm);
	const openpanel = decodePart(Upstream, options.openpanel, "openpanel", CONSEQUENCE.openpanel);

	return {
		gtmId: Result.isSuccess(gtmId) ? gtmId.success : undefined,
		upstreams: {
			...(Result.isSuccess(sgtm) ? { sgtm: toTarget(sgtm.success) } : {}),
			...(Result.isSuccess(openpanel) ? { openpanel: toTarget(openpanel.success) } : {}),
		},
		warnings: [gtmId, sgtm, openpanel].flatMap((part) =>
			Result.isFailure(part) ? [part.failure] : [],
		),
	};
}
