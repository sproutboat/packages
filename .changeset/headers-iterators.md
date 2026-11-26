---
"@sproutboat/toolchain": patch
---

`Headers.keys()`, `values()` and `entries()` return iterators, as in the Fetch spec. They returned plain Arrays, so `headers.keys().next()` threw a message-less TypeError. Effect's `HttpServerResponse.toWeb` does exactly that on a raw `101` response, so an Alchemy hibernating-WebSocket room answered 500. `for...of`, spread and `Object.fromEntries(headers)` work as before. This changes the shared prelude (the web classes), so it reaches production only with the next generation.
