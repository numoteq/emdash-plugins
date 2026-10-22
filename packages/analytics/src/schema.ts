import { Result, Schema } from "effect";

import type { UpstreamBinding } from "./upstream.js";

/** A Workers VPC or service binding, recognised by having a `fetch`. */
export const Binding = Schema.declare(
	(input: unknown): input is UpstreamBinding =>
		typeof input === "object" &&
		input !== null &&
		typeof (input as { fetch?: unknown }).fetch === "function",
	{ expected: "a Workers binding with fetch()" },
);

export const BaseUrl = Schema.String.check(
	Schema.makeFilter((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), {
		expected: "an http(s) base URL",
	}),
);

/** A binding or a base URL, whichever the deployment has. */
export const Upstream = Schema.Union([Binding, BaseUrl]);

/** The web container id (`GTM-…`) whose `gtm.js` is loaded, not the server container. */
export const GtmId = Schema.String.check(
	Schema.isPattern(/^GTM-[A-Z0-9]+$/, { expected: "a GTM-… id" }),
);

/**
 * Validates one optional part and records why it is off. Returns `undefined` for a missing or
 * invalid input, so a broken part turns only itself off.
 */
export function decodePart<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	input: unknown,
	label: string,
	consequence: string,
	warnings: string[],
): S["Type"] | undefined {
	if (input === undefined) {
		warnings.push(`${label} is missing, so ${consequence}`);
		return undefined;
	}
	const result = Schema.decodeUnknownResult(schema)(input);
	if (Result.isFailure(result)) {
		warnings.push(`${label} is invalid, so ${consequence}: ${result.failure.message}`);
		return undefined;
	}
	return result.success;
}
