import { describe, expect, it, vi } from "vitest";

import { derivePaths, encodeToken } from "../src/codec.js";
import { createSgtmHandler, sgtmLoaderPath } from "../src/index.js";

const secret = "s3cret-per-site";
const prefix = "/k7";
const gtmId = "GTM-NTQ37T97";
const origin = "https://site.example";
const salt = Uint8Array.from([9, 8, 7, 6]);
const paths = await derivePaths({ secret, prefix });

const CONTAINER_SNIPPET = [
	'var data={"blob":{"10":"GTM-NTQ37T97","21":"www.googletagmanager.com"}};',
	'a="https://www.googletagmanager.com/static/service_worker/";',
	'gn=function(a){if(a.origin!=="https://www.googletagmanager.com"){}};',
].join("\n");

function encodePath(plain: string): string {
	return `${paths.encodedPrefix}/${encodeToken(plain, salt, paths.seed)}`;
}

interface UpstreamHarness {
	calls: Request[];
	upstream: { fetch(request: Request): Promise<Response> };
}

function upstream(respond: (request: Request) => Response | Promise<Response>): UpstreamHarness {
	const calls: Request[] = [];
	return {
		calls,
		upstream: {
			async fetch(request: Request): Promise<Response> {
				calls.push(request);
				return respond(request);
			},
		},
	};
}

function handlerWith(response: Response | ((request: Request) => Response | Promise<Response>)) {
	const respond = typeof response === "function" ? response : () => response;
	const harness = upstream(respond);
	const handler = createSgtmHandler({ upstream: harness.upstream, gtmId, secret, prefix });
	return { handler, calls: harness.calls };
}

function loaderRequest(): Request {
	return new Request(`${origin}${paths.loaderPath}`);
}

