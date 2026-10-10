# `@numoteq/emdash-plugin-jetemail`

Sandbox-compatible [JetEmail](https://jetemail.com) transport provider for EmDash.

## Install

```sh
pnpm add @numoteq/emdash-plugin-jetemail
```

Register the package in the site's sandboxed plugin configuration, activate it, then select **JetEmail** under **Settings > Email**. Open the plugin settings and enter:

- A JetEmail transactional API key (`transactional_…`) allowed to send from the sender's domain.
- The sender name and email. The sender domain must be verified in JetEmail.

If the domain publishes JetEmail Domain Security (`_jm` TXT), add the API key's UUID to it, otherwise JetEmail rejects the message.

The key is stored in the plugin-scoped KV store and is sent only to `https://api.jetemail.com/email`. The plugin requests only the fixed-host network and email transport registration capabilities. Recipients, CC and reply-to are passed through; EmDash email has no attachments.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
```

`emdash-plugin build` creates the npm descriptor and sandbox bundle in `dist/`.
