import type { AstroIntegration } from "astro";

export interface SgtmAstroOptions {
	/** Worker var with the id of the web container (`GTM-…`). Default `GTM_ID`. */
	readonly gtmIdVar?: string;
	/** Workers VPC or service binding that reaches sGTM. Default `SGTM_UPSTREAM`. */
	readonly upstreamBinding?: string;
}

const MIDDLEWARE_ID = "virtual:@numoteq/sgtm-proxy/middleware";

/**
 * The middleware is generated, so `cloudflare:workers` is only imported by the site's own build.
 * The handler is created on the first request, where the env is guaranteed to exist.
 */
function middlewareSource(gtmIdVar: string, upstreamBinding: string): string {
	return `import { env } from "cloudflare:workers";
import { createSgtmHandler } from "@numoteq/sgtm-proxy";

let handler;

export async function onRequest(context, next) {
	handler ??= createSgtmHandler({
		gtmId: env[${JSON.stringify(gtmIdVar)}],
		upstream: env[${JSON.stringify(upstreamBinding)}],
	});
	return (await handler(context.request)) ?? next();
}
`;
}

/**
 * Serves the proxy from Astro middleware that runs before every other middleware. The web
 * container id and the sGTM binding are read from the Worker env at runtime, so one build serves
 * every environment; without them the proxy is off.
 */
export function sgtm(options: SgtmAstroOptions = {}): AstroIntegration {
	const source = middlewareSource(
		options.gtmIdVar ?? "GTM_ID",
		options.upstreamBinding ?? "SGTM_UPSTREAM",
	);
	return {
		name: "@numoteq/sgtm-proxy",
		hooks: {
			"astro:config:setup": ({ addMiddleware, updateConfig }) => {
				updateConfig({
					vite: {
						plugins: [
							{
								name: "@numoteq/sgtm-proxy",
								resolveId: (id) => (id === MIDDLEWARE_ID ? `\0${MIDDLEWARE_ID}` : undefined),
								load: (id) => (id === `\0${MIDDLEWARE_ID}` ? source : undefined),
							},
						],
					},
				});
				addMiddleware({ order: "pre", entrypoint: MIDDLEWARE_ID });
			},
		},
	};
}
