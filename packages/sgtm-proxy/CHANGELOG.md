# @numoteq/sgtm-proxy

## 1.0.1

### Patch Changes

- a1ed4e8: Forward requests to sGTM without the `/_sgtm` prefix. sGTM strips only the path of its configured server container URL, so prefixed requests failed with HTTP 400 unless that URL ended in `/_sgtm`. Default paths work with any server container URL, so switching a site no longer has to be coordinated with the server container.

## 1.0.0

Renamed from `@numoteq/emdash-plugin-sgtm` (last version 0.1.1), which is deprecated.

### Major Changes

- Runs as a framework-neutral `createSgtmHandler(options)` that turns a `Request` into a `Response`, or `null` for requests that are not its own. The Astro integration `sgtm()` from `@numoteq/sgtm-proxy/astro` registers it as middleware and reads `GTM_ID` and the `SGTM_UPSTREAM` binding from the Worker env at runtime.
- Paths derive from the site host instead of the container id and a secret: the loader is `/<hash>.js` and encoded requests go to `/<hash>/<token>`. The page computes the loader path with `sgtmLoaderPath(location.host)` from the dependency-free `@numoteq/sgtm-proxy/client`. `SGTM_PROXY_SECRET` and `pathSalt` are gone.
- The internal prefix is `/_sgtm` instead of `/k7`. Point the web container's `server_container_url` and the server container URL at `https://<site>/_sgtm`. The prefix never appears in the browser's network traffic.
- The shim encodes only the path after the prefix, with a random salt, and never loads the GTM service worker iframe, so gtag sends from the page without a failed request.
- Without `GTM_ID` or an upstream the loader answers an empty script and the reason is logged once, so one build serves production, previews and local development.
- Logs are JSON, the timeouts cover reading the body, and a client disconnect interrupts the request.
