---
"@numoteq/sgtm-proxy": patch
---

Forward requests to sGTM without the `/_sgtm` prefix. sGTM strips only the path of its configured server container URL, so prefixed requests failed with HTTP 400 unless that URL ended in `/_sgtm`. Default paths work with any server container URL, so switching a site no longer has to be coordinated with the server container.
