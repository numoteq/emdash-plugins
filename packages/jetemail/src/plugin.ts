import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { deliverWithJetEmail, formatSender, type JetEmailSender } from "./client.js";

export { deliverWithJetEmail, formatSender };

async function getSettings(ctx: PluginContext): Promise<JetEmailSender> {
	const apiToken = await ctx.kv.get<string>("settings:apiToken");
	const fromName = await ctx.kv.get<string>("settings:fromName");
	const fromEmail = await ctx.kv.get<string>("settings:fromEmail");
	if (!apiToken || !fromName || !fromEmail) {
		throw new Error("JetEmail is not configured. Set the API key, sender name and sender email.");
	}
	return { apiToken, fromName, fromEmail };
}

async function buildSettingsPage(ctx: PluginContext) {
	const fromName = (await ctx.kv.get<string>("settings:fromName")) ?? "";
	const fromEmail = (await ctx.kv.get<string>("settings:fromEmail")) ?? "";
	const hasToken = Boolean(await ctx.kv.get<string>("settings:apiToken"));

	return {
		blocks: [
			{ type: "header", text: "JetEmail" },
			{
				type: "section",
				text: "Deliver EmDash transactional email through the JetEmail API. The sender domain must be verified in JetEmail and allowed for the API key.",
			},
			{
				type: "form",
				block_id: "jetemail-settings",
				fields: [
					{
						type: "text_input",
						action_id: "fromName",
						label: "Sender name",
						initial_value: fromName,
					},
					{
						type: "text_input",
						action_id: "fromEmail",
						label: "Sender email",
						initial_value: fromEmail,
					},
					{
						type: "secret_input",
						action_id: "apiToken",
						label: hasToken
							? "Transactional API key (leave blank to keep current)"
							: "Transactional API key",
					},
				],
				submit: { label: "Save settings", action_id: "save_settings" },
			},
		],
	};
}

function invalid(text: string) {
	return {
		blocks: [{ type: "banner", style: "error", text }],
		toast: { message: text, type: "error" },
	};
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
	const fromName = typeof values.fromName === "string" ? values.fromName.trim() : "";
	const fromEmail = typeof values.fromEmail === "string" ? values.fromEmail.trim() : "";
	const apiToken = typeof values.apiToken === "string" ? values.apiToken.trim() : "";

	if (!fromName.replace(/[<>"\r\n]/g, "").trim()) return invalid("Enter a sender name.");
	if (!/^[^\s@<>]+@[^\s@<>]+$/.test(fromEmail)) return invalid("Enter a valid sender email.");
	if (apiToken && !apiToken.startsWith("transactional_")) {
		return invalid("Use a JetEmail transactional API key (transactional_…).");
	}

	await ctx.kv.set("settings:fromName", fromName);
	await ctx.kv.set("settings:fromEmail", fromEmail);
	if (apiToken) await ctx.kv.set("settings:apiToken", apiToken);

	return {
		...(await buildSettingsPage(ctx)),
		toast: { message: "JetEmail settings saved", type: "success" },
	};
}

const plugin: SandboxedPlugin = {
	hooks: {
		"email:deliver": {
			exclusive: true,
			timeout: 30_000,
			handler: async (event, ctx) => {
				if (!ctx.http) throw new Error("JetEmail requires network access.");
				const settings = await getSettings(ctx);
				await deliverWithJetEmail(ctx.http.fetch.bind(ctx.http), settings, event.message);
				ctx.log.info("Email delivered via JetEmail", {
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
