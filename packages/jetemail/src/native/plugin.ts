import { definePlugin } from "emdash";
import type { EmailDeliverEvent, PluginContext } from "emdash/plugin";

import { PLUGIN_ID, PLUGIN_VERSION, assertValidConfig, type JetEmailConfig } from "./config.js";
import { defaultDeps, sendWithConfig, type SendDeps } from "./send.js";

/** @internal Exported for tests. */
export function createJetEmailDeliver(config: JetEmailConfig, deps: SendDeps = defaultDeps) {
	return async (event: EmailDeliverEvent, ctx: PluginContext) => {
		const { message } = event;
		const result = await sendWithConfig(config, message, {
			...deps,
			siteTitle: async () => (await deps.siteTitle()) || ctx.site.name,
		});
		if (result.id) {
			ctx.log.info("Email delivered via JetEmail", {
				to: message.to,
				subject: message.subject,
				id: result.id,
			});
		}
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
