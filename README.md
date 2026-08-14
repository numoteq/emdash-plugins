# EmDash plugins by NUMOTEQ

Official EmDash plugins by NUMOTEQ, maintained in a public pnpm monorepo and published under the `@numoteq/emdash-plugin-*` namespace.

## Plugins

| Package | Description |
| --- | --- |
| [`@numoteq/emdash-plugin-forward-email`](packages/forward-email) | Delivers transactional email through the Forward Email API. |

## Development

Requires Node.js 24 and pnpm 11.

```sh
pnpm install
pnpm hooks:install
pnpm check
```

Each plugin lives in `packages/<name>` and uses the official `emdash-plugin` toolchain for validation, development and builds. `pnpm check` runs formatting, linting, type checks, tests and production builds across the workspace.

## Versioning

Plugins are versioned independently with Changesets and remain pre-1.0 until their APIs are stable. Compatibility with EmDash is declared through each package's `peerDependencies`.

Every user-visible package change must include a changeset:

```sh
pnpm changeset
```

## Releases

Merging changesets into `main` creates a release PR. Merging that PR publishes the changed packages to npm using Trusted Publishing, creates GitHub tags and releases, and attaches the corresponding EmDash registry bundles.

Sandbox-compatible plugins are also published to the experimental EmDash Registry under the verified `numoteq.com` publisher identity.
