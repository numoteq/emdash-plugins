import { Context, Layer } from "effect";

import { type UpstreamName } from "./paths.js";
import { decodePart, GtmId, Upstream } from "./schema.js";
import { toTarget, type UpstreamBinding, type UpstreamInput } from "./upstream.js";

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
	readonly upstreams: Partial<Record<UpstreamName, UpstreamBinding | URL>>;
	/** Why a part is off, in plain language; logged once when the proxy is created. */
	readonly warnings: readonly string[];
}

/** What a missing part costs, used in the one log line that says why it is off. */
const CONSEQUENCE: Record<UpstreamName, string> = {
	sgtm: "the loader serves an empty script and /_sgtm answers 404",
	openpanel: "/_op answers 404",
};

export class ProxyConfig extends Context.Service<ProxyConfig, ResolvedOptions>()(
	"@numoteq/analytics/ProxyConfig",
) {
	static layer(options: ResolvedOptions): Layer.Layer<ProxyConfig> {
		return Layer.succeed(ProxyConfig, options);
	}
}

/** Validates each part on its own; a broken OpenPanel does not take sGTM down with it. */
export function resolveOptions(options: AnalyticsOptions): ResolvedOptions {
	const warnings: string[] = [];
	const gtmId = decodePart(
		GtmId,
		options.gtmId,
		"gtmId",
		"the loader serves an empty script",
		warnings,
	);

	const upstreams: Partial<Record<UpstreamName, UpstreamBinding | URL>> = {};
	const inputs: Record<UpstreamName, UpstreamInput | undefined> = {
		sgtm: options.sgtm,
		openpanel: options.openpanel,
	};
	for (const name of Object.keys(CONSEQUENCE) as UpstreamName[]) {
		const upstream = decodePart(Upstream, inputs[name], name, CONSEQUENCE[name], warnings);
		if (upstream === undefined) continue;
		upstreams[name] = toTarget(upstream);
	}

	return { gtmId, upstreams, warnings };
}
