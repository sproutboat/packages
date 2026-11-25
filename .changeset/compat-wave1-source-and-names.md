---
"@sproutboat/runtime": minor
"@sproutboat/config": minor
"@sproutboat/wire": patch
---

Compat sprint wave 1 (no new runtime generation: the prelude, the transports and the shared template's wrapped output are byte-identical).

The source check reads code, not text. Strings, templates, comments and regex bodies are blanked before the rules run, so `import('node:buffer')` in an SDK's error message (openai), a script written inside a template (react-router) and `require('fs')` in a doc string no longer fail `check`. A caught `import("node:sqlite")` or `import(`node:async_hooks`)` (better-auth, Effect) is a probe: it is accepted and compiled to a rejected promise. `"Buffer" in globalThis && Buffer.prototype...` guards a Node global like `typeof` does, from the guarded-globals date.

A bundle's renamed exports (`export{Rn as C,__name as D,Rn as Chat}`) are no longer declared as top-level names, which collided with the bundle's own `var D` and failed only at compile. They are read from an `__sbExports` table, and a Durable Object class exported under another name is registered from it.

Binding names, `vars` keys and secret names are any JavaScript identifier (`AuthDb`, `BetterAuthSecret_text`), as on Cloudflare, not only UPPER_SNAKE. The R2 transfer path of the broker accepts them too.
