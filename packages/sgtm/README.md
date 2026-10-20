# `@numoteq/emdash-plugin-sgtm`

First-party proxy from an Astro site on Cloudflare Workers to a self-hosted server-side Google Tag Manager (sGTM) container, built on [Effect](https://effect.website).

Ad blockers do not only block `www.googletagmanager.com`. EasyPrivacy and the AdGuard filters also match the URL shapes of a first-party proxy (`/gtm.js`, `?id=GTM-`, `/gtag/js?`, `?v=2&tid=G-`), so a plain reverse proxy on your own domain gets filtered anyway. This package avoids every such shape:

1. **Hashed paths.** The container loads from `${prefix}/<hash>.js` and requests go to `${prefix}/<hash>/<token>`. Both hashes derive from the GTM container id, so no two sites share a path and the id never appears in a browser URL.
2. **Rewritten hosts.** In every script served from sGTM, `www.googletagmanager.com` becomes `<site>${prefix}`, so the container loads its dependencies and sends its hits first-party.
3. **A shim** in front of the container encodes every request to `${prefix}` into a random-looking token. It hooks only what gtm.js and gtag.js send with: `fetch`, `navigator.sendBeacon` and the `src` of script and image elements.
4. **The middleware** decodes tokens back into the original path and forwards them. sGTM only ever sees normal requests (`/k7/gtm.js?id=GTM-…`, `/k7/g/collect?…`).

Everything else under the prefix is refused with a 404: a plain request would be blocked anyway. That includes GTM's service worker iframe, so gtag sends from the page instead.

## Usage

`effect` (v4) is a peer dependency.

```sh
pnpm add @numoteq/emdash-plugin-sgtm effect
```

Middleware, here as EmDash's `middleware.outer` (`emdash({ middleware: { outer: "./src/sgtm-middleware.ts" } })`). The function runs on the first request, where Worker bindings are available:

```ts
// src/sgtm-middleware.ts
import { sgtmMiddleware } from "@numoteq/emdash-plugin-sgtm";
import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";

export const onRequest = defineMiddleware(
	sgtmMiddleware(() => ({ gtmId: env.GTM_ID, upstream: env.SGTM ?? env.SGTM_URL })),
);
```

Loader in the layout, with the same options:

```astro
---
import { sgtmLoaderPath } from "@numoteq/emdash-plugin-sgtm";
import { env } from "cloudflare:workers";

const loader = sgtmLoaderPath({ gtmId: env.GTM_ID, upstream: env.SGTM ?? env.SGTM_URL });
---

{loader && <script is:inline src={loader} />}
```

Incomplete options turn the proxy off: `sgtmLoaderPath` returns `undefined` and the middleware logs once why (for example `Missing key at ["gtmId"]`) and passes every request on. Preview deploys without sGTM stay quiet that way.

Do not add `integrity` to the script tag: the loader is assembled per site and has no stable hash.

### Options

| Option | Meaning |
| --- | --- |
| `gtmId` | Web GTM container id. Only the Worker sees it; the browser paths are hashed from it. |
| `upstream` | sGTM as a Workers VPC or service binding, or a base URL such as `https://sgtm.example.com`. |
| `prefix` | Path prefix routed to sGTM, default `/k7`. Must equal the server container URL path. |
| `pathSalt` | Changes every derived path. Set it only to move away from a path a filter list picked up. |

A Workers VPC binding keeps sGTM off the public internet:

```jsonc
// wrangler.jsonc
{
	"vpc_services": [{ "binding": "SGTM", "service_id": "<id>", "remote": true }],
}
```

## Behaviour

- **Loader:** fetched from sGTM with up to two retries and a 10 s timeout per attempt, then cached for 5 minutes in the Workers Cache API. Server-side preview requests (`X-Gtm-Server-Preview`) and responses that set cookies bypass the cache.
- **Encoded requests:** forwarded once with a 5 s timeout. A hit is never retried, so it cannot count twice.
- **Failures:** sGTM unreachable or too slow answers `502`, an unknown token `400`, a plain request under the prefix `404`. The site's own error page never shows.
- **Headers:** Cloudflare's `cf-*` headers are dropped, cookies are narrowed to `_ga*`, `_gid`, `_gcl_*`, `_fbp`, `_fbc`, `FPID`, `FPLC`, `FPAU`, `FPGCL*`, `FPGSID` and `_gtmeec`, and `x-forwarded-for`, `-host` and `-proto` describe the original request. sGTM's `Set-Cookie` headers come back untouched.
- **Observability:** one `sgtm` log line per request with route (`loader`, `encoded`, `denied`), method, status and duration, inside an `sgtm.request` span.

## GTM setup

Server container:

- **Container Settings → Server container URL:** `https://<site>${prefix}`, e.g. `https://example.com/k7`.
- **Clients:** a **Google Tag Manager: Web Container** client allowing your web container id, and the **GA4** client. Check that `${prefix}/gtm.js?id=<id>` on sGTM returns JavaScript.

Web container:

- The Google tag's `server_container_url` is the same `https://<site>${prefix}`.
- Remove the standard GTM snippet; the layout loads the container from the loader path.

## Limits

- Requests the browser sends straight to Google or Meta domains (Ads conversion pings, `google.com/ccm`, the Meta pixel) are not proxied. Move those tags into the server container.
- The token is obfuscation, not encryption: the shim carries everything needed to decode it. It defeats static URL patterns and authenticates nothing.
- The proxy is transport only. It does not read, set or bypass consent; keep consent mode and your CMP as they are.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
```

`tests/fixtures/gtm-excerpt.js.txt` holds verbatim excerpts of a real `gtm.js` covering every place the container host appears.
