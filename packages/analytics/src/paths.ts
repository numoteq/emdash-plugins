/**
 * Browser-visible paths, derived from the site host so the page and the Worker agree without any
 * shared configuration. Dependency-free: `@numoteq/analytics/client` ships this file alone.
 */

/**
 * Internal prefixes, one per upstream. The browser never sends them as they are: the shim encodes
 * every request under a prefix into a token, and the Worker decodes the prefix back into a route.
 */
export const PREFIX = {
	/** Server-side Google Tag Manager; also the web container's `server_container_url`. */
	sgtm: "/_sgtm",
	/** OpenPanel: the SDK script and its session replay chunks. */
	openpanel: "/_op",
} as const;

export type UpstreamName = keyof typeof PREFIX;

/** Every prefix, in the order the shim checks them. */
export const PREFIXES: readonly (typeof PREFIX)[UpstreamName][] = Object.values(PREFIX);

export const SGTM_PREFIX = PREFIX.sgtm;
export const OPENPANEL_PREFIX = PREFIX.openpanel;

/**
 * The OpenPanel scripts served in the clear, at fixed paths the site can put in a Custom HTML tag.
 * They are not encoded because the SDK derives `op1-replay.js` by rewriting the `src` of `op1.js`,
 * and a token carries no filename. The shim and the Worker share this list.
 */
export const OPENPANEL_SCRIPTS = ["/_op/op1.js", "/_op/op1-replay.js"] as const;

/** Mixed into the hash. Changing it moves every site to new paths. */
const LABEL = "analytics/1";

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

/** The `<script src>` that loads the container, e.g. `loaderPath(location.host)`. */
export function loaderPath(host: string): string {
	return `/${pathHash(host)}.js`;
}

/** `/<hash>/`: prefix of an encoded browser request. */
export function encodedPrefix(host: string): string {
	return `/${pathHash(host)}/`;
}

/**
 * Which upstream a decoded token belongs to, and the path to forward. `/_sgtm/g/collect?v=2`
 * becomes `sgtm` and `/g/collect?v=2`; a path under no prefix, the bare prefix, or one whose
 * remainder starts with `//` (a protocol-relative URL that would leave the upstream) is `null`.
 */
export function matchPrefix(
	target: string,
): { readonly name: UpstreamName; readonly path: string } | null {
	for (const name of Object.keys(PREFIX) as UpstreamName[]) {
		const prefix = PREFIX[name];
		if (!target.startsWith(`${prefix}/`) || target.startsWith(`${prefix}//`)) continue;
		return { name, path: target.slice(prefix.length) };
	}
	return null;
}
