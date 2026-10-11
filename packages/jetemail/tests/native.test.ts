import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginContext } from "emdash/plugin";

import { jetEmail } from "../src/native/index.js";
import { createJetEmailDeliver } from "../src/native/plugin.js";

const config = {
	from: { email: "noreply@example.com", name: "Example" },
	replyTo: "info@example.com",
};
const context = { log: { info: vi.fn<() => void>() } } as unknown as PluginContext;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("jetEmail", () => {
	it("describes a native plugin with its entrypoint", () => {
		expect(jetEmail(config)).toMatchObject({
			id: "jetemail",
			format: "native",
			entrypoint: "@numoteq/emdash-plugin-jetemail/native/plugin",
			options: config,
		});
	});

	it("rejects a sender without a name", () => {
		expect(() => jetEmail({ from: { email: "noreply@example.com", name: " " } })).toThrow(
			"config.from",
		);
	});
});

describe("createJetEmailDeliver", () => {
	it("sends with the key from the Worker secret and the default reply-to", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ id: "abc" }, { status: 201 }));
		vi.stubGlobal("fetch", fetchFn);

		await createJetEmailDeliver(config, async () => ({ JETEMAIL_API_KEY: "transactional_secret" }))(
			{
				message: { to: "reader@example.net", subject: "Welcome", text: "Hello" },
				source: "system",
			},
			context,
		);

		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe("https://api.jetemail.com/email");
		expect(init?.headers).toMatchObject({ Authorization: "Bearer transactional_secret" });
		expect(JSON.parse(String(init?.body))).toEqual({
			from: "Example <noreply@example.com>",
			to: "reader@example.net",
			reply_to: "info@example.com",
			subject: "Welcome",
			text: "Hello",
		});
	});

	it("fails clearly when the secret is missing", async () => {
		await expect(
			createJetEmailDeliver({ ...config, secret: "MAIL_KEY" }, async () => ({}))(
				{
					message: { to: "reader@example.net", subject: "Welcome", text: "Hello" },
					source: "system",
				},
				context,
			),
		).rejects.toThrow('Worker secret "MAIL_KEY" is not set');
	});
});
