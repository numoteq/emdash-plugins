import { describe, expect, it, vi } from "@effect/vitest";

import { createSgtmHandler, sgtmLoaderPath, type SgtmOptions } from "../src/index.js";

const origin = "https://site.example";
const loader = `${origin}${sgtmLoaderPath("site.example")}`;
const options: SgtmOptions = {
	gtmId: "GTM-NTQ37T97",
	upstream: {
		fetch: async () => new Response("var a=1;", { headers: { "content-type": "text/javascript" } }),
	},
};

describe("createSgtmHandler", () => {
	it("answers the loader and leaves other requests to the site", async () => {
		const handler = createSgtmHandler(options);

		const response = await handler(new Request(loader));

		expect(await response!.text()).toContain("var a=1;");
		expect(await handler(new Request(`${origin}/blog`))).toBeNull();
	});

	it("turns itself off and logs why once when options are incomplete", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const handler = createSgtmHandler({ upstream: options.upstream });

		const response = await handler(new Request(loader));
		await handler(new Request(loader));

		expect(await response!.text()).toBe("");
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ level: "WARN" });
		expect(String(log.mock.calls[0]![0])).toContain("gtmId");
		log.mockRestore();
	});
});
