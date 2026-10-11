import type { PluginDescriptor } from "emdash";

import { PLUGIN_ID, PLUGIN_VERSION, assertValidConfig, type JetEmailConfig } from "./config.js";

export type { JetEmailConfig };

/**
 * JetEmail transport for the emdash() integration's `plugins` array. The API key is read at
 * delivery time from a Worker secret (default `JETEMAIL_API_KEY`), so nothing is configured in the admin.
 */
export function jetEmail(config: JetEmailConfig): PluginDescriptor<JetEmailConfig> {
	assertValidConfig(config);
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		entrypoint: "@numoteq/emdash-plugin-jetemail/native/plugin",
		format: "native",
		options: config,
		capabilities: ["hooks.email-transport:register"],
	};
}

export default jetEmail;
