import {
	AhaSendClient,
	type Attachment,
	type CreateConversationMessageRequest,
	type CreateMessageRequest,
	type RetryConfig,
} from "./sdk.js";

export interface AhaSendClientOptions {
	apiKey: string;
	accountId: string;
	/**
	 * Fetch used for every request. Cloudflare Workers need `fetch.bind(globalThis)`;
	 * sandboxed plugins pass `ctx.http.fetch.bind(ctx.http)`.
	 */
	fetch: FetchFn;
	/** SDK retry policy, or `false` to fail fast (tests, one-shot scripts). */
	retry?: RetryConfig | false;
}

export interface AhaSendSender {
	fromName: string;
	fromEmail: string;
}

export interface AhaSendAttachment {
	filename: string;
	/** Raw bytes (Uint8Array or Node Buffer) or a base64 string. */
	content: Uint8Array | string;
	/** MIME type. Defaults to `application/octet-stream`. */
	contentType?: string;
}

export interface AhaSendMessage {
	to: string | string[];
	cc?: string[];
	replyTo?: string;
	subject: string;
	text?: string;
	html?: string;
	attachments?: AhaSendAttachment[];
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** AhaSend accepted the request but did not queue the message for one recipient. */
export class AhaSendDeliveryError extends Error {
	constructor(
		readonly recipient: string,
		readonly error: string,
	) {
		super(`AhaSend rejected ${recipient}: ${error}`);
		this.name = "AhaSendDeliveryError";
	}
}

// Names with characters that would break the "Name <email>" form are dropped.
export function formatSenderName(name: string): string {
	return name.replace(/[<>"\r\n]/g, "").trim();
}

export function formatSender(name: string, email: string): string {
	return `${formatSenderName(name)} <${email}>`;
}

function toBase64(content: Uint8Array | string): string {
	if (typeof content === "string") return content;
	let binary = "";
	for (let i = 0; i < content.length; i += 0x8000) {
		binary += String.fromCharCode(...content.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function toAttachment(file: AhaSendAttachment): Attachment {
	return {
		file_name: file.filename,
		content_type: file.contentType ?? "application/octet-stream",
		data: toBase64(file.content),
		base64: true,
	};
}

function toAddresses(value: string | string[]): { email: string }[] {
	return (Array.isArray(value) ? value : [value]).map((email) => ({ email: email.trim() }));
}

function bodyFields(message: AhaSendMessage) {
	return {
		subject: message.subject,
		...(message.text ? { text_content: message.text } : {}),
		...(message.html ? { html_content: message.html } : {}),
		...(message.replyTo ? { reply_to: { email: message.replyTo } } : {}),
		...(message.attachments?.length ? { attachments: message.attachments.map(toAttachment) } : {}),
	};
}

export async function deliverWithAhaSend(
	clientOptions: AhaSendClientOptions,
	sender: AhaSendSender,
	message: AhaSendMessage,
	idempotencyKey?: string,
): Promise<{ id?: string }> {
	const name = formatSenderName(sender.fromName);
	const retry: RetryConfig | undefined =
		clientOptions.retry === false ? { enabled: false } : clientOptions.retry;
	const client = new AhaSendClient({
		apiKey: clientOptions.apiKey,
		accountId: clientOptions.accountId,
		fetch: toSdkFetch(clientOptions.fetch),
		...(retry ? { retry } : {}),
	});
	const from = name ? { email: sender.fromEmail, name } : { email: sender.fromEmail };
	const options = idempotencyKey === undefined ? undefined : { idempotencyKey };

	// With CC the message is one conversation, not a per-recipient fan-out.
	const result = message.cc?.length
		? await client.messages.sendConversation(
				{
					from,
					...bodyFields(message),
					to: toAddresses(message.to),
					cc: toAddresses(message.cc),
				} satisfies CreateConversationMessageRequest,
				options,
			)
		: await client.messages.send(
				{
					from,
					...bodyFields(message),
					recipients: toAddresses(message.to),
				} satisfies CreateMessageRequest,
				options,
			);

	// HTTP 202 is multi-status: a queued batch can still contain rejected recipients.
	for (const entry of result.data) {
		if (entry.status === "error") {
			throw new AhaSendDeliveryError(
				entry.recipient.email,
				entry.error ?? "AhaSend did not queue the message.",
			);
		}
	}

	const id = result.data[0]?.id;
	return id ? { id } : {};
}

function toSdkFetch(fetchFn: FetchFn): typeof fetch {
	return (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		return fetchFn(url, init);
	};
}
