# @sproutboat/emit

Turns a plain Cloudflare Workers bundle (modules plus script-upload metadata) into the module Sproutboat compiles. Design 032.

One emitter for every host, with two entry points:

- `emitForCloud(input, options)`: an upload that reaches the Cloud. `options.validation` is required and every field of it is too (`now`, `maxCompatibilityDate`, `compatibilityFloor`, `assetStoreMinDate`), by type and at run time, so a caller cannot forget one.
- `emitLocal(input, options)`: the developer's own machine (the CLI's bundle and config, `--emit-only`, standalone builds). Every check is opt-in. Never call it for an upload that reaches the Cloud.

```ts
const result = await emitForCloud(
  { modules: [{ name: "index.js", type: "esm", content }], metadata },
  { name: "my-app", validation: { now: new Date(), maxCompatibilityDate, compatibilityFloor: WORKERS_COMPAT_FLOOR, assetStoreMinDate: ASSETS_STORE_MIN_DATE } },
);
result.region; // from `globalThis.__sbCompat = ` to the end: the part of a generated file the Cloud keeps
```

- `src/metadata.ts` and `schema/worker-metadata.schema.json`: the input contract. Field names are Cloudflare's; `triggers.crons` and `queue_consumers` are Sproutboat extensions. `validateMetadata` (and `validateMetadataForCloud`, which takes the required options) and `validateModules` decide every refusal. A field a binding type does not read is refused, not dropped.
- `src/errors.ts`: each refusal has a stable `reason` (`no-such-module`, `syntax-error`, `import-attribute-refused`, `flag-unsupported`, `limit-exceeded`, ...), so an API can hand it on. A syntax error names the module, line and column.
- `src/limits.ts`: the caps. Code 8 MiB, data modules 1 MiB together, sourcemaps 8 MiB together, everything 16 MiB, and 16 MiB for what the bundler is handed once text and data modules are string literals. All are checked before bundling.
- `src/flags.ts`: Node support, from Cloudflare's own rules (see "Flags").
- `src/bindings.ts`: Cloudflare bindings to the runtime's `Bindings` and the app record's `spec.bindings`, from one mapping.
- `src/source-check.ts`: what a module's source must pass before any bundler sees it (see "Macros").
- `src/virtual-bundle.ts`: bundles the uploaded modules without touching a disk. Every specifier is answered by the resolver; a Node built-in resolves to a shim or the bundler's polyfill when Node compatibility is on.
- `src/emit.ts`: validate, bundle, check capabilities, check Durable Object exports, wrap. With a `prelude` option the output is the whole file the CLI writes; without it, the region.
- `src/from-config.ts`: `fromConfig(config)` maps a project config to the same metadata, so the CLI's path and a Cloudflare client reach the emitter alike.
- `src/host.ts`: for a host that compiles locally: `loadPrelude` and `bakeAssets`.

## Macros

Bun runs a macro (`import x from "mod" with { type: "macro" }`) while it parses a module, in the emitting process, and its own resolver answers the macro import, so the plugin that answers every other specifier never sees it. `bun --no-macros` does not stop it through `Bun.build` (checked on Bun 1.4.4). Three layers keep one from running; any one is enough:

- **A lexer, then a parser.** es-module-lexer reads every import and export-from in time linear in the source, and any attribute clause is refused (`import-attribute-refused`). It does not know the legacy `assert { ... }` clause, so the text after each specifier is checked as well: only the end of the statement may follow it on its line. A module the lexer cannot read is refused (`syntax-error`): it fails closed.
- **A second reader that must agree.** Every code module must parse in Bun's own transpiler (`scanImports`, which runs no macro), and Bun's list of static imports must equal the lexer's. An import one saw and the other missed is refused (`source-unverifiable`).
- **Bun's own switch.** `Bun.build` runs with `macros: false`, so a macro import that got past both fails with "Macros are disabled". This option is not in Bun's typings; a test (`src/source-check.test.ts`) pins that Bun still honours it, so an upgrade that drops it fails the suite.

