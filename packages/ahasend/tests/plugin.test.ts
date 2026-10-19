import { describe, expect, it, vi } from "vitest";

import type { PluginContext } from "emdash/plugin";

import plugin, { deliverWithAhaSend, formatSender, formatSenderName } from "../src/plugin.js";

const accountId = "11111111-2222-3333-4444-555555555555";
const sender = { fromName: "Example CMS", fromEmail: "cms@example.com" };
const settings = {
	apiKey: "aha-sk-test-secret",
	accountId,
	fromName: sender.fromName,
	fromEmail: sender.fromEmail,
};

function clientOptions(fetchFn: typeof fetch) {
	return { apiKey: settings.apiKey, accountId, fetch: fetchFn, retry: false as const };
}

function accepted(recipients: string[], ids?: string[]) {
	return Response.json(
		{
			object: "list",
			data: recipients.map((email, index) => ({
				object: "message",
				id: ids?.[index] ?? `<0000000${index}-1111-1111-1111-111111111111@ahasend.com>`,
				recipient: { email, name: email },
				status: "queued",
				error: null,
			})),
		},
		{ status: 202 },
	);
}

function sentBody(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>) {
	return JSON.parse(String(fetchFn.mock.calls[0]![1]?.body));
}

describe("formatSender", () => {
	it("builds the Name <email> form", () => {
		expect(formatSender("Example CMS", "cms@example.com")).toBe("Example CMS <cms@example.com>");
	});

	it("drops characters that would break the display name", () => {
		expect(formatSenderName(' "Evil" <x>\r\n')).toBe("Evil x");
		expect(formatSender(' "Evil" <x>\r\n', "cms@example.com")).toBe("Evil x <cms@example.com>");
	});
});

describe("deliverWithAhaSend", () => {
	it("sends the EmDash message to the AhaSend messages endpoint", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(accepted(["reader@example.net"], ["<abc@ahasend.com>"]));

		await expect(
			deliverWithAhaSend(clientOptions(fetchFn), sender, {
				to: "reader@example.net",
				replyTo: "help@example.com",
				subject: "Welcome",
				text: "Hello",
				html: "<p>Hello</p>",
			}),
		).resolves.toEqual({ id: "<abc@ahasend.com>" });

		expect(fetchFn).toHaveBeenCalledOnce();
		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe(`https://api.ahasend.com/v2/accounts/${accountId}/messages`);
		expect(init?.method).toBe("POST");
		expect(init?.headers).toMatchObject({
			authorization: "Bearer aha-sk-test-secret",
			"content-type": "application/json",
		});
		expect(sentBody(fetchFn)).toEqual({
			from: { email: "cms@example.com", name: "Example CMS" },
			subject: "Welcome",
			text_content: "Hello",
			html_content: "<p>Hello</p>",
			reply_to: { email: "help@example.com" },
			recipients: [{ email: "reader@example.net" }],
		});
	});

	it("uses the conversation endpoint when cc is set", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(accepted(["reader@example.net", "editor@example.net"]));

		await deliverWithAhaSend(clientOptions(fetchFn), sender, {
			to: "reader@example.net",
			cc: ["editor@example.net"],
			subject: "Welcome",
			text: "Hello",
		});

		const [url] = fetchFn.mock.calls[0]!;
		expect(url).toBe(`https://api.ahasend.com/v2/accounts/${accountId}/messages/conversation`);
		expect(sentBody(fetchFn)).toEqual({
			from: { email: "cms@example.com", name: "Example CMS" },
			subject: "Welcome",
			text_content: "Hello",
			to: [{ email: "reader@example.net" }],
			cc: [{ email: "editor@example.net" }],
		});
	});

	it("fans out to several recipients without cc", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(accepted(["a@example.net", "b@example.net"]));

		await deliverWithAhaSend(clientOptions(fetchFn), sender, {
			to: ["a@example.net", "b@example.net"],
			subject: "Welcome",
			text: "Hello",
		});

		expect(sentBody(fetchFn).recipients).toEqual([
			{ email: "a@example.net" },
			{ email: "b@example.net" },
		]);
	});

	it("omits optional fields that are not set and passes the idempotency key", async () => {
		const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(accepted(["reader@example.net"]));

		await deliverWithAhaSend(
			clientOptions(fetchFn),
			{ fromName: "Example CMS", fromEmail: "cms@example.com" },
			{ to: "reader@example.net", cc: [], subject: "Welcome", text: "Hello" },
			"welcome-reader",
		);

		expect(sentBody(fetchFn)).toEqual({
			from: { email: "cms@example.com", name: "Example CMS" },
			subject: "Welcome",
			text_content: "Hello",
			recipients: [{ email: "reader@example.net" }],
		});
		expect(fetchFn.mock.calls[0]![1]?.headers).toMatchObject({
			"idempotency-key": "welcome-reader",
		});
	});

	it("reports a recipient that AhaSend did not queue", async () => {
		const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json(
				{
					object: "list",
					data: [
						{
							object: "message",
							id: null,
							recipient: { email: "blocked@example.net", name: "blocked@example.net" },
							status: "error",
							error: "Recipient is suppressed",
						},
					],
				},
				{ status: 202 },
			),
		);

		const error = await deliverWithAhaSend(clientOptions(fetchFn), sender, {
			to: "blocked@example.net",
			subject: "Welcome",
			text: "Hello",
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({
			name: "AhaSendDeliveryError",
			recipient: "blocked@example.net",
			error: "Recipient is suppressed",
		});
		expect((error as Error).message).toBe(
			"AhaSend rejected blocked@example.net: Recipient is suppressed",
		);
	});

	it("lets AhaSend API errors propagate", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ message: "Invalid sender" }, { status: 400 }));

		const error = await deliverWithAhaSend(clientOptions(fetchFn), sender, {
			to: "reader@example.net",
			subject: "Welcome",
			text: "Hello",
		}).catch((caught: unknown) => caught);

		expect(error).toMatchObject({ name: "AhaSendBadRequestError", status: 400 });
		expect(error instanceof Error).toBe(true);
	});

	it("sends bytes and base64 strings as base64 data", async () => {
		const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(accepted(["reader@example.net"]));

		await deliverWithAhaSend(clientOptions(fetchFn), sender, {
			to: "reader@example.net",
			subject: "Invoice",
			text: "Attached",
			attachments: [
				{
					filename: "a.txt",
					content: new TextEncoder().encode("Hello"),
					contentType: "text/plain",
				},
				{ filename: "b.bin", content: "SGk=" },
			],
		});

		expect(sentBody(fetchFn).attachments).toEqual([
			{ file_name: "a.txt", content_type: "text/plain", data: "SGVsbG8=", base64: true },
			{ file_name: "b.bin", content_type: "application/octet-stream", data: "SGk=", base64: true },
		]);
	});
});

