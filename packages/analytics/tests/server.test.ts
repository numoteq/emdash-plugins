import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "@effect/vitest";
import { Duration, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";

import {
	clientIdOf,
	fromRequest,
	RequestContext,
	sessionCookieName,
	sessionIdOf,
} from "../src/server/context.js";
import type { Consent } from "../src/server/context.js";
import {
	createServerEvents,
	gcsOf,
	resolveServerEventsOptions,
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
					"_ga=GA1.1.123.456; _ga_WSNXXNBYV7=GS1.1.1730000000.3.1.1730000300.0.0.0; " +
					"_fbp=fb.1.1730000000.1; _fbc=fb.1.1730000000.xyz",
				"cf-connecting-ip": "203.0.113.9",
				"user-agent": "Mozilla/5.0",
				referer: "https://site.example/sluzby?utm_source=x",
			}),
			{ measurement: true },
			"G-WSNXXNBYV7",
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

describe("sessionCookieName", () => {
	it("names the cookie after the GA4 id without its prefix", () => {
		expect(sessionCookieName("G-WSNXXNBYV7")).toBe("_ga_WSNXXNBYV7");
	});

	it("leaves an id it does not understand unmatched", () => {
		expect(sessionCookieName("S-ABC")).toBe("_ga_S-ABC");
		expect(sessionCookieName("AW-123")).toBe("_ga_AW-123");
	});
});

const sessionContext = (cookie: string, measurementId?: string) =>
	fromRequest(new Request("https://site.example/api", { headers: { cookie } }), {}, measurementId);

describe("fromRequest session cookie", () => {
	it("takes the cookie of the configured stream, not the first one", () => {
		const value = sessionContext(
			"_ga_OTHER=GS1.1.111.1.0.111.0.0.0; _ga_WSNXXNBYV7=GS1.1.222.1.0.222.0.0.0",
			"G-WSNXXNBYV7",
		);

		expect(value.sessionId).toBe("222");
	});

	it("sends no session id rather than another property's", () => {
		expect(
			sessionContext("_ga_OTHER=GS1.1.111.1.0.111.0.0.0", "G-WSNXXNBYV7").sessionId,
		).toBeUndefined();
		expect(sessionContext("_ga_WSNXXNBYV7=GS1.1.222.1.0.222.0.0.0").sessionId).toBeUndefined();
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

const MEASUREMENT_ID = "G-WSNXXNBYV7";

const CONTEXT = RequestContext.fromRequest(
	new Request("https://site.example/api/contact", {
		method: "POST",
		headers: {
			cookie: `_ga=GA1.1.123.456; ${sessionCookieName(MEASUREMENT_ID)}=GS1.1.1730000000.3.1.1730000300.0.0.0; _fbp=fb.1.1.1`,
			"cf-connecting-ip": "203.0.113.9",
			"user-agent": "Mozilla/5.0",
			referer: "https://site.example/sluzby",
		},
	}),
	{ measurement: true, marketing: true },
	MEASUREMENT_ID,
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
) =>
	Effect.provide(
		ServerEvents.use((events) => events.send(context, event)),
		ServerEvents.layer(settings(fake, overrides)),
	);

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
			expect(body.events[0].params["session_id"]).toBeUndefined();
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

	it.effect("times out with ServerEventUnavailable and does not retry", () =>
		Effect.gen(function* () {
			const fake = upstream(() => "hang");
			const fiber = yield* Effect.forkChild(Effect.flip(run(fake, { name: "generate_lead" })));
			yield* TestClock.adjust("5 seconds");
			const error = yield* Fiber.join(fiber);

			expect(error).toBeInstanceOf(ServerEventUnavailable);
			expect((error as ServerEventUnavailable).reason).toBe("timeout");
			expect(fake.calls).toHaveLength(1);
		}),
	);

	it.effect("sends no identifiers and no hashes without their consent", () =>
		Effect.gen(function* () {
			const fake = upstream(() => new Response(null, { status: 204 }));
			const context = RequestContext.fromRequest(
				new Request("https://site.example/api/contact", {
					headers: {
						cookie: `_ga=GA1.1.123.456; ${sessionCookieName(MEASUREMENT_ID)}=GS1.1.1730000000.3.1.1730000300.0.0.0; _fbp=fb.1.1.1`,
					},
				}),
				{},
				MEASUREMENT_ID,
			);

			yield* run(fake, LEAD, context);

			const body = JSON.parse(fake.calls[0]!.body);
			expect(body.user_data).toBeUndefined();
			expect(body.client_id).toMatch(/^[0-9a-f-]{36}$/);
			expect(body.events[0].params["session_id"]).toBeUndefined();
			expect(body.events[0].params["_fbp"]).toBeUndefined();
			expect(body.events[0].params["_fbc"]).toBeUndefined();
			expect(fake.calls[0]!.path).toContain("gcs=G100");
		}),
	);

	it.effect("keeps the GA identifiers and drops the Meta ones without marketing consent", () =>
		Effect.gen(function* () {
			const fake = upstream(() => new Response(null, { status: 204 }));
			const context = RequestContext.fromRequest(
				new Request("https://site.example/api/contact", {
					headers: {
						cookie: `_ga=GA1.1.123.456; ${sessionCookieName(MEASUREMENT_ID)}=GS1.1.1730000000.3.1.1730000300.0.0.0; _fbp=fb.1.1.1`,
					},
				}),
				{ measurement: true },
				MEASUREMENT_ID,
			);

			yield* run(fake, LEAD, context);

			const body = JSON.parse(fake.calls[0]!.body);
			expect(body.client_id).toBe("123.456");
			expect(body.events[0].params["session_id"]).toBe("1730000000");
			expect(body.events[0].params["_fbp"]).toBeUndefined();
			expect(body.user_data).toBeUndefined();
			expect(fake.calls[0]!.path).toContain("gcs=G101");
		}),
	);

	it.effect("does not let the event params smuggle a gated identifier", () =>
		Effect.gen(function* () {
			const fake = upstream(() => new Response(null, { status: 204 }));
			const context = RequestContext.fromRequest(
				new Request("https://site.example/api/contact"),
				{},
				MEASUREMENT_ID,
			);

			yield* run(
				fake,
				{
					name: "generate_lead",
					params: { form_id: "contact", session_id: "999", _fbp: "fb.1.1.1", _fbc: "fb.1.1.2" },
				},
				context,
			);

			const params = JSON.parse(fake.calls[0]!.body).events[0].params;
			expect(params).toEqual({ form_id: "contact" });
		}),
	);

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
	it("rejects a measurement id that is not a GA4 one, and a path without /", () => {
		const binding = { fetch: async () => new Response(null, { status: 204 }) };

		for (const options of [
			{ upstream: binding, measurementId: "GT-123" },
			{ upstream: binding, path: "mp/collect" },
			{ upstream: binding, path: "//evil.example/x" },
		]) {
			const resolved = resolveServerEventsOptions(options);
			expect(Result.isFailure(resolved)).toBe(true);
		}
	});

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
	it.effect("logs why and drops events without an upstream", () =>
		Effect.gen(function* () {
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			const client = createServerEvents({});

			yield* Effect.promise(() => client.send(new Request("https://site.example/"), LEAD));

			expect(log).toHaveBeenCalledTimes(1);
			expect(String(log.mock.calls[0]![0])).toContain("analytics server events disabled");
			log.mockRestore();
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
