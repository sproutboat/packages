---
"@sproutboat/toolchain": minor
---

Porffor alpha 26 (`8037e56`, npm `0.0.0-alpha.26`) replaces alpha 25 as the one supported Porffor, for standalone builds and the a21 line alike. The toolchain still supports one alpha at a time.

- The patch series is rebased onto alpha 26: 27 patches plus the generated `builtins_precompiled.js`. The megamorphic cache freeze (0017) was rebased onto upstream's `keyPtr` change. Two patches are dropped because upstream fixed them: the wide JSON string sizing (P9, `d648a51e`, #464) and the block function order (P15, `e12413a4`). `vendor/porffor-patched.tar.gz` and its manifest are the alpha 26 tree.
- The repros for #454 to #457 and #459 to #463, and P16 and P17, still fail on stock alpha 26 and pass on the patched tree.
- `SPROUTBOAT_PORFFOR_CHANNEL` accepts `alpha-26`; `alpha-25` joins 19 and 21 to 24 as "no longer supported". `PORFFOR_A25_*` constants are `PORFFOR_A26_*`.
- CI: the `native` jobs are named `native (alpha-26)` and `native (macOS arm64, alpha-26)` (the repository ruleset's required checks follow).
- Security: compiled app code can no longer import `node:ffi` (series patch 0025). A module that is not the entry, the runtime or the shared prelude fails the compile with `SB_INPUT_REFUSED`, for `import`, `import()`, `require()` and `process.getBuiltinModule`, the same way it refuses `Porffor.dlopen`. Alpha 26's `node:ffi` injected `Porffor.c` into the AST after the refusal had run, so one import reached libc. A standalone build's entry and `--sb-allow-intrinsics` keep it. `INTRINSIC_REFUSAL` is 2.
- The megamorphic cache freeze (0017) drops every entry whose key is not in static data before it freezes: alpha 26 matches an entry by key pointer, so a heap key on a reused address could hit a frozen entry.
