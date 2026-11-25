---
"@sproutboat/assets": minor
---

`.assetsignore` at the asset root is honoured (gitignore style, as in Cloudflare Workers Static Assets): the files it names are neither hashed nor uploaded, so an Astro build's `_worker.js` no longer leaks as public static files.
