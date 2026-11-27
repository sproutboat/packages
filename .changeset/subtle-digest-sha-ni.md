---
"@sproutboat/runtime": patch
---

SHA-256 (`crypto.subtle.digest`, and HMAC-SHA-256, which shares the code) is about 5 times faster on x86-64 for large inputs: the runtime uses the CPU's SHA extensions when CPUID reports them and keeps the reference block everywhere else (older CPUs, arm64). Whole blocks are also hashed straight from the caller's buffer instead of through a copy. The result bytes do not change. Measured on a 4-vCPU EPYC host: the h2h `/cpu` route (20 digests of 64 KiB) went from 4.3 ms to 0.86 ms per request; small inputs were not measured. The prelude changes, so the next runtime generation carries it.