describe("createSgtmHandler", () => {
	it("returns null outside the prefix", async () => {
		const { handler, calls } = handlerWith(new Response("ok"));
		const urls = [`${origin}/`, `${origin}/blog/post`, `${origin}/k`, `${origin}/k7extra/x`];

		const responses = await Promise.all(urls.map(async (url) => handler(new Request(url))));

		expect(responses.map((response) => response)).toEqual([null, null, null, null]);
		expect(calls).toHaveLength(0);
	});

	it("forwards a plain request under the prefix", async () => {
		const { handler, calls } = handlerWith(() => new Response("ok", { status: 201 }));
		const request = new Request(`${origin}/k7/_/service_worker/sw.js?a=1`, {
			headers: {
				cookie: "_ga=1; session=2",
				host: "site.example",
				"user-agent": "test",
				"cf-ray": "8ff",
				"cf-connecting-ip": "203.0.113.7",
			},
		});

		const response = await handler(request, "203.0.113.7");

		expect(response?.status).toBe(201);
		expect(await response?.text()).toBe("ok");
		const forwarded = calls[0]!;
		expect(forwarded.url).toBe("http://sgtm.internal/k7/_/service_worker/sw.js?a=1");
		expect(forwarded.method).toBe("GET");
		expect(forwarded.headers.get("cookie")).toBe("_ga=1");
		expect(forwarded.headers.get("user-agent")).toBe("test");
		expect(forwarded.headers.get("cf-ray")).toBeNull();
		expect(forwarded.headers.get("cf-connecting-ip")).toBeNull();
		expect(forwarded.headers.get("x-forwarded-for")).toBe("203.0.113.7");
		expect(forwarded.headers.get("x-forwarded-host")).toBe("site.example");
		expect(forwarded.headers.get("x-forwarded-proto")).toBe("https");
	});

	it("decodes an encoded request before forwarding", async () => {
		const { handler, calls } = handlerWith(new Response("ok"));
		const target = "/k7/gtag/js?id=G-X&v=2";

		const response = await handler(new Request(`${origin}${encodePath(target)}`));

		expect(response?.status).toBe(200);
		expect(calls[0]!.url).toBe(`http://sgtm.internal${target}`);
	});

	it("forwards a POST body and its content type", async () => {
		const { handler, calls } = handlerWith(new Response("ok"));
		const request = new Request(`${origin}/k7/collect`, {
			method: "POST",
			body: "a=1&b=2",
			headers: { "content-type": "application/x-www-form-urlencoded" },
		});

		await handler(request);

		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
		expect(await calls[0]!.text()).toBe("a=1&b=2");
	});

	it("answers 400 for a tampered token", async () => {
		const { handler, calls } = handlerWith(new Response("ok"));
		const token = encodeToken("/k7/some/long/path?x=1", salt, paths.seed);
		const tampered = `${token.slice(0, 6)}${token.charAt(6) === "A" ? "B" : "A"}${token.slice(7)}`;

		const response = await handler(new Request(`${origin}${paths.encodedPrefix}/${tampered}`));

		expect(response?.status).toBe(400);
		expect(await response?.text()).toBe("Bad request");
		expect(calls).toHaveLength(0);
	});

	it("answers 400 for a token that does not decode under the prefix", async () => {
		const { handler, calls } = handlerWith(new Response("ok"));
		const tokens = ["AAAAAAAAAAAAAAAA", "!!!!", encodeToken("/other/x", salt, paths.seed)];

		const responses = await Promise.all(
			tokens.map(async (token) => handler(new Request(`${origin}${paths.encodedPrefix}/${token}`))),
		);

		expect(responses.map((response) => response?.status)).toEqual([400, 400, 400]);
		expect(calls).toHaveLength(0);
	});

	it("serves the loader from upstream with the container id and the shim", async () => {
		const { handler, calls } = handlerWith(
			() =>
				new Response(CONTAINER_SNIPPET, {
					headers: [
						["content-type", "application/javascript"],
						["cache-control", "public, max-age=300"],
						["set-cookie", "a=1; Path=/"],
						["set-cookie", "b=2; Path=/"],
					],
				}),
		);

		const response = await handler(loaderRequest());

		const forwarded = calls[0]!;
		expect(forwarded.url).toBe(`http://sgtm.internal/k7/gtm.js?id=${gtmId}`);
		expect(forwarded.method).toBe("GET");
		expect(forwarded.headers.get("x-forwarded-proto")).toBe("https");

		expect(response?.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
		expect(response?.headers.get("cache-control")).toBe("public, max-age=300");
		expect(response?.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);

		const body = await response!.text();
		expect(body.startsWith("(function (window) {")).toBe(true);
		expect(body).toContain('"21":"site.example/k7"');
		expect(body).toContain('a="https://site.example/k7/static/service_worker/";');
		expect(body).toContain('if(a.origin!=="https://site.example/k7")');
		expect(body).not.toContain("googletagmanager.com");
	});

	it("keeps the container id out of every browser URL", async () => {
		const { handler, calls } = handlerWith(
			() =>
				new Response(CONTAINER_SNIPPET, { headers: { "content-type": "application/javascript" } }),
		);

		const loaderPath = await sgtmLoaderPath({ secret, prefix });
		expect(loaderPath).toBe(paths.loaderPath);
		expect(loaderPath).toMatch(/^\/k7\/[0-9a-z]+\.js$/);
		expect(loaderPath).not.toContain(gtmId);
		expect(paths.encodedPrefix).not.toContain(gtmId);

		await handler(new Request(`${origin}${loaderPath}`));
		expect(calls[0]!.url).toBe(`http://sgtm.internal/k7/gtm.js?id=${gtmId}`);
	});

	it("rewrites hosts in any JavaScript response, without the shim", async () => {
		const { handler } = handlerWith(
			() =>
				new Response('var a="https://www.googletagmanager.com/static/x";', {
					headers: { "content-type": "text/javascript; charset=utf-8" },
				}),
		);

		const body = await (await handler(new Request(`${origin}/k7/gtag.js`)))!.text();

		expect(body).toContain('"https://site.example/k7/static/x"');
		expect(body).not.toContain("googletagmanager.com");
		expect(body.startsWith("(function")).toBe(false);
		expect(body).toBe('var a="https://site.example/k7/static/x";');
	});

	it("passes non-JavaScript and failed responses through untouched", async () => {
		const html = new Response("<p>https://www.googletagmanager.com</p>", {
			headers: { "content-type": "text/html" },
		});
		const missing = new Response("nope", { status: 404 });
		const { handler } = handlerWith(html);

		expect(await handler(new Request(`${origin}/k7/page`))).toBe(html);

		const failing = handlerWith(missing);
		expect(await failing.handler(new Request(`${origin}/k7/page`))).toBe(missing);
	});

	it("uses a base URL string upstream", async () => {
		const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
			async () => new Response("ok"),
		);
		vi.stubGlobal("fetch", fetchSpy);
		try {
			const handler = createSgtmHandler({
				upstream: "https://sgtm.example.com",
				gtmId,
				secret,
				prefix,
			});

			await handler(new Request(`${origin}/k7/x?a=1`));
			await handler(new Request(`${origin}/k7/gtag.js`));

			expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://sgtm.example.com/k7/x?a=1");
			expect(String(fetchSpy.mock.calls[1]![0])).toBe("https://sgtm.example.com/k7/gtag.js");
			expect((fetchSpy.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("accepts a scheme-less base URL string", async () => {
		const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
			async () => new Response("ok"),
		);
		vi.stubGlobal("fetch", fetchSpy);
		try {
			const handler = createSgtmHandler({ upstream: "sgtm.example.com", gtmId, secret, prefix });
			await handler(new Request(`${origin}/k7/x`));
			expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://sgtm.example.com/k7/x");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("rejects a broken configuration at creation time", () => {
		const upstreamBinding = { fetch: async () => new Response("ok") };
		expect(() => createSgtmHandler({ upstream: upstreamBinding, gtmId, secret: "" })).toThrow(
			"secret",
		);
		expect(() =>
			createSgtmHandler({ upstream: upstreamBinding, gtmId, secret, prefix: "k7" }),
		).toThrow("prefix");
		expect(() =>
			createSgtmHandler({ upstream: upstreamBinding, gtmId, secret, prefix: "/" }),
		).toThrow("prefix");
		expect(() => createSgtmHandler({ upstream: "not a url", gtmId, secret })).toThrow(
			/Invalid URL/,
		);
	});

	it("honours a custom prefix and a custom cookie allow list", async () => {
		const harness = upstream(() => new Response("ok"));
		const handler = createSgtmHandler({
			upstream: harness.upstream,
			gtmId,
			secret,
			prefix: "/proxy/",
			cookieAllow: /^session$/,
		});

		expect(await handler(new Request(`${origin}/k7/x`))).toBeNull();

		const response = await handler(
			new Request(`${origin}/proxy/collect`, { headers: { cookie: "_ga=1; session=2" } }),
		);

		expect(response?.status).toBe(200);
		expect(harness.calls[0]!.url).toBe("http://sgtm.internal/proxy/collect");
		expect(harness.calls[0]!.headers.get("cookie")).toBe("session=2");
	});

	it("derives the loader path from the secret", async () => {
		expect(await sgtmLoaderPath({ secret, prefix })).toBe(paths.loaderPath);
		expect(await sgtmLoaderPath({ secret })).toMatch(/^\/k7\/[0-9a-z]+\.js$/);
		expect(await sgtmLoaderPath({ secret: "other", prefix })).not.toBe(paths.loaderPath);
	});
});

describe("loader forwarding", () => {
	it("keeps the filtered cookies and the client headers", async () => {
		const harness = upstream(
			() =>
				new Response(CONTAINER_SNIPPET, { headers: { "content-type": "application/javascript" } }),
		);
		const handler = createSgtmHandler({ upstream: harness.upstream, gtmId, secret, prefix });

		await handler(
			new Request(`${origin}${paths.loaderPath}`, {
				headers: { cookie: "_ga=1; session=2", accept: "*/*" },
			}),
			"198.51.100.7",
		);

		expect(harness.calls[0]!.headers.get("cookie")).toBe("_ga=1");
		expect(harness.calls[0]!.headers.get("accept")).toBe("*/*");
		expect(harness.calls[0]!.headers.get("x-forwarded-for")).toBe("198.51.100.7");
	});
});
