import pkg from "../../package.json" with { type: "json" };

export interface JetEmailConfig {
	/**
	 * Sender. The domain must be verified in JetEmail and allowed for the API key.
	 * The name defaults to the site title from EmDash settings.
	 */
	from: { email: string; name?: string };
	/** Reply-To used when the message sets none. */
	replyTo?: string;
	/** Name of the Worker secret that holds the transactional API key. @default "JETEMAIL_API_KEY" */
	secret?: string;
}

export const PLUGIN_ID = "jetemail";
export const PLUGIN_VERSION = pkg.version;

// Validate early so a misconfigured site fails at build time, not on the first email.
export function assertValidConfig(config: JetEmailConfig): void {
	if (!config.from?.email?.includes("@")) {
		throw new Error(
			'[jetemail] config.from needs an email, e.g. { from: { email: "noreply@example.com" } }',
		);
	}
}
