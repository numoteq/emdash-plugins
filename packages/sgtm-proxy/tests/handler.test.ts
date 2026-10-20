import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Result } from "effect";
import { TestClock } from "effect/testing";

import { encodeToken } from "../src/codec.js";
import { resolveConfig, type SgtmConfig } from "../src/config.js";
import { handle, LoaderCache, Upstream, UpstreamUnavailable } from "../src/handler.js";

const origin = "https://site.example";
const config: SgtmConfig = Result.getOrThrow(
	resolveConfig({ gtmId: "GTM-NTQ37T97", upstream: "https://sgtm.example" }),
);
const { paths } = config;

const CONTAINER =
	'var h="https://www.googletagmanager.com/gtag/js";var b={"21":"www.googletagmanager.com"};';

interface Call {
	readonly path: string;
	readonly init: RequestInit;
}

/** A fake sGTM: records calls and answers with `respond`, or fails when it returns an error. */
function upstream(respond: (call: Call) => Response | UpstreamUnavailable | "hang") {
	const calls: Call[] = [];
	const layer = Layer.succeed(Upstream, {
		fetch: (path, init) =>
			Effect.suspend(() => {
				const call = { path, init };
				calls.push(call);
				const result = respond(call);
				if (result === "hang") return Effect.never;
				return result instanceof UpstreamUnavailable ? Effect.fail(result) : Effect.succeed(result);
			}),
	});
	return { calls, layer };
}

function memoryCache() {
	const entries = new Map<string, Response>();
	const layer = Layer.succeed(LoaderCache, {
		get: (key) => Effect.sync(() => Option.fromNullishOr(entries.get(key)?.clone())),
		put: (key, response) => Effect.sync(() => void entries.set(key, response)),
	});
	return { entries, layer };
}

const script = (body = CONTAINER, headers: Record<string, string> = {}) =>
	new Response(body, { headers: { "content-type": "application/javascript", ...headers } });

const run = (
	request: Request,
	fake: ReturnType<typeof upstream>,
	cache = memoryCache(),
): Effect.Effect<Option.Option<Response>> =>
	handle(config, request, "203.0.113.9").pipe(Effect.provide(Layer.merge(fake.layer, cache.layer)));

const encoded = (plain: string) =>
	`${origin}${paths.encodedPrefix}/${encodeToken(plain, crypto.getRandomValues(new Uint8Array(4)), paths.seed)}`;

const status = (response: Option.Option<Response>) => Option.getOrThrow(response).status;

