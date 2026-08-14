# Numoteq EmDash plugins

NUMOTEQ's EmDash plugins live in this public pnpm monorepo and are published under the
`@numoteq/emdash-plugin-*` namespace.

## Plugins

| Package                                                          | Description                      |
| ---------------------------------------------------------------- | -------------------------------- |
| [`@numoteq/emdash-plugin-forward-email`](packages/forward-email) | Forward Email transport provider |

## Development

Requires Node.js 24 and pnpm 11.

```sh
pnpm install
pnpm hooks:install
pnpm check
```

Each plugin is an independent workspace package. Add new plugins under `packages/<name>` and use
EmDash's `emdash-plugin build`; generic library bundlers such as tsup or tsdown are unnecessary for
sandboxed plugins.

All plugin packages use one fixed pre-1.0 version line. Add each new package to the Changesets
`fixed` group; `1.0.0` is reserved for compatibility with EmDash 1.0.

## Releases

1. Run `pnpm changeset` with each user-visible change and commit the generated Markdown file.
2. Merge changes into `main`. The release workflow creates or updates a `Version Packages` PR.
3. Merge that PR. The workflow publishes changed public packages to npm and creates tags/releases.

Releases use npm Trusted Publishing for `numoteq/emdash-plugins` and `release.yml`. GitHub Actions
authenticates to npm through short-lived OIDC credentials; no npm token is stored in the repository.
npm automatically attaches provenance generated from the public source repository.

Marketplace publishing is separate from npm publishing. Plugin manifests are pinned to the NUMOTEQ
Atmosphere account so releases can also be published to the EmDash registry.
