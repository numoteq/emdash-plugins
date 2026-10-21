/**
 * Browser-visible paths, derived from the site host so the page and the Worker agree without any
 * shared configuration. Dependency-free: `@numoteq/sgtm-proxy/client` ships this file alone.
 */

/**
 * Marks the requests the shim encodes; the path of the web container's `server_container_url`.
 * Never sent by the browser, and stripped before forwarding, so sGTM sees its default paths.
 */
export const SGTM_PREFIX = "/_sgtm";

/** Mixed into the hash. Changing it moves every site to new paths. */
const LABEL = "sgtm-proxy/1";

/** FNV-1a, 32 bits. Only has to look random per site, not resist an attacker. */
function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index += 1) {
		hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193);
	}
	return hash >>> 0;
}

function pathHash(host: string): string {
	return fnv1a(`${LABEL}\n${host.toLowerCase()}`).toString(36);
}

/** The `<script src>` that loads the container, e.g. `sgtmLoaderPath(location.host)`. */
export function sgtmLoaderPath(host: string): string {
	return `/${pathHash(host)}.js`;
}

/** `/<hash>/`: prefix of an encoded browser request. */
export function encodedPrefix(host: string): string {
	return `/${pathHash(host)}/`;
}