describe("plugin", () => {
	it("registers an exclusive email transport hook", async () => {
		const hook = plugin.hooks?.["email:deliver"];
		if (!hook || typeof hook !== "object" || !("handler" in hook)) {
			throw new Error("email:deliver hook not found");
		}

		const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(accepted(["reader@example.net"]));
		const values: Record<string, string> = {
			"settings:apiKey": settings.apiKey,
			"settings:accountId": settings.accountId,
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
		expect(hook.timeout).toBe(30_000);
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it("defaults the sender name to the site name and applies the configured reply-to", async () => {
		const hook = plugin.hooks?.["email:deliver"];
		if (!hook || typeof hook !== "object" || !("handler" in hook)) {
			throw new Error("email:deliver hook not found");
		}

		const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(accepted(["reader@example.net"]));
		const values: Record<string, string> = {
			"settings:apiKey": settings.apiKey,
			"settings:accountId": settings.accountId,
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

		expect(sentBody(fetchFn)).toMatchObject({
			from: { email: "cms@example.com", name: "Example Site" },
			reply_to: { email: "help@example.com" },
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
		).rejects.toThrow("AhaSend is not configured");
	});

	it("validates the API key and account ID in the settings form", async () => {
		const route = plugin.routes?.admin;
		if (!route || typeof route !== "object" || !("handler" in route)) {
			throw new Error("admin route not found");
		}

		const set = vi.fn<(key: string, value: string) => Promise<void>>(async () => {});
		const context = {
			kv: { get: vi.fn<() => Promise<undefined>>(async () => undefined), set },
		} as unknown as PluginContext;

		const submit = (values: Record<string, unknown>) =>
			route.handler(
				{ input: { type: "form_submit", action_id: "save_settings", values } } as never,
				context,
			) as Promise<{ toast?: { type: string; message: string } }>;

		await expect(
			submit({
				fromEmail: "cms@example.com",
				accountId,
				apiKey: "transactional_secret",
			}),
		).resolves.toMatchObject({ toast: { type: "error" } });

		await expect(
			submit({
				fromEmail: "cms@example.com",
				accountId: "not-a-uuid",
				apiKey: "aha-sk-test-secret",
			}),
		).resolves.toMatchObject({ toast: { type: "error" } });

		await expect(
			submit({
				fromEmail: "cms@example.com",
				accountId,
				apiKey: "aha-sk-test-secret",
			}),
		).resolves.toMatchObject({ toast: { type: "success" } });

		expect(set).toHaveBeenCalledWith("settings:accountId", accountId);
		expect(set).toHaveBeenCalledWith("settings:apiKey", "aha-sk-test-secret");
	});
});
