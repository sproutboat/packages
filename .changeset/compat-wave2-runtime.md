---
"@sproutboat/runtime": minor
---

Compat wave 2 (a new runtime generation): `Request.formData()` and `Response.formData()` await the body from compatibility date 2026-10-27 (urlencoded was empty and multipart threw, because `text()` returns a Promise from that date). A `Date` bound as a D1 parameter is its ISO string (an invalid Date is NULL), as D1 serialises it, instead of a `D1_TYPE_ERROR` (Better Auth sign-up). `globalThis.__sbScrypt` exposes the native scrypt that `crypto.scryptVerify` already used, for the CLI's `node:crypto` shim.
