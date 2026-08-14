# Changesets

Every user-visible package change needs a changeset:

```sh
pnpm changeset
```

Select the affected plugin and its SemVer bump. CI collects changesets into a release PR. Merging that PR publishes the changed packages.

Plugin packages are versioned independently. Use each package's changeset to describe only its user-visible changes; EmDash compatibility belongs in `peerDependencies`.
