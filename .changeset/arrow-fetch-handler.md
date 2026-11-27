---
"@sproutboat/runtime": patch
---

Accept `export default { fetch: (request, env, ctx) => … }` (and `async` arrows, function expressions, `{ fetch }` and `{ fetch: handler }`) as a Worker entry in `check`, `build` and `deploy`, as Cloudflare does. Only the method form (`fetch(request) {}`) was recognised, so the arrow form failed with "handler must default-export an object with fetch(request)…".
