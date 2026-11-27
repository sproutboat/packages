# @sproutboat/emit

## 0.1.0

### Minor Changes

- 0ae44dc: New package: the emitter of design 032. `emitForCloud` (every safety option required) and `emitLocal` (the developer's machine; checks opt-in) turn modules plus Cloudflare script-upload metadata into the module Sproutboat compiles; for a CLI bundle and config the bytes are what the CLI writes today (`fromConfig` maps a project config to the same metadata). It holds the metadata schema and its validation with stable refusal reasons, the Cloudflare binding mapping to the runtime's bindings and the app record, the virtual-module bundler with the Node shims, the capability check, and the wrap without the prelude. Import attributes are refused with a lexer, a second reader and `macros: false`, so a Bun macro cannot run. Node support follows Cloudflare's flag rules from the declared compatibility date.

### Patch Changes

- Updated dependencies [0ae44dc]
  - @sproutboat/runtime@0.51.1
