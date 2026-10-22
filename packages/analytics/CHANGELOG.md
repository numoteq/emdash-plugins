# @numoteq/analytics

## 1.0.0

### Major Changes

- First release. Succeeds `@numoteq/sgtm-proxy`: the same first-party proxy now routes `/_sgtm` to sGTM and `/_op` to OpenPanel, forwards every header including `cf-*`, keeps the analytics cookie allowlist for sGTM, sends no cookies to OpenPanel, and gives OpenPanel the visitor's address in `openpanel-client-ip`.
- `@numoteq/analytics/server`: server-originated events through the Measurement Protocol client of our sGTM, enriched with `_ga`/`_ga_*`, `_fbp`/`_fbc`, the visitor's IP and user agent, SHA-256 hashed e-mail and phone, and consent sent as `gcs`. Sent once, never retried.
- `@numoteq/analytics/astro`: the `analytics()` integration, which serves the proxy and sets `locals.analytics.event()`.
- `@numoteq/analytics/c15t`: `c15tPreset()` and `gtmScripts()`, the container script that loads through the proxy with the shim in front.
- `@numoteq/analytics/client`: `loaderPath(host)` and the prefix constants, with no dependencies.
