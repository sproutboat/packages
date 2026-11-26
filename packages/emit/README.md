# @sproutboat/emit

Turns a plain Cloudflare Workers bundle (modules plus script-upload metadata) into the module Sproutboat compiles. Design 032.

This package is the one emitter: the CLI, the Cloud builder and standalone builds all call it.

- `src/metadata.ts` and `schema/worker-metadata.schema.json`: the input contract. Field names are Cloudflare's. `triggers.crons` and `queue_consumers` are Sproutboat extensions.
- Refusals carry a stable `reason` (`src/errors.ts`) so an API can pass it on.
