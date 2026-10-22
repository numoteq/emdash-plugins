import { Context, Duration, Effect, Layer, Logger, ManagedRuntime, Result, Schema } from "effect";

import { decodePart, Upstream } from "../schema.js";
import { callUpstream, toTarget, type UpstreamInput, type UpstreamTarget } from "../upstream.js";
import { RequestContext, type Consent } from "./context.js";

/** The path of the Measurement Protocol client in the server container. */
const DEFAULT_PATH = "/mp/collect";
const DEFAULT_TIMEOUT = Duration.seconds(5);

/** One server-originated event. Enrichment from the request is added by the sender. */
export interface ServerEvent {
	readonly name: string;
	readonly params?: Readonly<Record<string, unknown>> | undefined;
	/**
	 * Plain values, hashed here before they leave the Worker: the helper never sends an e-mail or
	 * a phone number as it got it.
	 */
	readonly user?: { readonly email?: string; readonly phone?: string } | undefined;
	/** Defaults to the page the visitor came from (`Referer`). */
	readonly pageLocation?: string | undefined;
}

export interface ServerEventsOptions {
	/** Server-side GTM, the same binding the proxy uses. */
	readonly upstream?: UpstreamInput | undefined;
	/** Path of the Measurement Protocol client. Default `/mp/collect`. */
	readonly path?: string | undefined;
	/** GA4 measurement id (`G-…`); the container only passes it on to Google. */
	readonly measurementId?: string | undefined;
	/** API secret for that forward. The self-hosted container accepts any value itself. */
	readonly apiSecret?: string | undefined;
	readonly timeout?: Duration.Duration | undefined;
}

/** Resolved options, what the sender needs. */
export interface ServerEventsSettings {
	readonly target: UpstreamTarget;
	readonly path: string;
	readonly measurementId?: string | undefined;
	readonly apiSecret?: string | undefined;
	readonly timeout: Duration.Duration;
}

/** sGTM answered, but the container refused the hit (4xx/5xx): nothing downstream saw it. */
export class ServerEventRejected extends Schema.TaggedError<ServerEventRejected>()(
	"ServerEventRejected",
	{ status: Schema.Number, detail: Schema.String },
) {}

