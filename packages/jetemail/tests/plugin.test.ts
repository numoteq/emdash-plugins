import { describe, expect, it, vi } from "vitest";

import type { PluginContext } from "emdash/plugin";

import plugin, { deliverWithJetEmail, formatSender } from "../src/plugin.js";

const settings = {
	apiToken: "transactional_secret",
	fromName: "Example CMS",
	fromEmail: "cms@example.com",
};

describe("formatSender", () => {
	it("builds the Name <email> form JetEmail requires", () => {
		expect(formatSender("Example CMS", "cms@example.com")).toBe("Example CMS <cms@example.com>");
	});

	it("drops characters that would break the sender", () => {
		expect(formatSender(' "Evil" <x>\r\n', "cms@example.com")).toBe("Evil x <cms@example.com>");
	});
});

describe("deliverWithJetEmail", () => {
	it("sends the EmDash message to the JetEmail API", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ id: "abc" }, { status: 201 }));

		await deliverWithJetEmail(fetchFn, settings, {
			to: "reader@example.net",
			cc: ["editor@example.net"],
			replyTo: "help@example.com",
			subject: "Welcome",
			text: "Hello",
			html: "<p>Hello</p>",
		});

		expect(fetchFn).toHaveBeenCalledOnce();
		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe("https://api.jetemail.com/email");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({
			Authorization: "Bearer transactional_secret",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			from: "Example CMS <cms@example.com>",
			to: "reader@example.net",
			cc: ["editor@example.net"],
			reply_to: "help@example.com",
			subject: "Welcome",
			text: "Hello",
			html: "<p>Hello</p>",
		});
	});

	it("omits optional fields that are not set", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ id: "abc" }, { status: 201 }));

		await deliverWithJetEmail(fetchFn, settings, {
			to: "reader@example.net",
			cc: [],
			subject: "Welcome",
			text: "Hello",
		});

		expect(JSON.parse(String(fetchFn.mock.calls[0]![1]?.body))).toEqual({
			from: "Example CMS <cms@example.com>",
			to: "reader@example.net",
			subject: "Welcome",
			text: "Hello",
		});
	});

	it("surfaces a bounded JetEmail error response", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("Domain security violation", { status: 400 }));

		await expect(
			deliverWithJetEmail(fetchFn, settings, {
				to: "reader@example.net",
				subject: "Welcome",
				text: "Hello",
			}),
		).rejects.toThrow("JetEmail rejected the message with HTTP 400: Domain security violation");
	});
});

describe("plugin", () => {
	it("registers an exclusive email transport hook", async () => {
		const hook = plugin.hooks?.["email:deliver"];
		if (!hook || typeof hook !== "object" || !("handler" in hook)) {
			throw new Error("email:deliver hook not found");
		}

		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ id: "abc" }, { status: 201 }));
		const values: Record<string, string> = {
			"settings:apiToken": settings.apiToken,
			"settings:fromName": settings.fromName,
			"settings:fromEmail": settings.fromEmail,
		};
		const context = {
			http: { fetch: fetchFn },
			kv: { get: vi.fn<(key: string) => Promise<string>>(async (key) => values[key]!) },
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

	it("defaults the sender name to the site name and applies the configured reply-to", async () => {
		const hook = plugin.hooks?.["email:deliver"];
		if (!hook || typeof hook !== "object" || !("handler" in hook)) {
			throw new Error("email:deliver hook not found");
		}

		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ id: "abc" }, { status: 201 }));
		const values: Record<string, string> = {
			"settings:apiToken": settings.apiToken,
			"settings:fromName": "",
			"settings:fromEmail": settings.fromEmail,
			"settings:replyTo": "help@example.com",
		};
		const context = {
			site: { name: "Example Site" },
			http: { fetch: fetchFn },
			kv: { get: vi.fn<(key: string) => Promise<string>>(async (key) => values[key]!) },
			log: { info: vi.fn<() => void>() },
		} as unknown as PluginContext;

		await hook.handler(
			{
				message: { to: "reader@example.net", subject: "Welcome", text: "Hello" },
				source: "system",
			},
			context,
		);

		expect(JSON.parse(String(fetchFn.mock.calls[0]![1]?.body))).toMatchObject({
			from: "Example Site <cms@example.com>",
			reply_to: "help@example.com",
		});
	});

	it("refuses to deliver until it is configured", async () => {
		const hook = plugin.hooks?.["email:deliver"];
		if (!hook || typeof hook !== "object" || !("handler" in hook)) {
			throw new Error("email:deliver hook not found");
		}

		const context = {
			site: { name: "Example Site" },
			http: { fetch: vi.fn<typeof fetch>() },
			kv: { get: vi.fn<() => Promise<undefined>>(async () => undefined) },
			log: { info: vi.fn<() => void>() },
		} as unknown as PluginContext;

		await expect(
			hook.handler(
				{
					message: { to: "reader@example.net", subject: "Welcome", text: "Hello" },
					source: "system",
				},
				context,
			),
		).rejects.toThrow("JetEmail is not configured");
	});
});

describe("attachments", () => {
	it("sends bytes and base64 strings as base64 data", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ id: "abc" }, { status: 201 }));

		await deliverWithJetEmail(fetchFn, settings, {
			to: "reader@example.net",
			subject: "Invoice",
			text: "Attached",
			attachments: [
				{ filename: "a.txt", content: new TextEncoder().encode("Hello") },
				{ filename: "b.txt", content: "SGk=" },
			],
		});

		expect(JSON.parse(String(fetchFn.mock.calls[0]![1]?.body)).attachments).toEqual([
			{ filename: "a.txt", data: "SGVsbG8=" },
			{ filename: "b.txt", data: "SGk=" },
		]);
	});
});
