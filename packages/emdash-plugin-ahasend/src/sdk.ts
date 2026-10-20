// The EmDash sandbox bundle must be self-contained: `emdash-plugin build` externalizes
// package.json dependencies, so the official SDK is imported by path and bundled in there.
// The native build in tsdown.config.ts aliases this specifier back to the package name.
export * from "../node_modules/@ahasend/sdk/dist/index.js";
