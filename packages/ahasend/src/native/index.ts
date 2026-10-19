import type { PluginDescriptor } from "emdash";

import { AhaSendDeliveryError, type AhaSendAttachment, type AhaSendMessage } from "../client.js";
import { PLUGIN_ID, PLUGIN_VERSION, assertValidConfig, type AhaSendConfig } from "./config.js";
import { defaultDeps, sendWithConfig } from "./send.js";

export { AhaSendDeliveryError };
export type { AhaSendAttachment, AhaSendConfig, AhaSendMessage };

/**
 * AhaSend transport for the emdash() integration's `plugins` array. The API key and account ID
 * are read at delivery time from Worker secrets (default `AHASEND_API_KEY` and
 * `AHASEND_ACCOUNT_ID`), so nothing is configured in the admin.
 */
export function ahaSend(config: AhaSendConfig): PluginDescriptor<AhaSendConfig> {
	assertValidConfig(config);
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		entrypoint: "@numoteq/emdash-plugin-ahasend/native/plugin",
		format: "native",
		options: config,
		capabilities: ["hooks.email-transport:register"],
	};
}

/**
 * Sends a message from site code (forms, Workflows) with the same sender as {@link ahaSend}.
 * Supports attachments, which EmDash email cannot carry. Throws on failure; an
 * {@link AhaSendDeliveryError} names the rejected recipient, and AhaSend API errors
 * surface as the SDK's `AhaSendAPIError`.
 */
export function sendEmail(
	config: AhaSendConfig,
	message: AhaSendMessage,
	options?: { idempotencyKey?: string },
): Promise<{ id?: string }> {
	return sendWithConfig(config, message, defaultDeps, options?.idempotencyKey);
}

export default ahaSend;
