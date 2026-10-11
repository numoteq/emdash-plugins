---
"@numoteq/emdash-plugin-jetemail": minor
---

Native: `sendEmail(config, message)` sends from site code with the same sender as `jetEmail()`, including attachments. The sender name is optional and defaults to the EmDash site title. `JETEMAIL_DRY_RUN=true` only logs messages (for E2E runs without an API key). Failed requests throw `JetEmailError` with the HTTP status. The descriptor version comes from `package.json`. Sandboxed: optional Reply-To setting, and the sender name defaults to the site name.
