import { deliverWithAhaSend, formatSender, type FetchFn, type AhaSendMessage } from "../client.js";
import type { AhaSendConfig } from "./config.js";

export interface SendDeps {
	env: () => Promise<Record<string, unknown>>;
	siteTitle: () => Promise<string | undefined>;
	fetch: FetchFn;
	warn: (message: string, data: Record<string, unknown>) => void;
}

// Hooks and Workflows run without request context, so the secret comes from the Worker env module.
async function loadWorkerEnv(): Promise<Record<string, unknown>> {
	try {
		const { env } = await import("./env.js");
		return env;
	} catch {
		throw new Error(
			"[ahasend] cloudflare:workers is not available; this provider runs only on Cloudflare Workers.",
		);
	}
}

// The admin-editable title (Settings > General). Outside a request (Workflows) it may be unreadable.
async function loadSiteTitle(): Promise<string | undefined> {
	try {
		const { getSiteSetting } = await import("emdash");
		return await getSiteSetting("title");
	} catch {
		return undefined;
	}
}

export const defaultDeps: SendDeps = {
	env: loadWorkerEnv,
	siteTitle: loadSiteTitle,
	fetch: (url, init) => fetch(url, init),
	warn: (message, data) => console.warn(message, data),
};

function readEnv(env: Record<string, unknown>, name: string): string {
	const value = env[name];
	if (typeof value !== "string" || !value) {
		throw new Error(`[ahasend] Worker secret "${name}" is not set (wrangler secret put ${name}).`);
	}
	return value;
}

/**
 * Sends one message with the configured sender. With the Worker variable `AHASEND_DRY_RUN=true`
 * the message is only logged; E2E runs use it because they have no API key.
 */
export async function sendWithConfig(
	config: AhaSendConfig,
	message: AhaSendMessage,
	deps: SendDeps,
	idempotencyKey?: string,
): Promise<{ id?: string }> {
	const fromName = config.from.name?.trim() || (await deps.siteTitle())?.trim();
	if (!fromName) {
		throw new Error("[ahasend] No sender name: set config.from.name or the site title.");
	}
	const replyTo = message.replyTo ?? config.replyTo;
	const env = await deps.env();

	if (env.AHASEND_DRY_RUN === "true") {
		deps.warn("[ahasend] AHASEND_DRY_RUN=true, email not sent", {
			from: formatSender(fromName, config.from.email),
			to: message.to,
			replyTo,
			subject: message.subject,
		});
		return {};
	}

	const apiKey = readEnv(env, config.secret ?? "AHASEND_API_KEY");
	const accountId = readEnv(env, config.accountIdSecret ?? "AHASEND_ACCOUNT_ID");
	return deliverWithAhaSend(
		{ apiKey, accountId, fetch: deps.fetch },
		{ fromName, fromEmail: config.from.email },
		{ ...message, replyTo },
		idempotencyKey,
	);
}
