const API_URL = "https://api.jetemail.com/email";

export interface JetEmailSender {
	apiToken: string;
	fromName: string;
	fromEmail: string;
}

export interface JetEmailAttachment {
	filename: string;
	/** Raw bytes (Uint8Array or Node Buffer) or a base64 string. */
	content: Uint8Array | string;
}

export interface JetEmailMessage {
	to: string | string[];
	cc?: string[];
	replyTo?: string;
	subject: string;
	text?: string;
	html?: string;
	attachments?: JetEmailAttachment[];
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** JetEmail answered with a non-2xx status. HTTP 429 means the message was not accepted. */
export class JetEmailError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "JetEmailError";
	}
}

// JetEmail requires the sender as "Name <email>"; characters that would break that form are dropped.
export function formatSender(name: string, email: string): string {
	const cleanName = name.replace(/[<>"\r\n]/g, "").trim();
	return `${cleanName} <${email}>`;
}

function toBase64(content: Uint8Array | string): string {
	if (typeof content === "string") return content;
	let binary = "";
	for (let i = 0; i < content.length; i += 0x8000) {
		binary += String.fromCharCode(...content.subarray(i, i + 0x8000));
	}
	return btoa(binary);
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
	if (message.attachments?.length) {
		body.attachments = message.attachments.map((file) => ({
			filename: file.filename,
			data: toBase64(file.content),
		}));
	}

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
		throw new JetEmailError(
			`JetEmail rejected the message with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
			response.status,
		);
	}
	const result = (await response.json().catch(() => ({}))) as { id?: unknown };
	return typeof result.id === "string" ? { id: result.id } : {};
}
