/** Anything with a Workers `fetch`: a Workers VPC binding or a service binding. */
export interface UpstreamBinding {
	fetch(request: Request): Promise<Response>;
}

/** A binding, or a base URL such as `https://sgtm.example.com`. */
export type UpstreamInput = UpstreamBinding | string;

/** What one request needs: the binding itself, or the parsed base URL. */
export type UpstreamTarget = UpstreamBinding | URL;

/** A VPC binding routes by its own configuration, so the host of the URL is a placeholder. */
const PLACEHOLDER = "http://analytics.internal";

export function toTarget(upstream: UpstreamInput): UpstreamTarget {
	return typeof upstream === "string" ? new URL(upstream) : upstream;
}

/** One request to an upstream. A base URL replaces its own path with `path`, as a proxy would. */
export function callUpstream(
	target: UpstreamTarget,
	path: string,
	init: RequestInit,
): Promise<Response> {
	if (!path.startsWith("/") || path.startsWith("//")) {
		throw new Error(`refusing a non-canonical upstream path: ${path}`);
	}
	return target instanceof URL
		? fetch(new URL(path, target), init)
		: target.fetch(new Request(`${PLACEHOLDER}${path}`, init));
}
