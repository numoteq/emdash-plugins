import { createHash } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Result } from "effect";

import { clientIdOf, fromRequest, RequestContext, sessionIdOf } from "../src/server/context.js";
import type { Consent } from "../src/server/context.js";
import {
	createServerEvents,
	gcsOf,
	resolveServerEventsOptions,
	send,
	ServerEventRejected,
	ServerEvents,
	ServerEventUnavailable,
} from "../src/server/send.js";
import type { ServerEvent, ServerEventsSettings } from "../src/server/send.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("clientIdOf", () => {
	it("takes the last two parts of _ga", () => {
		expect(clientIdOf("GA1.1.123456789.1700000000")).toBe("123456789.1700000000");
		expect(clientIdOf("GA1.2.111.222")).toBe("111.222");
	});

	it("needs a value that has an id in it", () => {
		expect(clientIdOf(undefined)).toBeUndefined();
		expect(clientIdOf("GA1.1")).toBeUndefined();
	});
});

describe("sessionIdOf", () => {
	it("reads the session start from GS1", () => {
		expect(sessionIdOf("GS1.1.1730000000.3.1.1730000300.0.0.0")).toBe("1730000000");
	});

	it("reads the session start from GS2", () => {
		expect(sessionIdOf("GS2.1.s1730000000$o3$g1$t1730000300$j10$l0$h12345678")).toBe("1730000000");
		expect(sessionIdOf("GS2.1.s1730000000%24o3%24g1%24t1730000300")).toBe("1730000000");
	});

	it("gives up on anything else", () => {
		expect(sessionIdOf(undefined)).toBeUndefined();
		expect(sessionIdOf("garbage")).toBeUndefined();
	});
});

const apiRequest = (headers: Record<string, string>) =>
	new Request("https://site.example/api/contact", { method: "POST", headers });

describe("fromRequest", () => {
	it("reads the identifiers, the address and the page off the request", () => {
		const context = fromRequest(
			apiRequest({
				cookie:
					"_ga=GA1.1.123.456; _ga_ABC=GS1.1.1730000000.3.1.1730000300.0.0.0; " +
					"_fbp=fb.1.1730000000.1; _fbc=fb.1.1730000000.xyz",
				"cf-connecting-ip": "203.0.113.9",
				"user-agent": "Mozilla/5.0",
				referer: "https://site.example/sluzby?utm_source=x",
			}),
			{ measurement: true },
		);

		expect(context).toEqual({
			clientId: "123.456",
			sessionId: "1730000000",
			ip: "203.0.113.9",
			userAgent: "Mozilla/5.0",
			pageLocation: "https://site.example/sluzby?utm_source=x",
			fbp: "fb.1.1730000000.1",
			fbc: "fb.1.1730000000.xyz",
			consent: { measurement: true },
		});
	});

	it("builds _fbc from fbclid when the cookie is not there yet", () => {
		const context = fromRequest(apiRequest({ referer: "https://site.example/?fbclid=abc123" }));

		expect(context.fbc?.startsWith("fb.1.")).toBe(true);
		expect(context.fbc?.endsWith(".abc123")).toBe(true);
		expect(context.fbp).toBeUndefined();
	});

	it("falls back to x-forwarded-for and survives a broken referer", () => {
		const context = fromRequest(
			apiRequest({ "x-forwarded-for": "198.51.100.1, 10.0.0.1", referer: "not a url" }),
		);

		expect(context.ip).toBe("198.51.100.1");
		expect(context.pageLocation).toBe("not a url");
		expect(context.clientId).toBeUndefined();
		expect(context.consent).toEqual({});
	});
});

describe("gcsOf", () => {
	it("maps marketing to ad storage and measurement to analytics storage", () => {
		expect(gcsOf({})).toBe("G100");
		expect(gcsOf({ measurement: true })).toBe("G101");
		expect(gcsOf({ marketing: true })).toBe("G110");
		expect(gcsOf({ marketing: true, measurement: true })).toBe("G111");
	});
});

