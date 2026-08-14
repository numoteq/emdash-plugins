import { describe, expect, it, vi } from "vitest";

import type { PluginContext } from "emdash/plugin";

import plugin, { deliverWithForwardEmail } from "../src/plugin.js";

describe("deliverWithForwardEmail", () => {
	it("sends the EmDash message to the Forward Email API", async () => {
		const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));

		await deliverWithForwardEmail(
			fetchFn,
			{ apiToken: "secret-token", from: "cms@example.com" },
			{
				to: "reader@example.net",
				subject: "Welcome",
				text: "Hello",
				html: "<p>Hello</p>",
			},
		);

		expect(fetchFn).toHaveBeenCalledOnce();
		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe("https://api.forwardemail.net/v1/emails");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({
			Authorization: `Basic ${btoa("secret-token:")}`,
			"Content-Type": "application/x-www-form-urlencoded",
		});
		expect(new URLSearchParams(String(init?.body))).toEqual(
			new URLSearchParams({
				from: "cms@example.com",
				to: "reader@example.net",
				subject: "Welcome",
				text: "Hello",
				html: "<p>Hello</p>",
			}),
		);
	});

	it("surfaces a bounded Forward Email error response", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("invalid sender", { status: 422 }));

		await expect(
			deliverWithForwardEmail(
				fetchFn,
				{ apiToken: "secret-token", from: "cms@example.com" },
				{ to: "reader@example.net", subject: "Welcome", text: "Hello" },
			),
		).rejects.toThrow("Forward Email rejected the message with HTTP 422: invalid sender");
	});

	it("registers an exclusive email transport hook", async () => {
		const hook = plugin.hooks?.["email:deliver"];
		if (!hook || typeof hook !== "object" || !("handler" in hook)) {
			throw new Error("email:deliver hook not found");
		}

		const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
		const context = {
			http: { fetch: fetchFn },
			kv: {
				get: vi.fn<(key: string) => Promise<string>>(async (key) =>
					key === "settings:apiToken" ? "secret-token" : "cms@example.com",
				),
			},
			log: { info: vi.fn<() => void>() },
		} as unknown as PluginContext;

		await hook.handler(
			{
				message: { to: "reader@example.net", subject: "Welcome", text: "Hello" },
				source: "system",
			},
			context,
		);

		expect(hook.exclusive).toBe(true);
		expect(fetchFn).toHaveBeenCalledOnce();
	});
});
