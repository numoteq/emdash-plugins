import { describe, expect, it, vi } from "vitest";

import type { PluginContext } from "emdash/plugin";

import pkg from "../package.json" with { type: "json" };
import { AhaSendDeliveryError } from "../src/client.js";
import { ahaSend } from "../src/native/index.js";
import { createAhaSendDeliver } from "../src/native/plugin.js";
import { sendWithConfig, type SendDeps } from "../src/native/send.js";

const accountId = "11111111-2222-3333-4444-555555555555";
const config = {
	from: { email: "noreply@example.com", name: "Example" },
	replyTo: "info@example.com",
};
const message = { to: "reader@example.net", subject: "Welcome", text: "Hello" };

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

function deps(env: Record<string, unknown>, siteTitle?: string) {
	const fetchFn = vi
		.fn<SendDeps["fetch"]>()
		.mockResolvedValue(accepted(["reader@example.net"], ["<abc@ahasend.com>"]));
	const warn = vi.fn<SendDeps["warn"]>();
	const value: SendDeps = {
		env: async () => env,
		siteTitle: async () => siteTitle,
		fetch: fetchFn,
		warn,
	};
	return { deps: value, fetchFn, warn };
}

function sentBody(fetchFn: ReturnType<typeof deps>["fetchFn"]) {
	return JSON.parse(String(fetchFn.mock.calls[0]![1]?.body));
}

const key = { AHASEND_API_KEY: "aha-sk-test-secret", AHASEND_ACCOUNT_ID: accountId };

describe("ahaSend", () => {
	it("describes a native plugin with the package version", () => {
		expect(ahaSend(config)).toMatchObject({
			id: "ahasend",
			version: pkg.version,
			format: "native",
			entrypoint: "@numoteq/emdash-plugin-ahasend/native/plugin",
			options: config,
		});
	});

	it("accepts a sender without a name", () => {
		expect(() => ahaSend({ from: { email: "noreply@example.com" } })).not.toThrow();
	});

	it("rejects a sender without an email", () => {
		expect(() => ahaSend({ from: { email: "" } })).toThrow("config.from");
	});
});

describe("sendWithConfig", () => {
	it("sends with the key from the Worker secrets and the default reply-to", async () => {
		const { deps: d, fetchFn } = deps(key);

		await expect(sendWithConfig(config, message, d)).resolves.toEqual({ id: "<abc@ahasend.com>" });

		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe(`https://api.ahasend.com/v2/accounts/${accountId}/messages`);
		expect(init?.headers).toMatchObject({ authorization: "Bearer aha-sk-test-secret" });
		expect(sentBody(fetchFn)).toEqual({
			from: { email: "noreply@example.com", name: "Example" },
			subject: "Welcome",
			text_content: "Hello",
			reply_to: { email: "info@example.com" },
			recipients: [{ email: "reader@example.net" }],
		});
	});

	it("prefers the message reply-to", async () => {
		const { deps: d, fetchFn } = deps(key);

		await sendWithConfig(config, { ...message, replyTo: "visitor@example.org" }, d);

		expect(sentBody(fetchFn).reply_to).toEqual({ email: "visitor@example.org" });
	});

	it("names the sender after the site title when the config has no name", async () => {
		const { deps: d, fetchFn } = deps(key, "Example Site");

		await sendWithConfig({ from: { email: "noreply@example.com" } }, message, d);

		expect(sentBody(fetchFn).from).toEqual({ email: "noreply@example.com", name: "Example Site" });
	});

	it("fails without a sender name or site title", async () => {
		const { deps: d } = deps(key);

		await expect(
			sendWithConfig({ from: { email: "noreply@example.com" } }, message, d),
		).rejects.toThrow("No sender name");
	});

	it("fails clearly when the API key secret is missing", async () => {
		const { deps: d } = deps({ AHASEND_ACCOUNT_ID: accountId });

		await expect(sendWithConfig({ ...config, secret: "MAIL_KEY" }, message, d)).rejects.toThrow(
			'Worker secret "MAIL_KEY" is not set',
		);
	});

	it("fails clearly when the account ID secret is missing", async () => {
		const { deps: d } = deps({ AHASEND_API_KEY: key.AHASEND_API_KEY });

		await expect(
			sendWithConfig({ ...config, accountIdSecret: "MAIL_ACCOUNT" }, message, d),
		).rejects.toThrow('Worker secret "MAIL_ACCOUNT" is not set');
	});

	it("only logs the message in dry-run mode, even without secrets", async () => {
		const { deps: d, fetchFn, warn } = deps({ AHASEND_DRY_RUN: "true" });

		await expect(sendWithConfig(config, message, d)).resolves.toEqual({});

		expect(fetchFn).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith("[ahasend] AHASEND_DRY_RUN=true, email not sent", {
			from: "Example <noreply@example.com>",
			to: "reader@example.net",
			replyTo: "info@example.com",
			subject: "Welcome",
		});
	});

	it("sends normally unless dry-run is exactly true", async () => {
		const { deps: d, fetchFn } = deps({ ...key, AHASEND_DRY_RUN: "1" });

		await sendWithConfig(config, message, d);

		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it("reports a recipient AhaSend did not queue", async () => {
		const { deps: d, fetchFn } = deps(key);
		fetchFn.mockResolvedValue(
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

		const error = await sendWithConfig(
			{ ...config, from: { email: "noreply@example.com", name: "Example" } },
			{ ...message, to: "blocked@example.net" },
			d,
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(AhaSendDeliveryError);
		expect((error as AhaSendDeliveryError).recipient).toBe("blocked@example.net");
	});

	it("reports the API status of a rejected message", async () => {
		const { deps: d, fetchFn } = deps(key);
		fetchFn.mockResolvedValue(Response.json({ message: "Invalid sender" }, { status: 400 }));

		const error = await sendWithConfig(config, message, d).catch((caught: unknown) => caught);

		expect(error).toMatchObject({ name: "AhaSendBadRequestError", status: 400 });
	});
});

describe("createAhaSendDeliver", () => {
	it("falls back to the EmDash site name for the sender", async () => {
		const { deps: d, fetchFn } = deps(key);
		const context = {
			site: { name: "Setup Title" },
			log: { info: vi.fn<() => void>() },
		} as unknown as PluginContext;

		await createAhaSendDeliver({ from: { email: "noreply@example.com" } }, d)(
			{
				message: { to: "reader@example.net", subject: "Welcome", text: "Hello" },
				source: "system",
			},
			context,
		);

		expect(sentBody(fetchFn).from).toEqual({ email: "noreply@example.com", name: "Setup Title" });
		expect(context.log.info).toHaveBeenCalledOnce();
	});
});
