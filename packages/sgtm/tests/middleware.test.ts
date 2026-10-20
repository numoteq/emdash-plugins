import { describe, expect, it, vi } from "@effect/vitest";

import { sgtmLoaderPath, sgtmMiddleware, type SgtmOptions } from "../src/index.js";

const origin = "https://site.example";
const options: SgtmOptions = {
	gtmId: "GTM-NTQ37T97",
	upstream: {
		fetch: async () => new Response("var a=1;", { headers: { "content-type": "text/javascript" } }),
	},
};

const next = () => Promise.resolve(new Response("site"));

describe("sgtmLoaderPath", () => {
	it("returns the loader path only for complete options", () => {
		expect(sgtmLoaderPath(options)).toMatch(/^\/k7\/[0-9a-z]+\.js$/);
		expect(sgtmLoaderPath({ ...options, prefix: "/p" })).toMatch(/^\/p\//);
		expect(sgtmLoaderPath({ ...options, gtmId: undefined })).toBeUndefined();
		expect(sgtmLoaderPath({ ...options, upstream: undefined })).toBeUndefined();
		expect(sgtmLoaderPath({ ...options, upstream: "not a url" })).toBeUndefined();
	});
});

describe("sgtmMiddleware", () => {
	it("answers the loader and passes everything else on", async () => {
		const middleware = sgtmMiddleware(options);
		const loader = await middleware(
			{ request: new Request(`${origin}${sgtmLoaderPath(options)}`) },
			next,
		);
		const page = await middleware({ request: new Request(`${origin}/blog`) }, next);

		expect(await loader.text()).toContain("var a=1;");
		expect(await page.text()).toBe("site");
	});

	it("resolves lazy options once, on the first request", async () => {
		const resolve = vi.fn<() => SgtmOptions>(() => options);
		const middleware = sgtmMiddleware(resolve);
		expect(resolve).not.toHaveBeenCalled();

		await middleware({ request: new Request(`${origin}/`) }, next);
		await middleware({ request: new Request(`${origin}/`) }, next);

		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it("turns itself off and logs why when options are incomplete", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const middleware = sgtmMiddleware({ upstream: options.upstream });

		const response = await middleware({ request: new Request(`${origin}/k7/anything`) }, next);

		expect(await response.text()).toBe("site");
		expect(log.mock.calls.flat().join(" ")).toContain("gtmId");
		log.mockRestore();
	});
});
