---
"@sproutboat/runtime": minor
---

Compat wave 2 (a new runtime generation): `Request.formData()` and `Response.formData()` await the body from compatibility date 2026-10-27 (urlencoded was empty and multipart threw, because `text()` returns a Promise from that date). `globalThis.__sbScrypt` exposes the native scrypt that `crypto.scryptVerify` already used, for the CLI's `node:crypto` shim. Both hold scrypt's table V to a memory budget (8 MiB, or an eighth of the worker's memory limit up to 32 MiB) by storing every k-th block and recomputing the rest, with the same output for every k: Better Auth's N 16384, r 16 (32 MiB plainly) takes about 8 MiB at 1.75 times the time and no longer gets a default 32 MiB worker OOM-killed. Parameters that would need k above 8 throw a RangeError that names `memory-mb` instead of allocating.
