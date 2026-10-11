const API_URL = "https://api.jetemail.com/email";

export interface JetEmailSender {
	apiToken: string;
	fromName: string;
	fromEmail: string;
}

export interface JetEmailMessage {
	to: string | string[];
	cc?: string[];
	replyTo?: string;
	subject: string;
	text?: string;
	html?: string;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// JetEmail requires the sender as "Name <email>"; characters that would break that form are dropped.
export function formatSender(name: string, email: string): string {
	const cleanName = name.replace(/[<>"\r\n]/g, "").trim();
	return `${cleanName} <${email}>`;
}

export async function deliverWithJetEmail(
	fetchFn: FetchFn,
	sender: JetEmailSender,
	message: JetEmailMessage,
): Promise<{ id?: string }> {
	const body: Record<string, unknown> = {
		from: formatSender(sender.fromName, sender.fromEmail),
		to: message.to,
		subject: message.subject,
	};
	if (message.text) body.text = message.text;
	if (message.html) body.html = message.html;
	if (message.cc?.length) body.cc = message.cc;
	if (message.replyTo) body.reply_to = message.replyTo;

	const response = await fetchFn(API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${sender.apiToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 500);
		throw new Error(
			`JetEmail rejected the message with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
		);
	}
	const result = (await response.json().catch(() => ({}))) as { id?: unknown };
	return typeof result.id === "string" ? { id: result.id } : {};
}
