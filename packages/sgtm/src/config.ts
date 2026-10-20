import { Result, Schema } from "effect";

import { derivePaths, type DerivedPaths } from "./codec.js";

/** Anything with a Workers `fetch`: a Workers VPC binding or a service binding. */
export interface SgtmUpstream {
	fetch(request: Request): Promise<Response>;
}

/**
 * What a site passes in, usually straight from its Worker env. Missing values are allowed and
 * turn the proxy off with a message saying why, so preview deploys without sGTM stay quiet.
 */
export interface SgtmOptions {
	/** Web GTM container id, e.g. `GTM-NTQ37T97`. Only the Worker sees it; paths are hashed from it. */
	readonly gtmId?: string | undefined;
	/** sGTM: a Workers VPC or service binding, or a base URL such as `https://sgtm.example.com`. */
	readonly upstream?: SgtmUpstream | string | undefined;
	/** Path prefix routed to sGTM, default `/k7`. Must equal the server container URL path. */
	readonly prefix?: string | undefined;
	/** Changes every derived path. Set it only to move away from a path a filter list picked up. */
	readonly pathSalt?: string | undefined;
}

export interface SgtmConfig {
	readonly gtmId: string;
	readonly upstream: SgtmUpstream | URL;
	readonly paths: DerivedPaths;
}

const Binding = Schema.declare(
	(input: unknown): input is SgtmUpstream =>
		typeof input === "object" &&
		input !== null &&
		typeof (input as { fetch?: unknown }).fetch === "function",
	{ expected: "a Workers binding with fetch()" },
);

const BaseUrl = Schema.String.check(
	Schema.makeFilter((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), {
		expected: "an http(s) base URL",
	}),
);

const Options = Schema.Struct({
	gtmId: Schema.String.check(Schema.isPattern(/^GTM-[A-Z0-9]+$/, { expected: "a GTM-… id" })),
	upstream: Schema.Union([Binding, BaseUrl]),
	prefix: Schema.optional(
		Schema.String.check(Schema.isPattern(/^(\/[A-Za-z0-9_-]+)+$/, { expected: "a path like /k7" })),
	),
	pathSalt: Schema.optional(Schema.String),
});

const decodeOptions = Schema.decodeUnknownResult(Options, { errors: "all" });

/** Validates the options; the failure is a readable description of what is missing or wrong. */
export function resolveConfig(options: SgtmOptions): Result.Result<SgtmConfig, string> {
	return decodeOptions(options).pipe(
		Result.map((valid) => ({
			gtmId: valid.gtmId,
			upstream: typeof valid.upstream === "string" ? new URL(valid.upstream) : valid.upstream,
			paths: derivePaths(valid.gtmId, valid.prefix ?? "/k7", valid.pathSalt ?? ""),
		})),
		Result.mapError((error) => error.message),
	);
}
