---
"@sproutboat/runtime": patch
---

The broker transport (`sproutboat dev`, a deployed sprout) starts an app at compatibility date 2026-11-20 or later again. The prelude asks for the acknowledgement gate from that date, and only the embedded transport defined `__sbGateRaw`, so the app died at startup with `ReferenceError: __sbGateRaw is not defined`. The broker now defines it with the gate off.
