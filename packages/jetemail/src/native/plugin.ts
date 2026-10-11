import { definePlugin } from "emdash";
import type { EmailDeliverEvent, PluginContext } from "emdash/plugin";

import { deliverWithJetEmail } from "../client.js";
import { PLUGIN_ID, PLUGIN_VERSION, assertValidConfig, type JetEmailConfig } from "./config.js";

type LoadEnv = () => Promise<Record<string, unknown>>;

// Hooks run without request context, so the secret comes from the Worker env module.
async function loadWorkerEnv(): Promise<Record<string, unknown>> {
	try {
		const { env } = await import("./env.js");
		return env;
	} catch {
		throw new Error(
			"[jetemail] cloudflare:workers is not available; this provider runs only on Cloudflare Workers.",
		);
	}
}

/** @internal Exported for tests. */
export function createJetEmailDeliver(config: JetEmailConfig, loadEnv: LoadEnv = loadWorkerEnv) {
	const secret = config.secret ?? "JETEMAIL_API_KEY";
	return async (event: EmailDeliverEvent, ctx: PluginContext) => {
		const apiToken = (await loadEnv())[secret];
		if (typeof apiToken !== "string" || !apiToken) {
			throw new Error(
				`[jetemail] Worker secret "${secret}" is not set (wrangler secret put ${secret}).`,
			);
		}
		const { message } = event;
		const result = await deliverWithJetEmail(
			fetch,
			{ apiToken, fromName: config.from.name, fromEmail: config.from.email },
			{ ...message, replyTo: message.replyTo ?? config.replyTo },
		);
		ctx.log.info("Email delivered via JetEmail", {
			to: message.to,
			subject: message.subject,
			id: result.id,
		});
	};
}

/** Called by EmDash with the options of the {@link jetEmail} descriptor. */
export function createPlugin(config: JetEmailConfig) {
	assertValidConfig(config);
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: ["hooks.email-transport:register"],
		hooks: { "email:deliver": { exclusive: true, handler: createJetEmailDeliver(config) } },
	});
}