interface Call {
	readonly path: string;
	readonly body: string;
}

/** A fake sGTM: records every call and answers with `respond`, or hangs when it returns "hang". */
function upstream(respond: (call: Call) => Response | "hang") {
	const calls: Call[] = [];
	const binding = {
		fetch: (request: Request): Promise<Response> => {
			const url = new URL(request.url);
			const call = { path: `${url.pathname}${url.search}`, body: "" };
			calls.push(call);
			return new Promise<Response>((resolve) => {
				void request.text().then((body) => {
					call.body = body;
					const result = respond(call);
					if (result !== "hang") resolve(result);
				});
			});
		},
	};
	return { calls, binding };
}

const settings = (
	fake: ReturnType<typeof upstream>,
	overrides: Partial<ServerEventsSettings> = {},
): ServerEventsSettings => ({
	target: fake.binding,
	path: "/mp/collect",
	measurementId: "G-WSNXXNBYV7",
	apiSecret: "secret",
	timeout: Duration.seconds(5),
	...overrides,
});

const CONTEXT = RequestContext.fromRequest(
	new Request("https://site.example/api/contact", {
		method: "POST",
		headers: {
			cookie: "_ga=GA1.1.123.456; _ga_ABC=GS1.1.1730000000.3.1.1730000300.0.0.0; _fbp=fb.1.1.1",
			"cf-connecting-ip": "203.0.113.9",
			"user-agent": "Mozilla/5.0",
			referer: "https://site.example/sluzby",
		},
	}),
	{ measurement: true, marketing: true },
);

const LEAD: ServerEvent = {
	name: "generate_lead",
	params: { form_id: "contact", value: 1000, currency: "CZK" },
	user: { email: " Test@Example.com ", phone: "+420 777 123 456" },
};

const run = (
	fake: ReturnType<typeof upstream>,
	event: ServerEvent,
	context = CONTEXT,
	overrides: Partial<ServerEventsSettings> = {},
) => Effect.provide(send(context, event), ServerEvents.layer(settings(fake, overrides)));

