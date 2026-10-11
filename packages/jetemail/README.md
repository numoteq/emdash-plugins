# `@numoteq/emdash-plugin-jetemail`

Sandbox-compatible [JetEmail](https://jetemail.com) transport provider for EmDash.

## Install

```sh
pnpm add @numoteq/emdash-plugin-jetemail
```

Register the package in the site's sandboxed plugin configuration, activate it, then select **JetEmail** under **Settings > Email**. Open the plugin settings and enter:

- A JetEmail transactional API key (`transactional_…`) allowed to send from the sender's domain.
- The sender email. The sender domain must be verified in JetEmail.
- Optionally the sender name (defaults to the site title) and a Reply-To address.

If the domain publishes JetEmail Domain Security (`_jm` TXT), add the API key's UUID to it, otherwise JetEmail rejects the message.

The key is stored in the plugin-scoped KV store and is sent only to `https://api.jetemail.com/email`. The plugin requests only the fixed-host network and email transport registration capabilities. Recipients, CC and reply-to are passed through; a message's own reply-to wins over the configured one. EmDash email has no attachments.

## Native use (Cloudflare Workers sites)

Sites that configure EmDash in code register the transport in `astro.config.mjs` instead; the API key lives in a Worker secret and nothing is set in the admin:

```js
import { jetEmail } from "@numoteq/emdash-plugin-jetemail/native";

emdash({
	plugins: [jetEmail({ from: { email: "noreply@example.com" }, replyTo: "info@example.com" })],
});
```

```sh
wrangler secret put JETEMAIL_API_KEY
```

- `from.name` is optional and defaults to the site title (Settings > General).
- `replyTo` applies when a message sets none.
- EmDash selects the provider automatically when it is the only one.

Site code (forms, Workflows) sends through the same sender with `sendEmail`, which also supports attachments. It throws on failure; a `JetEmailError` carries the HTTP status.

```ts
import { sendEmail } from "@numoteq/emdash-plugin-jetemail/native";

await sendEmail(mailConfig, {
	to: "team@example.com",
	replyTo: visitorEmail,
	subject: "New enquiry",
	text,
	attachments: [{ filename: "offer.pdf", content: pdfBytes }],
});
```

Pass the same config object to `jetEmail()` and `sendEmail()`, for example from a shared `src/mail-config.ts`.

### E2E and local runs without a key

With the Worker variable `JETEMAIL_DRY_RUN` set to exactly `true`, nothing is sent: each message is logged as a warning (from, to, reply-to, subject) and reported as sent. Set it only in the E2E Wrangler config, never in production. Without it, a missing `JETEMAIL_API_KEY` fails the send.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
```

`emdash-plugin build` creates the npm descriptor and sandbox bundle in `dist/`.
