---
"@sproutboat/runtime": minor
---

`env.<ASSETS>.fetch()` can serve from a directory, so a worker is no longer limited to the assets that fit in its module (about 1 MiB of static data). Where the host sets `SB_ASSETS_DIR` (a per-deployment view of the Cloud asset store: `manifest.json` and `blobs/<sha256>`), a worker with no assets baked into its module reads them from there; baked assets are used first and behave exactly as before. Nothing changes for an app on a host that does not set the variable.

- **One resolver.** Redirects, an exact file, a trailing slash (`index.html`), an extensionless path (`.html`, then `/index.html`), `single-page-application` and `404-page`, and `_headers` rules are one function for baked and directory assets, so they cannot diverge.
- **Reads.** Inline C opens only `manifest.json` and `blobs/<hash>` of the view, where a hash is exactly 64 lowercase hex (checked in JS and in C), with `O_NOFOLLOW`, regular files only. A file of 1 MiB or less is read whole, as the same raw bytestring body baked assets have; a larger one is a stream of 256 KiB reads with a `content-length`, never whole in memory. A missing or unreadable file, or a malformed manifest, throws (a 500 for the app that does not catch it).
- **Manifest.** Parsed once per worker (4 MiB at most) and read again only when the file's inode, size or mtime changes, with one `stat` per `fetch`: an assets-only deploy swaps `manifest.json` and the running worker follows, with no restart.
- **Conditional requests, from compatibility date `2026-11-22`**, for baked and directory assets alike: `env.ASSETS.fetch(request)` (or `fetch(input, init)`, the headers of `init` winning, as in `new Request(input, init)`) answers `304` with the `etag` and the `_headers` rules' headers, and no body read, when `If-None-Match` (a comma list, `W/` tags, or `*`) names `"<sha256 of the file>"`. Earlier dates answer 200 as before. A comma inside a quoted tag belongs to the tag, and `*` counts only as the whole header value.
- **Names.** The request path is percent-decoded before the manifest lookup, for baked and directory assets (as Cloudflare does), so `/caf%C3%A9.txt` serves `/café.txt`. A malformed escape, or one that decodes to `/`, `\\`, a control character or a `.`/`..` segment, is looked up as written only: a 404, never an error.
- **Cache API.** `caches.default.put(request, response)` of a streamed asset response (over 1 MiB) now stores the body, not `{}`.

Generation impact: `transport-embedded.js` is inlined into the shared prelude every sproutd app compiles against, so this changes the prelude and the inline C (tier `prelude`, a runtime generation).