describe("send", () => {
	it.effect("posts a Measurement Protocol hit with enrichment and hashed user data", () =>
		Effect.gen(function* () {
			const fake = upstream(() => new Response(null, { status: 204 }));

			yield* run(fake, LEAD);

			expect(fake.calls).toHaveLength(1);
			const [call] = fake.calls;
			expect(call!.path).toBe("/mp/collect?measurement_id=G-WSNXXNBYV7&api_secret=secret&gcs=G111");

			const body = JSON.parse(call!.body);
			expect(body.client_id).toBe("123.456");
			expect(body.ip_override).toBe("203.0.113.9");
			expect(body.user_agent).toBe("Mozilla/5.0");
			expect(body.consent).toEqual({ ad_user_data: "GRANTED", ad_personalization: "GRANTED" });
			expect(body.events).toEqual([
				{
					name: "generate_lead",
					params: {
						form_id: "contact",
						value: 1000,
						currency: "CZK",
						page_location: "https://site.example/sluzby",
						session_id: "1730000000",
						_fbp: "fb.1.1.1",
					},
				},
			]);
			expect(body.user_data).toEqual({
				sha256_email_address: sha256("test@example.com"),
				sha256_phone_number: sha256("420777123456"),
			});
			expect(call!.body).not.toContain("test@example.com");
			expect(call!.body).not.toContain("777 123 456");
			expect(typeof body.timestamp_micros).toBe("number");
		}),
	);

	it.effect("generates a client id when the visitor has no _ga cookie", () =>
		Effect.gen(function* () {
			const fake = upstream(() => new Response(null, { status: 204 }));
			const context = fromRequest(new Request("https://site.example/api/contact"));

			yield* run(fake, LEAD, context);

			const body = JSON.parse(fake.calls[0]!.body);
			expect(body.client_id).toMatch(/^[0-9a-f-]{36}$/);
			expect(body.events[0].params.page_location).toBeUndefined();
			expect(body.events[0].params.session_id).toBeUndefined();
			expect(body.consent).toEqual({ ad_user_data: "DENIED", ad_personalization: "DENIED" });
			expect(fake.calls[0]!.path).toContain("gcs=G100");
		}),
	);

	it.effect("lets the event override the page location", () =>
		Effect.gen(function* () {
			const fake = upstream(() => new Response(null, { status: 204 }));

			yield* run(fake, { ...LEAD, pageLocation: "https://site.example/diky" });

			const body = JSON.parse(fake.calls[0]!.body);
			expect(body.events[0].params.page_location).toBe("https://site.example/diky");
		}),
	);

	it.effect("fails with the status when sGTM refuses the hit", () =>
		Effect.gen(function* () {
			const fake = upstream(() => new Response("bad client", { status: 400 }));

			const error = yield* Effect.flip(run(fake, LEAD));

			expect(error).toBeInstanceOf(ServerEventRejected);
			expect((error as ServerEventRejected).status).toBe(400);
			expect((error as ServerEventRejected).detail).toBe("bad client");
			expect(fake.calls).toHaveLength(1);
		}),
	);

	it("times out with ServerEventUnavailable and does not retry", async () => {
		const fake = upstream(() => "hang");
		const error = await Effect.runPromise(
			Effect.flip(run(fake, LEAD, CONTEXT, { timeout: Duration.millis(100) })),
		);

		expect(error).toBeInstanceOf(ServerEventUnavailable);
		expect((error as ServerEventUnavailable).reason).toBe("timeout");
		expect(fake.calls).toHaveLength(1);
	});

	it.effect("turns a connection failure into ServerEventUnavailable", () =>
		Effect.gen(function* () {
			const fake = {
				calls: [] as Call[],
				binding: {
					fetch: () => Promise.reject(new Error("connection reset")),
				},
			};

			const error = yield* Effect.flip(run(fake, LEAD));

			expect(error).toBeInstanceOf(ServerEventUnavailable);
			expect((error as ServerEventUnavailable).reason).toBe("sgtm fetch failed");
		}),
	);
});

describe("resolveServerEventsOptions", () => {
	it("uses the default path and needs an upstream", () => {
		expect(Result.isFailure(resolveServerEventsOptions({}))).toBe(true);

		const binding = upstream(() => new Response(null, { status: 204 })).binding;
		const resolved = resolveServerEventsOptions({ upstream: binding });
		if (Result.isFailure(resolved)) throw new Error(resolved.failure);
		expect(resolved.success.path).toBe("/mp/collect");
		expect(resolved.success.timeout).toEqual(Duration.seconds(5));
	});
});

describe("createServerEvents", () => {
	it.effect("never throws and drops events without an upstream", () =>
		Effect.gen(function* () {
			const client = createServerEvents({});
			yield* Effect.promise(() => client.send(new Request("https://site.example/"), LEAD));
		}),
	);

	it.effect("sends with the consent of the call", () =>
		Effect.gen(function* () {
			const fake = upstream(() => new Response(null, { status: 204 }));
			const client = createServerEvents({
				upstream: fake.binding,
				measurementId: "G-WSNXXNBYV7",
			});
			const consent: Consent = { measurement: true };

			yield* Effect.promise(() =>
				client.send(
					new Request("https://site.example/api/contact", {
						headers: { cookie: "_ga=GA1.1.1.2" },
					}),
					{ name: "generate_lead" },
					consent,
				),
			);

			expect(fake.calls).toHaveLength(1);
			expect(fake.calls[0]!.path).toContain("gcs=G101");
			expect(fake.calls[0]!.path).not.toContain("api_secret");
		}),
	);

	it.effect("swallows a rejected event", () =>
		Effect.gen(function* () {
			const fake = upstream(() => new Response("nope", { status: 500 }));
			const client = createServerEvents({ upstream: fake.binding });

			yield* Effect.promise(() => client.send(new Request("https://site.example/"), LEAD));

			expect(fake.calls).toHaveLength(1);
		}),
	);
});
