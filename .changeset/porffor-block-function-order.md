---
"@sproutboat/toolchain": patch
---

Porffor patch P15: a strict block moves each function declaration up to just before its first use in one pass, and a function moved up could mention a function declared later that the pass had already left alone. The callee then sat behind its caller, was not declared when the caller generated its nested closures, was never compiled, and the call threw a TypeError with no message (or aborted with "bad function index"). An Alchemy v2 Worker bundle has this shape, so every request of a compiled Alchemy Worker answered 500. The pass now repeats until the order settles, each function moving at most once. The fix changes the compiler's output for programs with that shape (they used to crash), so a new Cloud generation needs the porffor tier of requalification. No compatibility date: the old behaviour was a crash.
