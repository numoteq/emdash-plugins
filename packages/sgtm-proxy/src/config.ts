import { Context, Layer, Result, Schema } from "effect";

/** Anything with a Workers `fetch`: a Workers VPC binding or a service binding. */
export interface SgtmUpstream {
	fetch(request: Request): Promise<Response>;
}

/**
 * What a site passes in, usually straight from its Worker env. Missing values are allowed and
 * turn the proxy off with a message saying why, so previews and local development stay quiet.
 */
export interface SgtmOptions {
	/** Id of the web container (`GTM-…`) whose `gtm.js` is served, not of the server container. */
	readonly gtmId?: string | undefined;
	/** sGTM: a Workers VPC or service binding, or a base URL such as `https://sgtm.example.com`. */
	readonly upstream?: SgtmUpstream | string | undefined;
}

export interface ResolvedOptions {
	readonly gtmId: string;
	readonly upstream: SgtmUpstream | URL;
}

/** The web container the loader serves. */
export class SgtmConfig extends Context.Service<SgtmConfig, { readonly gtmId: string }>()(
	"@numoteq/sgtm-proxy/SgtmConfig",
) {
	static layer(gtmId: string): Layer.Layer<SgtmConfig> {
		return Layer.succeed(SgtmConfig, { gtmId });
	}
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
});

const decodeOptions = Schema.decodeUnknownResult(Options, { errors: "all" });

/** Validates the options; the failure is a readable description of what is missing or wrong. */
export function resolveOptions(options: SgtmOptions): Result.Result<ResolvedOptions, string> {
	return decodeOptions(options).pipe(
		Result.map((valid) => ({
			gtmId: valid.gtmId,
			upstream: typeof valid.upstream === "string" ? new URL(valid.upstream) : valid.upstream,
		})),
		Result.mapError((error) => error.message),
	);
}
