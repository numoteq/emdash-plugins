import { describe, expect, it, vi } from "@effect/vitest";

import { createProxyHandler } from "../src/index.js";
import { encodedPrefix, loaderPath } from "../src/paths.js";

const origin = "https://site.example";
const loader = `${origin}${loaderPath("site.example")}`;

const sgtm = {
	fetch: async () => new Response("var a=1;", { headers: { "content-type": "text/javascript" } }),
};

const openpanel = {
	fetch: async () =>
		new Response("console.log(1)", { headers: { "content-type": "text/javascript" } }),
};

describe("createProxyHandler", () => {
	it("answers the loader and leaves other requests to the site", async () => {
		const handler = createProxyHandler({ gtmId: "GTM-NTQ37T97", sgtm });

		const response = await handler(new Request(loader));

		expect(await response!.text()).toContain("var a=1;");
		expect(await handler(new Request(`${origin}/blog`))).toBeNull();
	});

	it("turns itself off, logs why once and still answers every route safely", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const handler = createProxyHandler({});

		const response = await handler(new Request(loader));
		await handler(new Request(loader));

		expect(await response!.text()).toBe("");
		expect(response!.headers.get("cache-control")).toBe("no-store");
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ level: "WARN" });
		expect(String(log.mock.calls[0]![0])).toContain("gtmId");
		expect((await handler(new Request(`${origin}/_sgtm/g/collect`)))!.status).toBe(404);
		expect(
			(await handler(new Request(`${origin}${encodedPrefix("site.example")}garbage`)))!.status,
		).toBe(400);
		log.mockRestore();
	});

	it("serves the OpenPanel script with OpenPanel configured alone", async () => {
		const handler = createProxyHandler({ openpanel });

		const response = await handler(new Request(`${origin}/_op/op1.js`));

		expect(response!.status).toBe(200);
		expect(await response!.text()).toBe("console.log(1)");
		expect(await handler(new Request(`${origin}/blog`))).toBeNull();
	});
});