describe("handle", () => {
	it.effect("ignores requests outside the prefix", () =>
		Effect.gen(function* () {
			const fake = upstream(() => script());
			for (const path of ["/", "/blog", "/k", "/k7extra/x"]) {
				expect(yield* run(new Request(`${origin}${path}`), fake)).toEqual(Option.none());
			}
			expect(fake.calls).toHaveLength(0);
		}),
	);

	it.effect("refuses plain requests under the prefix without calling sGTM", () =>
		Effect.gen(function* () {
			const fake = upstream(() => script());
			for (const path of ["/k7", "/k7/g/collect?v=2", "/k7/_/service_worker/6a60/sw_iframe.html"]) {
				expect(status(yield* run(new Request(`${origin}${path}`), fake))).toBe(404);
			}
			expect(fake.calls).toHaveLength(0);
		}),
	);

	describe("loader", () => {
		it.effect("serves gtm.js with the shim in front and the hosts rewritten", () =>
			Effect.gen(function* () {
				const fake = upstream(() => script());

				const response = Option.getOrThrow(
					yield* run(new Request(`${origin}${paths.loaderPath}?x=1`), fake),
				);
				const body = yield* Effect.promise(() => response.text());

				expect(fake.calls.map((call) => call.path)).toEqual(["/k7/gtm.js?id=GTM-NTQ37T97"]);
				expect(new Headers(fake.calls[0]!.init.headers).get("x-forwarded-for")).toBe("203.0.113.9");
				expect(body.startsWith("(function (window) {")).toBe(true);
				expect(body).toContain('var h="https://site.example/k7/gtag/js"');
				expect(body).toContain('"21":"site.example/k7"');
				expect(body).not.toContain("googletagmanager.com");
				expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
			}),
		);

		it.effect("is cached, except for server-side previews", () =>
			Effect.gen(function* () {
				const fake = upstream(() => script());
				const cache = memoryCache();
				const loader = `${origin}${paths.loaderPath}`;

				yield* run(new Request(loader), fake, cache);
				const cached = yield* run(new Request(loader), fake, cache);
				yield* run(
					new Request(loader, { headers: { "x-gtm-server-preview": "abc" } }),
					fake,
					cache,
				);

				expect(status(cached)).toBe(200);
				expect([...cache.entries.keys()]).toEqual([loader]);
				expect(fake.calls).toHaveLength(2);
			}),
		);

		it.effect("is not cached when sGTM sets cookies", () =>
			Effect.gen(function* () {
				const cache = memoryCache();
				yield* run(
					new Request(`${origin}${paths.loaderPath}`),
					upstream(() => script(CONTAINER, { "set-cookie": "FPID=1" })),
					cache,
				);
				expect(cache.entries.size).toBe(0);
			}),
		);

		it.effect("retries twice, then answers 502", () =>
			Effect.gen(function* () {
				const fake = upstream(() => new Response("down", { status: 503 }));
				const fiber = yield* Effect.forkChild(
					run(new Request(`${origin}${paths.loaderPath}`), fake),
				);
				yield* TestClock.adjust("1 second");
				expect(status(yield* Fiber.join(fiber))).toBe(502);
				expect(fake.calls).toHaveLength(3);
			}),
		);

		it.effect("recovers when a retry succeeds", () =>
			Effect.gen(function* () {
				const fake = upstream(() =>
					fake.calls.length === 1 ? new UpstreamUnavailable({ reason: "reset" }) : script(),
				);
				const fiber = yield* Effect.forkChild(
					run(new Request(`${origin}${paths.loaderPath}`), fake),
				);
				yield* TestClock.adjust("1 second");
				expect(status(yield* Fiber.join(fiber))).toBe(200);
			}),
		);

		it.effect("passes a 4xx through uncached", () =>
			Effect.gen(function* () {
				const cache = memoryCache();
				const fake = upstream(() => new Response("no client", { status: 400 }));
				expect(status(yield* run(new Request(`${origin}${paths.loaderPath}`), fake, cache))).toBe(
					400,
				);
				expect(fake.calls).toHaveLength(1);
				expect(cache.entries.size).toBe(0);
			}),
		);
	});

	describe("encoded requests", () => {
		it.effect("forwards the decoded hit once, with method, body and filtered headers", () =>
			Effect.gen(function* () {
				const fake = upstream(() => new Response(null, { status: 204 }));
				const request = new Request(encoded("/k7/g/collect?v=2&en=page_view"), {
					method: "POST",
					body: "en=scroll",
					headers: { cookie: "_ga=1; session=secret" },
				});

				expect(status(yield* run(request, fake))).toBe(204);

				const [call] = fake.calls;
				expect(call!.path).toBe("/k7/g/collect?v=2&en=page_view");
				expect(call!.init.method).toBe("POST");
				expect(new Headers(call!.init.headers).get("cookie")).toBe("_ga=1");
				expect(yield* Effect.promise(() => new Response(call!.init.body).text())).toBe("en=scroll");
			}),
		);

		it.effect("rewrites hosts in scripts the container loads", () =>
			Effect.gen(function* () {
				const fake = upstream(() => script());
				const response = Option.getOrThrow(
					yield* run(new Request(encoded("/k7/gtag/js?id=G-X")), fake),
				);
				const body = yield* Effect.promise(() => response.text());
				expect(body).toBe(
					CONTAINER.replaceAll("https://www.googletagmanager.com", `${origin}/k7`).replaceAll(
						"www.googletagmanager.com",
						"site.example/k7",
					),
				);
			}),
		);

		it.effect("answers 400 to a token this site did not issue", () =>
			Effect.gen(function* () {
				const fake = upstream(() => script());
				const response = yield* run(new Request(`${origin}${paths.encodedPrefix}/garbage`), fake);
				expect(status(response)).toBe(400);
				expect(fake.calls).toHaveLength(0);
			}),
		);

		it.effect("answers 502 without retrying when sGTM hangs", () =>
			Effect.gen(function* () {
				const fake = upstream(() => "hang");
				const fiber = yield* Effect.forkChild(run(new Request(encoded("/k7/g/collect?v=2")), fake));
				yield* TestClock.adjust("5 seconds");
				expect(status(yield* Fiber.join(fiber))).toBe(502);
				expect(fake.calls).toHaveLength(1);
			}),
		);
	});
});
