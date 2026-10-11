import type { PluginDescriptor } from "emdash";

import { JetEmailError, type JetEmailAttachment, type JetEmailMessage } from "../client.js";
import { PLUGIN_ID, PLUGIN_VERSION, assertValidConfig, type JetEmailConfig } from "./config.js";
import { defaultDeps, sendWithConfig } from "./send.js";

export { JetEmailError };
export type { JetEmailAttachment, JetEmailConfig, JetEmailMessage };

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

/**
 * Sends a message from site code (forms, Workflows) with the same sender as {@link jetEmail}.
 * Supports attachments, which EmDash email cannot carry. Throws on failure; a
 * {@link JetEmailError} carries the HTTP status.
 */
export function sendEmail(
	config: JetEmailConfig,
	message: JetEmailMessage,
): Promise<{ id?: string }> {
	return sendWithConfig(config, message, defaultDeps);
}

export default jetEmail;
