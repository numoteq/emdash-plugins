import { describe, expect, it, vi } from "@effect/vitest";

import { createAnalytics, createProxyHandler } from "../src/index.js";
import { encodedPrefix, loaderPath } from "../src/paths.js";

const origin = "https://site.example";
const loader = `${origin}${loaderPath("site.example")}`;
const GTM_ID = "GTM-NTQ37T97";

const script = () => new Response("var a=1;", { headers: { "content-type": "text/javascript" } });

const sgtm = {
	fetch: async (request: Request): Promise<Response> =>
		new URL(request.url).pathname === "/gtm.js" ? script() : new Response(null, { status: 204 }),
};

const openpanel = {
	fetch: async () =>
		new Response("console.log(1)", { headers: { "content-type": "text/javascript" } }),
};

describe("createProxyHandler", () => {
	it("answers the loader and leaves other requests to the site", async () => {
		const handler = createProxyHandler({ gtmId: GTM_ID, sgtm });

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

	it("answers an aborted request with an empty response and no upstream call", async () => {
		const calls: string[] = [];
		const handler = createProxyHandler({
			gtmId: GTM_ID,
			sgtm: {
				fetch: async (request) => {
					calls.push(new URL(request.url).pathname);
					return script();
				},
			},
		});
		const controller = new AbortController();
		controller.abort();

		const aborted = await handler(new Request(loader, { signal: controller.signal }));
		const alive = await handler(new Request(loader));

		expect(aborted!.status).toBe(204);
		expect(alive!.status).toBe(200);
		expect(calls).toEqual(["/gtm.js"]);
	});
});

describe("createAnalytics", () => {
	it("serves the proxy and sends server events from the same client", async () => {
		const calls: string[] = [];
		const client = createAnalytics({
			gtmId: GTM_ID,
			sgtm: {
				fetch: async (request) => {
					calls.push(new URL(request.url).pathname);
					return new URL(request.url).pathname === "/gtm.js"
						? script()
						: new Response(null, { status: 204 });
				},
			},
			openpanel,
			serverEvents: { measurementId: "G-WSNXXNBYV7" },
		});

		expect(await client.handle(new Request(`${origin}/blog`))).toBeNull();
		await client.send(
			new Request(`${origin}/api/lead`),
			{ name: "generate_lead" },
			{ measurement: true },
		);

		expect(calls).toEqual(["/mp/collect"]);
	});

	it("reads the session id of its own measurement id", async () => {
		let body = "";
		const client = createAnalytics({
			gtmId: GTM_ID,
			sgtm: {
				fetch: async (request) => {
					if (new URL(request.url).pathname === "/gtm.js") return script();
					body = await request.text();
					return new Response(null, { status: 204 });
				},
			},
			openpanel,
			serverEvents: { measurementId: "G-WSNXXNBYV7" },
		});

		await client.send(
			new Request(`${origin}/api/lead`, {
				headers: {
					cookie:
						"_ga_OTHER=GS1.1.111.1.0.111.0.0.0; " +
						"_ga_WSNXXNBYV7=GS1.1.1730000000.3.1.1730000300.0.0.0",
				},
			}),
			{ name: "generate_lead" },
			{ measurement: true },
		);

		expect(JSON.parse(body).events[0].params.session_id).toBe("1730000000");
	});

	it("turns a broken server events setting into a logged no-op", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const calls: string[] = [];
		const client = createAnalytics({
			gtmId: GTM_ID,
			sgtm: {
				fetch: async (request) => {
					calls.push(new URL(request.url).pathname);
					return script();
				},
			},
			openpanel,
			serverEvents: { measurementId: "not-a-ga4-id" },
		});

		await client.send(new Request(`${origin}/api/lead`), { name: "generate_lead" });

		expect(calls).toEqual([]);
		expect(String(log.mock.calls[0]?.[0])).toContain("measurementId");
		log.mockRestore();
	});

	it("drops events without touching the network when server events are off", async () => {
		const calls: string[] = [];
		const client = createAnalytics({
			gtmId: GTM_ID,
			sgtm: {
				fetch: async (request) => {
					calls.push(new URL(request.url).pathname);
					return script();
				},
			},
			openpanel,
			serverEvents: false,
		});

		await client.send(new Request(`${origin}/api/lead`), { name: "generate_lead" });

		expect(calls).toEqual([]);
	});
});
