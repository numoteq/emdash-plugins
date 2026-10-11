# @numoteq/emdash-plugin-jetemail

## 0.4.0

### Minor Changes

- 7a5897c: Native: `sendEmail(config, message)` sends from site code with the same sender as `jetEmail()`, including attachments. The sender name is optional and defaults to the EmDash site title. `JETEMAIL_DRY_RUN=true` only logs messages (for E2E runs without an API key). Failed requests throw `JetEmailError` with the HTTP status. The descriptor version comes from `package.json`. Sandboxed: optional Reply-To setting, and the sender name defaults to the site name.

## 0.3.0

### Minor Changes

- 26eb101: The API client sends attachments (bytes or base64) through JetEmail.

## 0.2.0

### Minor Changes

- cd2777b: Adds a native variant for `astro.config.mjs` (`@numoteq/emdash-plugin-jetemail/native`) that reads the API key from a Worker secret, and exports the API client (`@numoteq/emdash-plugin-jetemail/client`) for site code such as contact forms.

## 0.1.0

### Minor Changes

- 47c69e9: Adds a JetEmail transport provider that delivers EmDash email through the JetEmail transactional API.