What Bun allows: import attributes of other kinds (`json`, `file`, `toml`, `sqlite`) do not run code in the bundler as macros do, but uploads accept none of them. The resolver answers every specifier, so no loader reads a disk. The emit also runs in its own no-network, read-only unit.

## Flags

Decided from the date the upload declared, never the floored one. `nodejs_compat` is on by default from 2026-08-04 (unless `no_nodejs_compat`), `process.env` is populated from text and JSON bindings, secrets and version metadata from 2025-04-01 with `nodejs_compat` (`nodejs_compat_populate_process_env` turns it on earlier, `nodejs_compat_do_not_populate_process_env` off), source: https://developers.cloudflare.com/workers/configuration/compatibility-flags/ (read 2026-11-26). The floor then moves only the runtime generation. `no_nodejs_compat_v2` alone selects Node compatibility v1 and is refused; with `no_nodejs_compat` it is how Cloudflare's docs turn the 2026-08-04 default off. Flags that contradict each other are refused.

## Parity notes

- Cron expressions are normalised by the CLI's rules: `?`, `#`, `L` and `W` forms, which Cloudflare accepts, are refused.
- `new_module_registry` and `legacy_module_registry` are accepted as no-ops: the registry differs in `import.meta.url`, `import.meta.main`, `import.meta.resolve()` and attribute validation, which uploads here do not use. The `import.meta.url` fixture is not in this package yet.
- `global_fetch_strictly_public` is accepted: without it Cloudflare fetches a zone's own origin, which Sproutboat does not do either way.
- `node:process` and the free `process` are one object with `env` and `nextTick`; the rest of Node's `process` (`hrtime`, `memoryUsage`, ...) is not provided.

## Bundler differences

For the same project, the emitter's bundle and the CLI's are byte-identical but for four things (`test/bundler-equivalence.test.ts` normalises exactly these):

- Bun prints `// <path>` before each module. The CLI's paths are files on disk; the emitter's carry the plugin namespace (`sb-module:lib/a.js`).
- Bun names the default export after the entry's directory when the file is `index`: `project_default` on disk, `index_default` for the virtual `index.js`.
- `__toESM(x, 1)`, Node's default-import rule for CommonJS, is printed when the nearest package.json on disk says `"type": "module"`. An upload has no package.json, so the emitter prints `__toESM(x)`. Only a CommonJS module that sets `__esModule` reads differently.
- The `process` stub: the CLI copies every string on `globalThis.env`; the emitter copies the text, JSON and secret bindings of the upload by name, as Cloudflare does. It is cut out of both and compared by behaviour.

## Tests

`test/equivalence.test.ts` holds the emitter to the CLI for CLI bundle plus config: for 23 CLI projects, `emitLocal(fromConfig(config))` of the CLI's own bundle writes the same bytes as `build --emit-only`, `build --standalone --emit-only` and a Cloud deploy's emit. It does not exercise the virtual bundler, because each CLI bundle is one module. A stale fixture (the prelude changed) fails the whole-file tests; regenerate with `bun packages/emit/test/capture-cli-fixtures.ts <cli-dir>`, only when the CLI's emit changes on purpose. `SB_EMIT_ALLOW_STALE_FIXTURES=1` skips them locally and never in CI.

`test/bundler-equivalence.test.ts` covers the bundler path that Alchemy and wrangler uploads take: three multi-file projects (relative imports, Node built-ins with free globals, CommonJS, builtin-shadowing names) are bundled by the CLI and by the emitter. The outputs are byte-identical once four listed differences are normalised, and both answer every request the same way when run. A golden pins the emitter's output per Bun version. Regenerate with `bun packages/emit/test/capture-bundler-fixtures.ts <cli-dir>`.

`test/alchemy.test.ts` emits a real Alchemy v2 bundle. `test/wrangler.test.ts` emits `wrangler deploy --dry-run` output. `src/hostile.test.ts` holds the size caps, the linear-time checks and the raw-C pass-through; `src/source-check.test.ts` holds the macro and syntax-error cases.
