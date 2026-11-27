---
"@sproutboat/runtime": patch
---

SHA-256 (`crypto.subtle.digest`, HMAC-SHA-256, so also JWTs) is about 5 times faster on x86-64: the runtime uses the CPU's SHA extensions when CPUID reports them and keeps the reference block everywhere else (older CPUs, arm64). Whole blocks are also hashed straight from the caller's buffer instead of through a copy. The result bytes do not change. On a 4-vCPU EPYC host, the h2h `/cpu` route (20 digests of 64 KiB) went from 4.2 ms to 0.8 ms per request. The prelude changes, so the next runtime generation carries it.
