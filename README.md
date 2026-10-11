# EmDash plugins by NUMOTEQ

Official EmDash plugins by NUMOTEQ, maintained in a public pnpm monorepo and published under the `@numoteq/emdash-plugin-*` namespace.

## Plugins

| Package | Description |
| --- | --- |
| [`@numoteq/emdash-plugin-forward-email`](packages/forward-email) | Delivers transactional email through the Forward Email API. |
| [`@numoteq/emdash-plugin-jetemail`](packages/jetemail) | Delivers transactional email through the JetEmail API. |

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

The repository lives on Forgejo and is mirrored to GitHub (`github.com/numoteq/emdash-plugins`) by a Forgejo push mirror.

- Forgejo (`.forgejo/workflows`) runs CI and, on `main`, opens the version PR from pending changesets. After that PR is merged it tags every new package version, creates the Forgejo release and attaches the EmDash registry bundle.
- GitHub (`.github/workflows/release.yml`) only publishes versions that are not on npm yet, through npm Trusted Publishing. No npm token exists.

A brand-new package must be published once by hand (`npm publish --access public` in its directory after `pnpm build`), because npm can only configure a trusted publisher for an existing package. Then add the trusted publisher on npmjs.com: GitHub Actions, repository `numoteq/emdash-plugins`, workflow `release.yml`.

Sandbox-compatible plugins are also published to the experimental EmDash Registry under the verified `numoteq.com` publisher identity.