/** sGTM could not be reached or did not answer in time. */
export class ServerEventUnavailable extends Schema.TaggedError<ServerEventUnavailable>()(
	"ServerEventUnavailable",
	{ reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * Server tags read consent from `x-ga-gcs` (the `G1` + ad + analytics triple), never from the MP
 * body's `consent` object, so the sender passes it as the `gcs` query parameter. Missing consent
 * counts as denied.
 */
export function gcsOf(consent: Consent): string {
	return `G1${consent.marketing === true ? "1" : "0"}${consent.measurement === true ? "1" : "0"}`;
}

async function hash(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** E-mail lowercased, phone reduced to digits, both SHA-256 in lowercase hex, as all vendors want. */
async function userDataOf(user: ServerEvent["user"]): Promise<Record<string, string> | undefined> {
	if (user === undefined) return undefined;
	const data: Record<string, string> = {};
	const email = user.email?.trim().toLowerCase();
	if (email) data["sha256_email_address"] = await hash(email);
	const phone = user.phone?.replace(/\D/g, "");
	if (phone) data["sha256_phone_number"] = await hash(phone);
	return Object.keys(data).length === 0 ? undefined : data;
}

async function payloadOf(
	context: RequestContext,
	event: ServerEvent,
): Promise<Record<string, unknown>> {
	const params: Record<string, unknown> = { ...event.params };
	const pageLocation = event.pageLocation ?? context.pageLocation;
	if (pageLocation !== undefined) params["page_location"] = pageLocation;
	if (context.sessionId !== undefined) params["session_id"] = context.sessionId;
	if (context.fbp !== undefined) params["_fbp"] = context.fbp;
	if (context.fbc !== undefined) params["_fbc"] = context.fbc;

	const userData = await userDataOf(event.user);
	const marketing = context.consent.marketing === true;
	return {
		client_id: context.clientId ?? crypto.randomUUID(),
		timestamp_micros: Date.now() * 1000,
		events: [{ name: event.name, params }],
		consent: {
			ad_user_data: marketing ? "GRANTED" : "DENIED",
			ad_personalization: marketing ? "GRANTED" : "DENIED",
		},
		...(userData === undefined ? {} : { user_data: userData }),
		...(context.ip === undefined ? {} : { ip_override: context.ip }),
		...(context.userAgent === undefined ? {} : { user_agent: context.userAgent }),
	};
}

function queryOf(settings: ServerEventsSettings, context: RequestContext): string {
	const query = new URLSearchParams();
	if (settings.measurementId) query.set("measurement_id", settings.measurementId);
	if (settings.apiSecret) query.set("api_secret", settings.apiSecret);
	query.set("gcs", gcsOf(context.consent));
	return query.toString();
}

const timeout = (duration: Duration.Duration) =>
	Effect.timeoutOrElse({
		duration,
		orElse: () => Effect.fail(new ServerEventUnavailable({ reason: "timeout" })),
	});

/** Builds and sends one hit. Sent once: no vendor downstream deduplicates a repeated event. */
function requestOf(
	settings: ServerEventsSettings,
	context: RequestContext,
	event: ServerEvent,
): Effect.Effect<void, ServerEventRejected | ServerEventUnavailable> {
	return Effect.gen(function* () {
		const body = yield* Effect.promise(() => payloadOf(context, event));
		const path = `${settings.path}?${queryOf(settings, context)}`;
		const response = yield* Effect.tryPromise({
			try: (signal) =>
				callUpstream(settings.target, path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal,
				}),
			catch: (cause) => new ServerEventUnavailable({ reason: "sgtm fetch failed", cause }),
		}).pipe(timeout(settings.timeout));

		if (response.ok) return;
		const detail = yield* Effect.promise(() => response.text().catch(() => ""));
		return yield* new ServerEventRejected({
			status: response.status,
			detail: detail.slice(0, 200),
		});
	});
}

/** Sends server-originated events to the Measurement Protocol client of our sGTM. */
export class ServerEvents extends Context.Service<
	ServerEvents,
	{
		readonly send: (
			context: RequestContext,
			event: ServerEvent,
		) => Effect.Effect<void, ServerEventRejected | ServerEventUnavailable>;
	}
>()("@numoteq/analytics/ServerEvents") {
	static layer(settings: ServerEventsSettings): Layer.Layer<ServerEvents> {
		return Layer.succeed(ServerEvents, {
			send: (context, event) => requestOf(settings, context, event),
		});
	}
}

/** `send` for code that already has its services. */
export const send = (context: RequestContext, event: ServerEvent) =>
	Effect.flatMap(ServerEvents, (events) => events.send(context, event));

/** Validates the options; the failure is a readable description of what is missing or wrong. */
export function resolveServerEventsOptions(
	options: ServerEventsOptions = {},
): Result.Result<ServerEventsSettings, string> {
	const warnings: string[] = [];
	const upstream = decodePart(Upstream, options.upstream, "upstream", "no event is sent", warnings);
	if (upstream === undefined) return Result.fail(warnings.join("; "));
	return Result.succeed({
		target: toTarget(upstream),
		path: options.path ?? DEFAULT_PATH,
		measurementId: options.measurementId,
		apiSecret: options.apiSecret,
		timeout: options.timeout ?? DEFAULT_TIMEOUT,
	});
}

/** The promise face of {@link send}: reads the request, sends in the background, never throws. */
export interface ServerEventsClient {
	send(request: Request, event: ServerEvent, consent?: Consent): Promise<void>;
}

const logger = Logger.layer([Logger.consoleJson]);

/**
 * Creates the sender for code outside Effect, such as an Astro action or an API route. Without
 * an upstream it logs why once and drops events; a failed event is logged, never thrown, so a
 * page render or a form submit does not depend on analytics.
 */
export function createServerEvents(options: ServerEventsOptions = {}): ServerEventsClient {
	const resolved = resolveServerEventsOptions(options);
	if (Result.isFailure(resolved)) {
		Effect.runSync(
			Effect.logWarning(`analytics server events disabled: ${resolved.failure}`).pipe(
				Effect.provide(logger),
			),
		);
		return { send: () => Promise.resolve() };
	}

	const runtime = ManagedRuntime.make(Layer.mergeAll(ServerEvents.layer(resolved.success), logger));
	return {
		send: (request, event, consent) =>
			runtime.runPromise(
				send(RequestContext.fromRequest(request, consent), event).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning(`analytics server event dropped: ${String(cause)}`),
					),
				),
			),
	};
}
