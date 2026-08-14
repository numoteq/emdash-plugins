# Changesets

Every user-visible package change needs a changeset:

```sh
pnpm changeset
```

Select the affected plugin and its SemVer bump. CI collects changesets into a release PR. Merging
that PR publishes the changed packages.

All plugin packages belong to one fixed version group. When adding a package, add its npm name to
`.changeset/config.json#fixed` so every published plugin stays on the same pre-1.0 version.
