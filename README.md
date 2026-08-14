# EmDash plugins by NUMOTEQ

EmDash plugins by NUMOTEQ live in this public pnpm monorepo and are published under the `@numoteq/emdash-plugin-*` namespace.

## Plugins

| Package | Description |
| --- | --- |
| [`@numoteq/emdash-plugin-forward-email`](packages/forward-email) | Forward Email transport provider |

## Development

Requires Node.js 24 and pnpm 11.

```sh
pnpm install
pnpm hooks:install
pnpm check
```

Each plugin is an independent workspace package. Add new plugins under `packages/<name>` and use EmDash's `emdash-plugin build`; generic library bundlers such as tsup or tsdown are unnecessary for sandboxed plugins.

Plugin packages are versioned independently and remain pre-1.0 until their APIs are stable. Compatibility with EmDash is declared through each package's `peerDependencies`.

## Releases

1. Run `pnpm changeset` with each user-visible change and commit the generated Markdown file.
2. Merge changes into `main`. The release workflow creates or updates a `Version Packages` PR.
3. Merge that PR. The workflow publishes changed public packages to npm and creates tags/releases.

Releases use npm Trusted Publishing for `numoteq/emdash-plugins` and `release.yml`. GitHub Actions authenticates to npm through short-lived OIDC credentials; no npm token is stored in the repository. npm automatically attaches provenance generated from the public source repository.

After publishing to npm, the release workflow bundles every published EmDash plugin and uploads its registry tarball to the corresponding GitHub Release. Bundle URLs follow `https://github.com/numoteq/emdash-plugins/releases/download/<package-tag>/<slug>-<version>.tar.gz`.

Marketplace publishing is separate from npm publishing. Plugin manifests are pinned to the NUMOTEQ Atmosphere account so releases can also be published to the EmDash registry.
