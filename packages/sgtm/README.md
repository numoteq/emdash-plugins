# `@numoteq/emdash-plugin-sgtm`

First-party proxy from an Astro site on Cloudflare Workers to a self-hosted server-side Google Tag Manager (sGTM) container.

Ad blockers do not only block `www.googletagmanager.com`. EasyPrivacy and the AdGuard filters also block the generic URL shapes of a first-party proxy — `/gtm.js`, `.js?id=GTM-`, `/gtag/js?`, `?v=2&tid=G-`, `/ns.html?id=GTM-` — so a plain reverse proxy on your own domain gets filtered anyway.

This package beats those rules:

1. **A per-site random loader path.** The container is served from `${prefix}/<hmac>.js`, derived from a per-site secret with HMAC-SHA256. Nothing about the path is guessable or shared between sites.
2. **Rewritten hosts.** When the loader serves the container from sGTM, every `https://www.googletagmanager.com` becomes `https://<site>${prefix}` and every bare `www.googletagmanager.com` host string in the container blob becomes `<site>${prefix}`, so the container asks for its own dependencies first-party.
3. **A shim.** Prepended to the container, it re-encodes every browser request that goes to `${prefix}` into `${prefix}/<hmac>/<token>`, where the token is the salted, XOR-obfuscated `pathname + search` of the original request. It hooks `fetch`, `sendBeacon`, `XMLHttpRequest.open`, the `src` setters of script, image and iframe elements and `Element.prototype.setAttribute("src", …)`.
4. **A decoder in the middleware.** Tokens are decoded back into the original path before forwarding, and plain requests under `${prefix}` are forwarded unchanged (service worker files, `sw_iframe.html`, noscript fallbacks).

sGTM itself only ever sees completely normal requests: `/k7/gtm.js?id=GTM-…`, `/k7/g/collect`, `/k7/_/service_worker/…`. The GA4 client and the Web Container client do not notice the proxy.

## Install

```sh
pnpm add @numoteq/emdash-plugin-sgtm
```

## Usage

