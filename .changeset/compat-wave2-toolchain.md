---
"@sproutboat/toolchain": minor
---

Compat wave 2: the refusal of the compiler's intrinsics only refuses names in a builtin namespace (`__Porffor_*`, `__Array_*`, `__ecma262_*`), so `__zod_*`, `__rou3_*`, `__kysely_*`, `__COMPILER_RUNTIME`, `__SECRET_INTERNALS_...` and partyserver's `__unsafe_ensureInitialized` compile. Porffor patches P16 (`Date` parses the en-US `toLocaleString` shape, RFC 2822 and `toString` shapes, and applies a `GMT+0100` offset) and P17 (`arr["2"] = Object.create(null)` no longer throws, which made every Hono app with a `:param` route fail on its default router).
