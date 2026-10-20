---
"@numoteq/emdash-plugin-sgtm": minor
---

Rewrite on Effect, with `effect` v4 as a peer dependency. Breaking:

- Paths derive from the GTM container id instead of a secret. `secret` is gone and `pathSalt` (optional) moves every path when needed. `SGTM_PROXY_SECRET` can be deleted from the sites.
- `sgtmLoaderPath(options)` is synchronous, takes the same options as the middleware and returns `undefined` when they are incomplete. `sgtmMiddleware` accepts the options or a function that runs on the first request; incomplete options log why and turn the proxy off. `createSgtmHandler` and `cookieAllow` are removed.
- Plain requests under the prefix get a 404 instead of being forwarded. This also disables GTM's service worker iframe, so gtag sends from the page.
- The shim only hooks `fetch`, `sendBeacon` and script and image `src`, the channels gtm.js and gtag.js actually use.

New: timeouts with a quiet `502` instead of a hanging request or the site's error page, up to two retries for the loader, a 5-minute Workers Cache API cache for the loader, and one log line plus a span per request.
