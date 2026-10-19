import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import {
	deliverWithAhaSend,
	formatSender,
	formatSenderName,
	type AhaSendSender,
} from "./client.js";

export { deliverWithAhaSend, formatSender, formatSenderName };

interface AhaSendSettings {
	apiKey: string;
	accountId: string;
	fromName: string;
	fromEmail: string;
	replyTo?: string;
}

async function getSettings(ctx: PluginContext): Promise<AhaSendSettings> {
	const apiKey = await ctx.kv.get<string>("settings:apiKey");
	const accountId = await ctx.kv.get<string>("settings:accountId");
	const fromName = (await ctx.kv.get<string>("settings:fromName")) || ctx.site.name;
	const fromEmail = await ctx.kv.get<string>("settings:fromEmail");
	const replyTo = (await ctx.kv.get<string>("settings:replyTo")) || undefined;
	if (!apiKey || !accountId || !fromName || !fromEmail) {
		throw new Error("AhaSend is not configured. Set the API key, account ID and sender email.");
	}
	return { apiKey, accountId, fromName, fromEmail, replyTo };
}

async function buildSettingsPage(ctx: PluginContext) {
	const accountId = (await ctx.kv.get<string>("settings:accountId")) ?? "";
	const fromName = (await ctx.kv.get<string>("settings:fromName")) ?? "";
	const fromEmail = (await ctx.kv.get<string>("settings:fromEmail")) ?? "";
	const replyTo = (await ctx.kv.get<string>("settings:replyTo")) ?? "";
	const hasKey = Boolean(await ctx.kv.get<string>("settings:apiKey"));

	return {
		blocks: [
			{ type: "header", text: "AhaSend" },
			{
				type: "section",
				text: "Deliver EmDash transactional email through the AhaSend API. The sender domain must be verified in AhaSend and allowed for the API key.",
			},
			{
				type: "form",
				block_id: "ahasend-settings",
				fields: [
					{
						type: "text_input",
						action_id: "fromName",
						label: "Sender name (defaults to the site title)",
						initial_value: fromName,
					},
					{
						type: "text_input",
						action_id: "fromEmail",
						label: "Sender email",
						initial_value: fromEmail,
					},
					{
						type: "text_input",
						action_id: "replyTo",
						label: "Reply-To (optional)",
						initial_value: replyTo,
					},
					{
						type: "text_input",
						action_id: "accountId",
						label: "Account ID",
						initial_value: accountId,
					},
					{
						type: "secret_input",
						action_id: "apiKey",
						label: hasKey ? "API key (leave blank to keep current)" : "API key (aha-sk-…)",
					},
				],
				submit: { label: "Save settings", action_id: "save_settings" },
			},
		],
	};
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(text: string) {
	return {
		blocks: [{ type: "banner", style: "error", text }],
		toast: { message: text, type: "error" },
	};
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
	const fromName = typeof values.fromName === "string" ? values.fromName.trim() : "";
	const fromEmail = typeof values.fromEmail === "string" ? values.fromEmail.trim() : "";
	const replyTo = typeof values.replyTo === "string" ? values.replyTo.trim() : "";
	const accountId = typeof values.accountId === "string" ? values.accountId.trim() : "";
	const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";

	if (!EMAIL_RE.test(fromEmail)) return invalid("Enter a valid sender email.");
	if (replyTo && !EMAIL_RE.test(replyTo)) return invalid("Enter a valid Reply-To email.");
	if (!UUID_RE.test(accountId)) return invalid("Enter the AhaSend account ID (a UUID).");
	if (apiKey && !apiKey.startsWith("aha-sk-")) {
		return invalid("Use an AhaSend API key (aha-sk-…).");
	}

	await ctx.kv.set("settings:fromName", fromName);
	await ctx.kv.set("settings:fromEmail", fromEmail);
	await ctx.kv.set("settings:replyTo", replyTo);
	await ctx.kv.set("settings:accountId", accountId);
	if (apiKey) await ctx.kv.set("settings:apiKey", apiKey);

	return {
		...(await buildSettingsPage(ctx)),
		toast: { message: "AhaSend settings saved", type: "success" },
	};
}

const plugin: SandboxedPlugin = {
	hooks: {
		"email:deliver": {
			exclusive: true,
			timeout: 30_000,
			handler: async (event, ctx) => {
				if (!ctx.http) throw new Error("AhaSend requires network access.");
				const { apiKey, accountId, fromName, fromEmail, replyTo } = await getSettings(ctx);
				const sender: AhaSendSender = { fromName, fromEmail };
				await deliverWithAhaSend(
					{ apiKey, accountId, fetch: ctx.http.fetch.bind(ctx.http) },
					sender,
					{ ...event.message, replyTo: event.message.replyTo ?? replyTo },
				);
				ctx.log.info("Email delivered via AhaSend", {
					to: event.message.to,
					subject: event.message.subject,
				});
			},
		},
	},
	routes: {
		admin: {
			handler: async (routeCtx, ctx) => {
				const interaction = routeCtx.input as {
					type?: string;
					page?: string;
					action_id?: string;
					values?: Record<string, unknown>;
				};
				if (interaction.type === "page_load" && interaction.page === "/settings") {
					return buildSettingsPage(ctx);
				}
				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					return saveSettings(ctx, interaction.values ?? {});
				}
				return { blocks: [] };
			},
		},
	},
};

export default plugin;
