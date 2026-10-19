import pkg from "../../package.json" with { type: "json" };

export interface AhaSendConfig {
	/**
	 * Sender. The domain must be verified in AhaSend and allowed for the API key.
	 * The name defaults to the site title from EmDash settings.
	 */
	from: { email: string; name?: string };
	/** Reply-To used when the message sets none. */
	replyTo?: string;
	/** Name of the Worker secret that holds the API key. @default "AHASEND_API_KEY" */
	secret?: string;
	/** Name of the Worker secret that holds the account ID. @default "AHASEND_ACCOUNT_ID" */
	accountIdSecret?: string;
}

export const PLUGIN_ID = "ahasend";
export const PLUGIN_VERSION = pkg.version;

// Validate early so a misconfigured site fails at build time, not on the first email.
export function assertValidConfig(config: AhaSendConfig): void {
	if (!config.from?.email?.includes("@")) {
		throw new Error(
			'[ahasend] config.from needs an email, e.g. { from: { email: "noreply@example.com" } }',
		);
	}
}
