import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

const API_URL = "https://api.forwardemail.net/v1/emails";

interface ForwardEmailSettings {
	apiToken: string;
	from: string;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export async function deliverWithForwardEmail(
	fetchFn: FetchFn,
	settings: ForwardEmailSettings,
	message: {
		to: string;
		cc?: string[];
		replyTo?: string;
		subject: string;
		text: string;
		html?: string;
	},
): Promise<void> {
	const body = new URLSearchParams({
		from: settings.from,
		to: message.to,
		subject: message.subject,
		text: message.text,
	});
	if (message.html) body.set("html", message.html);
	if (message.cc?.length) body.set("cc", message.cc.join(","));
	if (message.replyTo) body.set("replyTo", message.replyTo);

	const response = await fetchFn(API_URL, {
		method: "POST",
		headers: {
			Authorization: `Basic ${btoa(`${settings.apiToken}:`)}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: body.toString(),
	});

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 500);
		throw new Error(
			`Forward Email rejected the message with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
		);
	}
}

async function getSettings(ctx: PluginContext): Promise<ForwardEmailSettings> {
	const apiToken = await ctx.kv.get<string>("settings:apiToken");
	const from = await ctx.kv.get<string>("settings:from");
	if (!apiToken || !from) {
		throw new Error("Forward Email is not configured. Set the API token and sender address.");
	}
	return { apiToken, from };
}

async function buildSettingsPage(ctx: PluginContext) {
	const from = (await ctx.kv.get<string>("settings:from")) ?? "";
	const hasToken = Boolean(await ctx.kv.get<string>("settings:apiToken"));

	return {
		blocks: [
			{ type: "header", text: "Forward Email" },
			{
				type: "section",
				text: "Deliver EmDash transactional email through the Forward Email HTTP API.",
			},
			{
				type: "form",
				block_id: "forward-email-settings",
				fields: [
					{
						type: "text_input",
						action_id: "from",
						label: "Sender email",
						initial_value: from,
					},
					{
						type: "secret_input",
						action_id: "apiToken",
						label: hasToken ? "API token (leave blank to keep current)" : "API token",
					},
				],
				submit: { label: "Save settings", action_id: "save_settings" },
			},
		],
	};
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
	const from = typeof values.from === "string" ? values.from.trim() : "";
	if (!from.includes("@")) {
		return {
			blocks: [{ type: "banner", style: "error", text: "Enter a valid sender email." }],
			toast: { message: "Invalid sender email", type: "error" },
		};
	}

	await ctx.kv.set("settings:from", from);
	if (typeof values.apiToken === "string" && values.apiToken.trim()) {
		await ctx.kv.set("settings:apiToken", values.apiToken.trim());
	}

	return {
		...(await buildSettingsPage(ctx)),
		toast: { message: "Forward Email settings saved", type: "success" },
	};
}

const plugin: SandboxedPlugin = {
	hooks: {
		"email:deliver": {
			exclusive: true,
			timeout: 30_000,
			handler: async (event, ctx) => {
				if (!ctx.http) throw new Error("Forward Email requires network access.");
				const settings = await getSettings(ctx);
				await deliverWithForwardEmail(ctx.http.fetch.bind(ctx.http), settings, event.message);
				ctx.log.info("Email delivered via Forward Email", {
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
