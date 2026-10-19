# `@numoteq/emdash-plugin-ahasend`

Sandbox-compatible [AhaSend](https://ahasend.com) transport provider for EmDash, built on the official `@ahasend/sdk`.

## Install

```sh
pnpm add @numoteq/emdash-plugin-ahasend
```

Register the package in the site's sandboxed plugin configuration, activate it, then select **AhaSend** under **Settings > Email**. Open the plugin settings and enter:

- An AhaSend API key (`aha-sk-…`) scoped to the sender's domain.
- The AhaSend account ID (a UUID).
- The sender email. The sender domain must be verified in AhaSend.
- Optionally the sender name (defaults to the site title) and a Reply-To address.

The key is stored in the plugin-scoped KV store and is sent only to `https://api.ahasend.com`. The plugin requests only the fixed-host network and email transport registration capabilities. Recipients, CC and reply-to are passed through; a message's own reply-to wins over the configured one. EmDash email has no attachments.

Open and click tracking stay at the account default; the plugin enables nothing.

## Native use (Cloudflare Workers sites)

Sites that configure EmDash in code register the transport in `astro.config.mjs` instead; the credentials live in Worker secrets and nothing is set in the admin:

```js
import { ahaSend } from "@numoteq/emdash-plugin-ahasend/native";

emdash({
	plugins: [
		ahaSend({
			from: { email: "noreply@example.com" },
			replyTo: "info@example.com",
		}),
	],
});
```

```sh
wrangler secret put AHASEND_API_KEY
wrangler secret put AHASEND_ACCOUNT_ID
```

- `from.name` is optional and defaults to the site title (Settings > General).
- `replyTo` applies when a message sets none.
- `secret` and `accountIdSecret` rename the Worker secrets (`AHASEND_API_KEY` and `AHASEND_ACCOUNT_ID` by default).
- EmDash selects the provider automatically when it is the only one.

Site code (forms, Workflows) sends through the same sender with `sendEmail`, which also supports attachments. It throws on failure; an `AhaSendDeliveryError` names the recipient AhaSend rejected, and AhaSend API errors surface as the SDK's `AhaSendAPIError`.

```ts
import { sendEmail } from "@numoteq/emdash-plugin-ahasend/native";

await sendEmail(
	mailConfig,
	{
		to: "team@example.com",
		replyTo: visitorEmail,
		subject: "New enquiry",
		text,
		attachments: [{ filename: "offer.pdf", content: pdfBytes, contentType: "application/pdf" }],
	},
	{ idempotencyKey: `enquiry-${enquiryId}` },
);
```

Pass the same config object to `ahaSend()` and `sendEmail()`, for example from a shared `src/mail-config.ts`.

### E2E and local runs without a key

With the Worker variable `AHASEND_DRY_RUN` set to exactly `true`, nothing is sent: each message is logged as a warning (from, to, reply-to, subject) and reported as sent. Set it only in the E2E Wrangler config, never in production. Without it, a missing `AHASEND_API_KEY` or `AHASEND_ACCOUNT_ID` fails the send.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
```

`emdash-plugin build` creates the npm descriptor and sandbox bundle in `dist/`. The sandbox bundle inlines the SDK because EmDash plugins run as self-contained isolates.
