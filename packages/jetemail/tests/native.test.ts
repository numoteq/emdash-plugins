import { describe, expect, it, vi } from "vitest";

import type { PluginContext } from "emdash/plugin";

import pkg from "../package.json" with { type: "json" };
import { JetEmailError } from "../src/client.js";
import { jetEmail } from "../src/native/index.js";
import { createJetEmailDeliver } from "../src/native/plugin.js";
import { sendWithConfig, type SendDeps } from "../src/native/send.js";

const config = {
	from: { email: "noreply@example.com", name: "Example" },
	replyTo: "info@example.com",
};
const message = { to: "reader@example.net", subject: "Welcome", text: "Hello" };

function deps(env: Record<string, unknown>, siteTitle?: string) {
	const fetchFn = vi
		.fn<SendDeps["fetch"]>()
		.mockResolvedValue(Response.json({ id: "abc" }, { status: 201 }));
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

const key = { JETEMAIL_API_KEY: "transactional_secret" };

describe("jetEmail", () => {
	it("describes a native plugin with the package version", () => {
		expect(jetEmail(config)).toMatchObject({
			id: "jetemail",
			version: pkg.version,
			format: "native",
			entrypoint: "@numoteq/emdash-plugin-jetemail/native/plugin",
			options: config,
		});
	});

	it("accepts a sender without a name", () => {
		expect(() => jetEmail({ from: { email: "noreply@example.com" } })).not.toThrow();
	});

	it("rejects a sender without an email", () => {
		expect(() => jetEmail({ from: { email: "" } })).toThrow("config.from");
	});
});

describe("sendWithConfig", () => {
	it("sends with the key from the Worker secret and the default reply-to", async () => {
		const { deps: d, fetchFn } = deps(key);

		await expect(sendWithConfig(config, message, d)).resolves.toEqual({ id: "abc" });

		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe("https://api.jetemail.com/email");
		expect(init?.headers).toMatchObject({ Authorization: "Bearer transactional_secret" });
		expect(sentBody(fetchFn)).toEqual({
			from: "Example <noreply@example.com>",
			to: "reader@example.net",
			reply_to: "info@example.com",
			subject: "Welcome",
			text: "Hello",
		});
	});

	it("prefers the message reply-to", async () => {
		const { deps: d, fetchFn } = deps(key);

		await sendWithConfig(config, { ...message, replyTo: "visitor@example.org" }, d);

		expect(sentBody(fetchFn).reply_to).toBe("visitor@example.org");
	});

	it("names the sender after the site title when the config has no name", async () => {
		const { deps: d, fetchFn } = deps(key, "Example Site");

		await sendWithConfig({ from: { email: "noreply@example.com" } }, message, d);

		expect(sentBody(fetchFn).from).toBe("Example Site <noreply@example.com>");
	});

	it("fails without a sender name or site title", async () => {
		const { deps: d } = deps(key);

		await expect(
			sendWithConfig({ from: { email: "noreply@example.com" } }, message, d),
		).rejects.toThrow("No sender name");
	});

	it("fails clearly when the secret is missing", async () => {
		const { deps: d } = deps({});

		await expect(sendWithConfig({ ...config, secret: "MAIL_KEY" }, message, d)).rejects.toThrow(
			'Worker secret "MAIL_KEY" is not set',
		);
	});

	it("only logs the message in dry-run mode, even without a key", async () => {
		const { deps: d, fetchFn, warn } = deps({ JETEMAIL_DRY_RUN: "true" });

		await expect(sendWithConfig(config, message, d)).resolves.toEqual({});

		expect(fetchFn).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith("[jetemail] JETEMAIL_DRY_RUN=true, email not sent", {
			from: "Example <noreply@example.com>",
			to: "reader@example.net",
			replyTo: "info@example.com",
			subject: "Welcome",
		});
	});

	it("sends normally unless dry-run is exactly true", async () => {
		const { deps: d, fetchFn } = deps({ ...key, JETEMAIL_DRY_RUN: "1" });

		await sendWithConfig(config, message, d);

		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it("reports the HTTP status of a rejected message", async () => {
		const { deps: d, fetchFn } = deps(key);
		fetchFn.mockResolvedValue(new Response("Too many requests", { status: 429 }));

		const error = await sendWithConfig(config, message, d).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(JetEmailError);
		expect((error as JetEmailError).status).toBe(429);
	});
});

describe("createJetEmailDeliver", () => {
	it("falls back to the EmDash site name for the sender", async () => {
		const { deps: d, fetchFn } = deps(key);
		const context = {
			site: { name: "Setup Title" },
			log: { info: vi.fn<() => void>() },
		} as unknown as PluginContext;

		await createJetEmailDeliver({ from: { email: "noreply@example.com" } }, d)(
			{ message, source: "system" },
			context,
		);

		expect(sentBody(fetchFn).from).toBe("Setup Title <noreply@example.com>");
		expect(context.log.info).toHaveBeenCalledOnce();
	});
});
