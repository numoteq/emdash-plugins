---
"@numoteq/emdash-plugin-sgtm": patch
---

Encode script URLs that the container assigns as `TrustedScriptURL` objects (for example the `gtm.js?id=…&gtg_health=1` health check), which previously left the browser unencoded. On pages that enforce Trusted Types the original value is kept.
