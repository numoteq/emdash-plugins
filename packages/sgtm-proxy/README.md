# `@numoteq/sgtm-proxy`

First-party proxy from a site on Cloudflare Workers to a self-hosted server-side Google Tag Manager (sGTM) container, built on [Effect](https://effect.website). Renamed from `@numoteq/emdash-plugin-sgtm`.

Ad blockers do not only block `www.googletagmanager.com`. EasyPrivacy and the AdGuard filters also match the URL shapes of a first-party proxy (`/gtm.js`, `?id=GTM-`, `/gtag/js?`, `?v=2&tid=G-`), so a plain reverse proxy on your own domain gets filtered anyway. This package avoids every such shape:

1. **Hashed paths.** The container loads from `/<hash>.js` and requests go to `/<hash>/<token>`. The hash derives from the site host, so the page and the Worker agree without configuration and no two sites share a path.
2. **Rewritten hosts.** In every script served from sGTM, `www.googletagmanager.com` becomes `<site>/_sgtm`, so the container loads its dependencies and sends its hits first-party.
3. **A shim** in front of the container encodes every request to `/_sgtm` into a random-looking token. It hooks only what gtm.js and gtag.js send with: `fetch`, `navigator.sendBeacon` and the `src` of script and image elements. `/_sgtm` never appears in the browser's network traffic.
4. **The Worker** decodes tokens back into the original path and forwards them. sGTM only ever sees normal requests (`/_sgtm/gtm.js?id=GTM-…`, `/_sgtm/g/collect?…`).

The shim never loads GTM's service worker iframe, so gtag sends every hit from the page, without a failed request.

## Usage

`effect` (v4) is a peer dependency.

```sh
pnpm add @numoteq/sgtm-proxy effect
```

### Astro

```js
// astro.config.mjs
import { sgtm } from "@numoteq/sgtm-proxy/astro";

export default defineConfig({
	integrations: [sgtm() /* , emdash(), … */],
});
```

The integration adds middleware that runs before every other middleware. It reads two names from the Worker env at runtime, so one build serves every environment:

```jsonc
// wrangler.jsonc
{
	"vars": { "GTM_ID": "GTM-XXXXXXX" },
	"vpc_services": [{ "binding": "SGTM_UPSTREAM", "service_id": "<id>", "remote": true }],
}
```

- `GTM_ID` is the id of the **web** container whose `gtm.js` is served, not of the server container. sGTM knows its own container from its deployment.
- `SGTM_UPSTREAM` reaches sGTM: a Workers VPC binding keeps it off the public internet; a service binding works too.

Other names: `sgtm({ gtmIdVar: "…", upstreamBinding: "…" })`.

### The loader

Load the container from the path for the current host, for example as the script of a consent manager:

```ts
import { sgtmLoaderPath } from "@numoteq/sgtm-proxy/client";

const src = sgtmLoaderPath(location.host);
```

`@numoteq/sgtm-proxy/client` has no dependencies. Do not add `integrity` to the script: the loader is assembled per site and has no stable hash.

### Other frameworks

`createSgtmHandler(options)` returns `(request: Request) => Promise<Response | null>`; `null` means the request belongs to the site. Create it once per isolate:

```ts
import { createSgtmHandler } from "@numoteq/sgtm-proxy";

const handler = createSgtmHandler({ gtmId: env.GTM_ID, upstream: env.SGTM_UPSTREAM });
const response = (await handler(request)) ?? (await site(request));
```

`upstream` is a binding or a base URL such as `https://sgtm.example.com`.

### Turned off

Without a valid `GTM_ID` or upstream the proxy is off and logs why once (for example `sgtm disabled: Expected string at ["gtmId"]`). The loader then answers an empty script with `Cache-Control: no-store`, so pages in previews and local development load quietly.

## Behaviour

- **Loader:** fetched from sGTM with up to two retries and a 10 s timeout per attempt, then cached for 5 minutes in the Workers Cache API. Server-side preview requests (`X-Gtm-Server-Preview`) and responses that set cookies bypass the cache.
- **Encoded requests:** forwarded once with a 5 s timeout. A hit is never retried, so it cannot count twice.
- **Failures:** sGTM unreachable or too slow answers `502` and logs a warning, an unknown token `400`, a plain request under `/_sgtm` `404`. The site's own error page never shows.
- **Headers:** Cloudflare's `cf-*` headers are dropped, cookies are narrowed to `_ga*`, `_gid`, `_gcl_*`, `_fbp`, `_fbc`, `FPID`, `FPLC`, `FPAU`, `FPGCL*`, `FPGSID` and `_gtmeec`, and `x-forwarded-for`, `-host` and `-proto` describe the original request. sGTM's `Set-Cookie` headers come back untouched.
- **Logs:** JSON, only for the two cases above. Workers Logs already record every request.

## GTM setup

Server container:

- **Container Settings → Server container URL:** `https://<site>/_sgtm`.
- **Clients:** a **Google Tag Manager: Web Container** client allowing your web container id, and the **GA4** client. Check that `/_sgtm/gtm.js?id=<id>` on sGTM returns JavaScript.

Web container:

- The Google tag's `server_container_url` is the same `https://<site>/_sgtm`.
- Remove the standard GTM snippet; the page loads the container from the loader path.

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
