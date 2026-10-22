# `@numoteq/analytics`

First-party analytics plumbing for sites on Cloudflare Workers and Astro. One package, four parts:

- **A proxy** to self-hosted server-side Google Tag Manager (sGTM) and OpenPanel, reachable from the page without ad-blocker-shaped URLs.
- **Server events** that send from an API route or an action through the Measurement Protocol client of our sGTM, with the visitor's identifiers, address and consent.
- **A c15t preset** with our consent categories and the container script that loads through the proxy.
- **Client paths** with no dependencies, for the page.

Built on [Effect](https://effect.website) v4. The core is configured at runtime, so one build serves production, previews and local development.

```sh
pnpm add @numoteq/analytics effect
# Astro sites also: astro (6 or 7) and @astrojs/cloudflare (13 or 14)
# c15t sites also: c15t @c15t/integrations
```

## Proxy

Ad blockers do not only block `www.googletagmanager.com`. EasyPrivacy and the AdGuard filters also match the URL shapes of a first-party proxy (`/gtm.js`, `?id=GTM-`, `/gtag/js?`, `?v=2&tid=G-`), so a plain reverse proxy on your own domain gets filtered anyway. The proxy avoids every such shape:

1. **Hashed paths.** The container loads from `/<hash>.js` and requests go to `/<hash>/<token>`. The hash derives from the site host, so the page and the Worker agree without configuration and no two sites share a path.
2. **Rewritten hosts.** In every script served from sGTM, `www.googletagmanager.com` becomes `<site>/_sgtm`, so the container loads its dependencies and sends its hits first-party.
3. **A shim** in front of the container encodes every data request under an internal prefix (see below) into a random-looking token. It hooks only what gtm.js, gtag.js and the OpenPanel SDK send with: `fetch`, `navigator.sendBeacon` and the `src` of script and image elements.
4. **The Worker** decodes tokens back into the path, strips the prefix and forwards them to the right upstream.

The shim never loads GTM's service worker iframe, so gtag sends every hit from the page, without a failed request.

| Prefix | Upstream option | What goes through |
| --- | --- | --- |
| `/_sgtm` | `sgtm` (`SGTM_UPSTREAM`) | Everything the container sends: `/gtm.js`, `/gtag/js`, `/g/collect`, … |
| `/_op` | `openpanel` (`OPENPANEL_UPSTREAM`) | The OpenPanel SDK script and its `/track` calls |

Each upstream is optional. A prefix without one answers `404` and the other prefixes keep working.

### Astro

```js
// astro.config.mjs
import { analytics } from "@numoteq/analytics/astro";

export default defineConfig({
	integrations: [analytics() /* , emdash(), c15t(), … */],
});
```

The integration adds middleware that runs before every other middleware and sets `locals.analytics` (see [Server events](#server-events)). It reads the Worker env at runtime:

```jsonc
// wrangler.jsonc
{
	"vars": { "GTM_ID": "GTM-XXXXXXX" },
	"vpc_services": [
		{ "binding": "SGTM_UPSTREAM", "service_id": "<id>", "remote": true },
		{ "binding": "OPENPANEL_UPSTREAM", "service_id": "<id>", "remote": true },
	],
}
```

- `GTM_ID` is the id of the **web** container whose `gtm.js` is loaded, not of the server container. sGTM knows its own container from its deployment.
- `SGTM_UPSTREAM` and `OPENPANEL_UPSTREAM` reach the services: a Workers VPC binding keeps them off the public internet; a service binding works too, and so does a plain origin such as `https://sgtm.example.com` (no path).
- `OPENPANEL_UPSTREAM` is the origin of the OpenPanel instance, the same one its SDK calls `apiUrl`.

Server events are on whenever `SGTM_UPSTREAM` is set; the middleware sets `locals.analytics` on every request. Other names:

```js
analytics({
	gtmIdVar: "WEB_GTM",
	sgtmBinding: "TAGGING",
	openpanelBinding: "OPENPANEL",
	serverEvents: { measurementIdVar: "GA4_ID", apiSecretVar: "MP_SECRET" },
});
```

### The loader

Load the container from the path for the current host, for example as the script of a consent manager:

```ts
import { loaderPath } from "@numoteq/analytics/client";

const src = loaderPath(location.host);
```

`@numoteq/analytics/client` has no dependencies. Do not add `integrity` to the script: the loader is assembled per site and has no stable hash.

### Other frameworks

`createProxyHandler(options)` returns `(request: Request) => Promise<Response | null>`; `null` means the request belongs to the site. Create it once per isolate:

```ts
import { createProxyHandler } from "@numoteq/analytics";

const handler = createProxyHandler({
	gtmId: env.GTM_ID,
	sgtm: env.SGTM_UPSTREAM,
	openpanel: env.OPENPANEL_UPSTREAM,
});
const response = (await handler(request)) ?? (await site(request));
```

### Behaviour

- **Loader:** fetched from sGTM with up to two retries and a 10 s timeout per attempt, then cached for 5 minutes in the Workers Cache API. Server-side preview requests (`X-Gtm-Server-Preview`) and responses that set cookies bypass the cache; a preview is answered `Cache-Control: no-store` with `Vary: X-Gtm-Server-Preview`, so no edge cache can hand it to a normal visitor.
- **Encoded requests:** forwarded once with a 5 s timeout. A hit is never retried, so it cannot count twice.
- **OpenPanel scripts:** `/_op/op1.js` and `/_op/op1-replay.js` are the only plain paths; anything else under `/_op` without a token answers `404`. They are not encoded because the SDK derives its replay helper by rewriting the `src` of `op1.js`, and a token carries no filename. They are cached for 5 minutes like the loader.
- **Headers:** everything the browser sent is forwarded, Cloudflare's `cf-*` included, so sGTM tags can read `cf-ipcountry` and friends. Cookies are narrowed to `_ga*`, `_gid`, `_gcl_*`, `_fbp`, `_fbc`, `FPID`, `FPLC`, `FPAU`, `FPGCL*`, `FPGSID` and `_gtmeec` for sGTM, and dropped entirely for OpenPanel. `x-forwarded-for`, `-host` and `-proto` describe the original request (the first from `cf-connecting-ip`, so only on Cloudflare), `authorization` never leaves the site, and OpenPanel gets the visitor's address in `openpanel-client-ip` with the browser's own user agent; address headers the browser could spoof are dropped.
- **Failures:** an upstream that is unreachable or too slow answers `502` and logs a warning, an unknown token or a path under no prefix `400`, a plain data request under a prefix `404`. The site's own error page never shows.
- **Turned off:** a part with missing or invalid options logs why once and turns itself off. The loader then answers an empty script with `Cache-Control: no-store`, so pages in previews and local development load quietly.
- **Logs:** JSON, only for the cases above. Workers Logs already record every request.

### GTM setup

Server container:

- **Container Settings → Server container URL:** `https://<site>/_sgtm`. It does not affect routing: the Worker forwards default paths, which sGTM accepts with or without the URL's path.
- **Clients:** a **Google Tag Manager: Web Container** client allowing your web container id, the **GA4** client, and a **Measurement Protocol** client (see [Server events](#server-events)). Check that `/gtm.js?id=<id>` on sGTM returns JavaScript.

Web container:

- The Google tag's `server_container_url` is the same `https://<site>/_sgtm`.
- Remove the standard GTM snippet; the page loads the container from the loader path.

OpenPanel, from a GTM Custom HTML tag or the page:

```html
<script src="https://<site>/_op/op1.js"></script>
<script>
	window.op("init", {
		clientId: "…",
		apiUrl: location.origin + "/_op", // no trailing slash: it would produce //track
		trackScreenViews: false,
		trackOutgoingLinks: false,
		trackAttributes: false, // events come from the GA4 hit through sGTM
	});
</script>
```

Leave `apiUrl` without a trailing slash: the SDK appends `/track` itself. With the proxy in front, `/_op/track` never appears in the browser's network traffic.

## Server events

Conversions the backend confirms (a lead stored, an order paid) are sent from the Worker, not the browser: they survive ad blockers and closed tabs. The event originates on the server and goes through sGTM, which routes it to GA4, Meta CAPI, Umami and OpenPanel like any other hit.

Server container: add a **Measurement Protocol** client and note its activation path. Give the sender that path (default `/mp/collect`). `measurement_id` and `api_secret` are optional pass-through fields; the container itself accepts any value, Google validates them only when a GA4 tag forwards the hit.

```ts
// an Astro action or API route, after the lead is stored
await locals.analytics.event("generate_lead", { form_id: "contact" });

// with the data Meta and Google want for a conversion
await locals.analytics.event(
	"generate_lead",
	{ form_id: "contact" },
	{ user: { email: "jan@example.com", phone: "+420 777 123 456" } },
);
```

`locals.analytics.event(name, params)`:

- sends in the background through `waitUntil`, so the response does not wait for it; the returned promise exists so a test can await it,
- reads consent at call time from `Astro.locals.c15t.snapshot.effectivePermissions`, because c15t's middleware runs after ours; without c15t everything counts as denied (`gcs=G100`) and you pass consent to `createServerEvents` yourself,
- never throws: a failed event is logged and dropped.

The sender adds what the browser would have sent, read from the request:

| Field | Source |
| --- | --- |
| `client_id` | `_ga`; a random UUID when the visitor has no cookie |
| `session_id` | `_ga_<id>`, both `GS1` and `GS2` formats |
| `ip_override`, `user_agent` | `cf-connecting-ip` (or `x-forwarded-for`), `user-agent` |
| `page_location` | the request's `Referer`, or a `pageLocation` you pass |
| `_fbp` / `_fbc` | the cookies; `_fbc` is rebuilt from `fbclid` when the cookie is not there yet |
| `user_data.sha256_email_address`, `sha256_phone_number` | `user: { email, phone }`, normalized and SHA-256 hashed in the Worker; plain values never leave it |

Consent goes both ways: the MP body's `consent` object for the record, and the `gcs` query parameter (`G1` + ad + analytics, the same signal gtag sends) because server tags read consent from `x-ga-gcs` and never from the body.

Without Effect, `createServerEvents(options)` returns `{ send(request, event, consent) }`. With Effect, use the `ServerEvents` service; `./server` exports it with `RequestContext`, `send`, `gcsOf` and the typed errors:

```ts
import { Effect } from "effect";
import { RequestContext, ServerEvents } from "@numoteq/analytics/server";

const program = Effect.gen(function* () {
	const events = yield* ServerEvents;
	yield* events.send(RequestContext.fromRequest(request, consent), {
		name: "generate_lead",
		params: { form_id: "contact" },
	});
});
```

An event is sent once. No vendor downstream deduplicates a repeated event, and a `fetch` that fails cannot be told apart from one that arrived and lost its answer, so there is no retry.

## c15t

```js
// astro.config.mjs
import { c15tPreset } from "@numoteq/analytics/c15t";
import { c15t } from "c15t/astro";

export default defineConfig({
	integrations: [
		c15t(
			c15tPreset({
				// anything a client needs: i18n, legalLinks, presentation, theme, policy rules
			}),
		),
	],
});
```

`c15tPreset()` sets our categories (`necessary`, `measurement`, `marketing`), offline mode and c15t's recommended policy pack. Every key you pass wins.

The container script belongs in the client entrypoint (`src/c15t.client.ts`), not in the serialized options, because it carries callbacks:

```ts
import { gtmScripts } from "@numoteq/analytics/c15t";
import type { C15tClientOptionsExtension } from "c15t/astro";

export default {
	scripts: gtmScripts(), // [] on the server, one script in the browser
} satisfies C15tClientOptionsExtension;
```

`gtmScripts()` is `googleTagManager()` from `@c15t/integrations` with the container URL pointed at our loader: gtm.js is served first-party and the shim is installed before it. It defaults to advanced consent mode (`loadMode: "always"`, category `necessary`), where GTM loads before the visitor chooses and sends cookieless pings to our sGTM. Pass `loadMode: "after-consent"` for basic mode. The container id never reaches the page; the Worker adds the real one from `GTM_ID`.

## Limits

- Requests the browser sends straight to Google or Meta domains (Ads conversion pings, `google.com/ccm`, the Meta pixel) are not proxied. Move those tags into the server container.
- The shim hooks `fetch` with a string or `URL`, `sendBeacon` and the `src` of script and image elements. It does not hook `XMLHttpRequest`, `setAttribute("src")` or `fetch(new Request(…))`; the OpenPanel SDK uses none of them. A script you add to the page must send through the hooked channels to be proxied.
- OpenPanel replay chunks are ordinary `/track` calls, so they are proxied, but the SDK sends the last one without `keepalive`: a visitor who closes the tab mid-flush loses it.
- The token is obfuscation, not encryption: the shim carries everything needed to decode it. It defeats static URL patterns and authenticates nothing.
- The proxy is transport only. It does not read, set or bypass consent; keep consent mode and your CMP as they are.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
```

`tests/fixtures/gtm-excerpt.js.txt` holds verbatim excerpts of a real `gtm.js` covering every place the container host appears.
