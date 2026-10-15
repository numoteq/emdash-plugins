import { describe, expect, it, vi } from "vitest";

import { sgtmLoaderPath, sgtmMiddleware, type SgtmAstroContext } from "../src/index.js";

const secret = "s3cret-per-site";
const prefix = "/k7";
const gtmId = "GTM-NTQ37T97";

function upstream() {
	const calls: Request[] = [];
	return {
		calls,
		binding: {
			async fetch(request: Request): Promise<Response> {
				calls.push(request);
				return new Response("sgtm", { status: 202 });
			},
		},
	};
}

describe("sgtmMiddleware", () => {
	it("passes requests outside the prefix to the next middleware", async () => {
		const { binding, calls } = upstream();
		const page = new Response("page");
		const next = vi.fn<() => Promise<Response>>(async () => page);
		const middleware = sgtmMiddleware({ upstream: binding, gtmId, secret, prefix });
		const context: SgtmAstroContext = { request: new Request("https://site.example/blog") };

		expect(await middleware(context, next)).toBe(page);
		expect(next).toHaveBeenCalledOnce();
		expect(calls).toHaveLength(0);
	});

	it("serves prefix requests itself and reads the client IP from cf-connecting-ip", async () => {
		const { binding, calls } = upstream();
		const next = vi.fn<() => Promise<Response>>(async () => new Response("page"));
		const middleware = sgtmMiddleware({ upstream: binding, gtmId, secret, prefix });
		const context: SgtmAstroContext = {
			request: new Request("https://site.example/k7/plain", {
				headers: { "cf-connecting-ip": "198.51.100.7" },
			}),
		};

		const response = await middleware(context, next);

		expect(response.status).toBe(202);
		expect(next).not.toHaveBeenCalled();
		expect(calls[0]!.headers.get("x-forwarded-for")).toBe("198.51.100.7");
		expect(calls[0]!.headers.get("x-forwarded-host")).toBe("site.example");
	});

	it("resolves its options from the Worker env", async () => {
		const { binding, calls } = upstream();
		const next = vi.fn<() => Promise<Response>>(async () => new Response("page"));
		const middleware = sgtmMiddleware((env) => ({
			upstream: binding,
			gtmId,
			secret: (env as { SGTM_SECRET: string }).SGTM_SECRET,
			prefix,
		}));
		const context: SgtmAstroContext = {
			request: new Request("https://site.example/k7/plain"),
			locals: { runtime: { env: { SGTM_SECRET: secret } } },
		};

		expect((await middleware(context, next)).status).toBe(202);
		expect(calls).toHaveLength(1);
	});

	it("serves the loader with the shim through the middleware", async () => {
		const container = 'var data={"21":"www.googletagmanager.com"};';
		const binding = {
			async fetch(): Promise<Response> {
				return new Response(container, { headers: { "content-type": "application/javascript" } });
			},
		};
		const next = vi.fn<() => Promise<Response>>(async () => new Response("page"));
		const middleware = sgtmMiddleware({ upstream: binding, gtmId, secret, prefix });
		const loaderPath = await sgtmLoaderPath({ secret, prefix });
		const context: SgtmAstroContext = {
			request: new Request(`https://site.example${loaderPath}`),
		};

		const response = await middleware(context, next);

		expect(response.status).toBe(200);
		expect(next).not.toHaveBeenCalled();
		const body = await response.text();
		expect(body.startsWith("(function (window) {")).toBe(true);
		expect(body).toContain('"21":"site.example/k7"');
	});
});
