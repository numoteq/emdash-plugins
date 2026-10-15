# @numoteq/emdash-plugin-sgtm

## 0.1.0

### Minor Changes

- f462076: Adds a first-party, ad-blocker-resistant proxy from an Astro site on Cloudflare Workers to self-hosted server-side Google Tag Manager. The container is served from a per-site HMAC-derived path with Google's host rewritten to the site's own prefix, a browser shim encodes every request to that prefix, and the middleware decodes it before forwarding plain requests to sGTM. Exports `createSgtmHandler`, `sgtmLoaderPath` and an Astro `onRequest` middleware for EmDash's `middleware.outer`.
