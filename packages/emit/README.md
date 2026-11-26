# @sproutboat/emit

Turns a plain Cloudflare Workers bundle (modules plus script-upload metadata) into the module Sproutboat compiles. Design 032.

One emitter for every host: the CLI, the Cloud builder and standalone builds all call `emitFromBundle`.

```ts
const result = await emitFromBundle(
  { modules: [{ name: "index.js", type: "esm", content }], metadata },
  { name: "my-app" },
);
result.region; // from `globalThis.__sbCompat = ` to the end: the part of a generated file the Cloud keeps
```

- `src/metadata.ts` and `schema/worker-metadata.schema.json`: the input contract. Field names are Cloudflare's; `triggers.crons` and `queue_consumers` are Sproutboat extensions. `validateMetadata` and `validateModules` decide every refusal.
- `src/errors.ts`: each refusal has a stable `reason` (`no-such-module`, `binding-type-unsupported`, `flag-unsupported`, `migration-unsupported`, ...), so an API can hand it on.
- `src/bindings.ts`: Cloudflare bindings to the runtime's `Bindings` and the app record's `spec.bindings`, from one mapping.
- `src/virtual-bundle.ts`: bundles the uploaded modules without touching a disk. Every specifier is answered by the resolver; a Node built-in resolves to a shim or the bundler's polyfill when `nodejs_compat` is on (the flag, or any date from 2026-08-04 unless `no_nodejs_compat`).
- `src/emit.ts`: validate, bundle, check capabilities, check Durable Object exports, wrap. With a `prelude` option the output is the whole file the CLI writes; without it, the region.
- `src/from-config.ts`: `fromConfig(config)` maps a project config to the same metadata, so the CLI's path and a Cloudflare client reach the emitter alike.
- `src/host.ts`: for a host that compiles locally: `loadPrelude` and `bakeAssets`.

## Tests

`test/equivalence.test.ts` holds the emitter to the CLI: for 23 CLI projects, `emitFromBundle(fromConfig(config))` of the CLI's own bundle writes the same bytes as `build --emit-only`, `build --standalone --emit-only` and a Cloud deploy's emit. Regenerate the fixtures from a CLI checkout with `bun packages/emit/test/capture-cli-fixtures.ts <cli-dir>`, only when the CLI's emit changes on purpose.

`test/alchemy.test.ts` emits a real Alchemy v2 bundle. `test/wrangler.test.ts` emits `wrangler deploy --dry-run` output.
