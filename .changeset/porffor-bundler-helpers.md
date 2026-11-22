---
"@sproutboat/toolchain": patch
---

The compiler's refusal of its own intrinsics (series patch 0026) no longer refuses Rolldown's CommonJS interop helpers `__toESMCache_node` and `__toESMCache_esm`. They look like an intrinsic (`__Name_x`) and are not one; every Rolldown bundle that imports a CommonJS package carries them (an Alchemy Worker's does), so with the refusal as first written no such app compiled on a toolchain that had it. The first segment is compared whole, so `__toESMCache_x` passes and `__Array_x` still does not; the exhaustive test over every builtin dunder name is unchanged.
