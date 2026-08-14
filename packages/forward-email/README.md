# `@numoteq/emdash-plugin-forward-email`

Sandbox-compatible [Forward Email](https://forwardemail.net) transport provider for EmDash.

## Install

```sh
pnpm add @numoteq/emdash-plugin-forward-email
```

Register the package in the site's sandboxed plugin configuration, activate it, then select
**Forward Email** under **Settings > Email**. Open the plugin settings and enter:

- A Forward Email API token.
- A sender address belonging to a configured Forward Email domain.

The token is stored in the plugin-scoped KV store and is sent only to
`https://api.forwardemail.net/v1/emails`. The plugin requests only the fixed-host network and email
transport registration capabilities.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
```

`emdash-plugin build` creates the npm descriptor and sandbox bundle in `dist/`.
