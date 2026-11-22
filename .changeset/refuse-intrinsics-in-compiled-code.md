---
"@sproutboat/toolchain": minor
---

toolchain: the patched Porffor refuses its own intrinsics in compiled app code (series patch 0026). A compile fails with `SB_INPUT_REFUSED` when a module that is not the entry, the runtime or the shared prelude (or a compile-time `eval`, `Function` or `vm` source) names `Porffor` or an intrinsic (`__Porffor_*`, `__<Builtin>_*`, `__ecma262_*`). The entry is trusted, so a standalone build is unchanged. `--sb-allow-intrinsics` switches it off for the platform's own template compile. `INTRINSIC_REFUSAL` (exported) is the feature level of the shipped tree.