Create the middleware entrypoint (EmDash loads it through `middleware.outer`, Astro's outermost user middleware):

```ts
// src/middleware/sgtm.ts
import { sgtmMiddleware } from "@numoteq/emdash-plugin-sgtm";

interface Env {
	/** Workers VPC service binding, service binding, or a base URL string. */
	SGTM: { fetch(request: Request): Promise<Response> };
	SGTM_SECRET: string;
}

export const onRequest = sgtmMiddleware((env) => {
	const { SGTM, SGTM_SECRET } = env as Env;
	return { upstream: SGTM, gtmId: "GTM-NTQ37T97", secret: SGTM_SECRET, prefix: "/k7" };
});
```

```js
// astro.config.mjs
emdash({
	middleware: { outer: "./src/middleware/sgtm.ts" },
});
```

On plain Astro (without `middleware.outer`) the same export works from `src/middleware.ts`:

```ts
import { defineMiddleware } from "astro:middleware";
import { sgtmMiddleware } from "@numoteq/emdash-plugin-sgtm";

export const onRequest = defineMiddleware(sgtmMiddleware(/* options */));
```

Load the container from the layout with the derived path:

```astro
---
import { sgtmLoaderPath } from "@numoteq/emdash-plugin-sgtm";

const gtmLoader = await sgtmLoaderPath({ secret: Astro.locals.runtime.env.SGTM_SECRET });
---

<script is:inline src={gtmLoader}></script>
```

Do not add `integrity` to that tag: the response is assembled per request (host rewrite plus shim) and has no stable hash.

### Binding the sGTM upstream

A Workers VPC service binding keeps sGTM off the public internet:

```jsonc
// wrangler.jsonc
{
	"vpc_services": [
		{
			"binding": "SGTM",
			"service_id": "e6a0817c-79c5-40ca-9776-a1c019defe70",
			"remote": true,
		},
	],
}
```

```sh
wrangler secret put SGTM_SECRET
```

A VPC service binding routes by its own configuration, so the proxy sends binding requests to `http://sgtm.internal${path}` and Cloudflare fills in the real host and port. Use a base URL string (`upstream: "https://sgtm.example.com"`) instead when sGTM needs to see a particular `Host` — for example when it renders absolute URLs. Both upstreams receive the original method, the (filtered) cookies, `x-forwarded-for`, `x-forwarded-host` and `x-forwarded-proto`; Cloudflare's `cf-*` headers are dropped.

## GTM setup

Server container:

- **Admin → Container Settings → Server container URL**: `https://<site>${prefix}`, for example `https://example.com/k7`. This is the path this package routes to sGTM; sGTM strips it internally.
- **Clients**: add a **Google Tag Manager: Web Container** client with your web container id (`GTM-NTQ37T97`) as its _Allowed container ID_. The loader asks sGTM for `${prefix}/gtm.js?id=<container id>`, so confirm with `curl` that this URL returns the container JavaScript (the `Content-Type` is a JavaScript type). Adjust the client's _Tag serving path_ until it does — leave it empty when in doubt, so the script stays at the base of the server container URL.
- **Clients**: keep the **GA4** client, which receives the `/g/collect` hits that the web container sends to the server container.
- Publish the server container.

Web container:

- The Google tag's `server_container_url` configuration parameter is `https://<site>${prefix}` — the same base URL, without a trailing slash and without the tag serving path. With that value the browser sends measurement requests to `${prefix}/g/collect`, which the shim encodes and the proxy forwards.
- The web container is loaded from the derived loader path, not from `https://www.googletagmanager.com/gtm.js`, so remove the standard GTM snippet from the layout.

Check the result in the browser: the Sources panel must show the container loaded from your own domain, and the Network panel must show requests under `${prefix}/<encoded>/…`. On the sGTM side, the GA4 client and the Web Container client should log incoming requests whose paths are the plain decoded ones.

## Consent

The proxy is transport only. It does not read, set, alter or signal consent, and it must not be used to work around a consent banner: keep consent mode in the web container and your CMP exactly as it was. Two things to keep an eye on:

- Only cookies matching `cookieAllow` reach sGTM. If your CMP stores a first-party consent cookie that server-side tags read, add its name to `cookieAllow`.
- sGTM's own `Set-Cookie` responses are passed back untouched (all of them, including several in one response), so server-set state such as `FPID` keeps working first-party.

## Limits

- Only requests under `${prefix}` are proxied. Pixels and ad tags that the browser fires straight to Google and Meta domains (`pagead2.googlesyndication.com`, `www.facebook.com/tr/`, `connect.facebook.net`, `www.google-analytics.com`) are not proxied — move them into the server container if you need them first-party.
- The filter lists keep changing. If a rule starts targeting your own domain's path shape, rotate the secret: every derived path changes instantly. Changing `prefix` does the same and also needs the GTM server container URL and `server_container_url` updated.
- The token format is obfuscation, not encryption. The salt travels with every token and the shim contains the key material, so anyone can craft a valid token. It exists to defeat static URL patterns, not to authenticate anyone. The decoder still refuses anything that is not a canonical path under `${prefix}` (no `..`, no backslashes, no absolute URLs).
- The browser first loads `<prefix>/<hmac>.js` unencoded and the shim excludes that one path, so the file name stays stable for `preload`/`prefetch` hints and CSP.
- A request that cannot be rebuilt (an exotic `Request` the browser refuses to clone) is left untouched: the request still works, it just travels unencoded.
- This package does not generate page views. Events come from the container as before.

## API

```ts
import {
	createSgtmHandler,
	sgtmLoaderPath,
	sgtmMiddleware,
	type SgtmOptions,
} from "@numoteq/emdash-plugin-sgtm";
```

- `createSgtmHandler(options)` returns `(request, clientIp?) => Promise<Response | null>`. `null` means "not ours" and lets the site handle the request. Wire it into any worker of your own.
- `sgtmLoaderPath({ secret, prefix })` returns the loader path for the `<script src>`.
- `sgtmMiddleware(options | (env) => options)` is the Astro `onRequest` middleware; it calls `next()` for everything outside the prefix and reads the client IP from `cf-connecting-ip`. Pass a function to resolve the options per request from the Worker env.

`SgtmOptions`:

| Option | Meaning |
| --- | --- |
| `upstream` | A fetch-capable binding (Workers VPC or service binding) or a base URL string. |
| `gtmId` | Web GTM container id. Never appears in a browser URL. |
| `secret` | Per-site secret; all public paths are HMAC-SHA256 derivations of it. |
| `prefix` | Path prefix routed to sGTM, default `/k7`. Must equal the sGTM server container URL path. |
| `cookieAllow` | Cookie names forwarded to sGTM. Defaults to `_ga`, `_gid`, `_gcl_*`, `_fbp`, `_fbc`, `FPID`, `FPLC`, `FPAU`, `FPGCL*`, `FPGSID`, `_gtmeec`. |

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
```

`tests/fixtures/gtm-excerpt.js.txt` holds verbatim excerpts of a real `gtm.js` covering every place the container host appears; `tests/rewrite.test.ts` rewrites those bytes.

## First publish

This package is published to npm through GitHub Trusted Publishing, which cannot exist for a package that is not on npm yet. Publish the first version by hand once, as described in the repository README:

```sh
pnpm build
npm publish --access public
```

Then add the trusted publisher on npmjs.com: GitHub Actions, repository `numoteq/emdash-plugins`, workflow `release.yml`.
