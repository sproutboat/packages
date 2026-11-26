---
"@sproutboat/emit": minor
---

New package: the emitter of design 032. `emitFromBundle` turns modules plus Cloudflare script-upload metadata into the module Sproutboat compiles, byte for byte what the CLI writes today for the same project (`fromConfig` maps a project config to the same metadata). It holds the metadata schema and its validation with stable refusal reasons, the Cloudflare binding mapping to the runtime's bindings and the app record, the virtual-module bundler with the Node shims, the capability check, and the wrap without the prelude.
