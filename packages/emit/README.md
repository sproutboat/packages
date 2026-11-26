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
- `src/limits.ts`: the caps, all in UTF-8 bytes. Code 8 MiB, data modules 1 MiB together, sourcemaps 8 MiB together, everything 16 MiB, and 16 MiB for what the bundler is handed once text and data modules are string literals (checked before bundling, and again on the bundled output). They are Sproutboat's own and deliberately tighter than Cloudflare's: see "Parity notes".
- `src/flags.ts`: Node support, from Cloudflare's own rules (see "Flags").
- `src/bindings.ts`: Cloudflare bindings to the runtime's `Bindings` and the app record's `spec.bindings`, from one mapping.
- `src/source-check.ts`: what a module's source must pass before any bundler sees it (see "Macros").
- `src/virtual-bundle.ts`: bundles the uploaded modules without touching a disk. Every specifier is answered by the resolver; a Node built-in resolves to a shim or the bundler's polyfill when Node compatibility is on.
- `src/emit.ts`: validate, bundle, check capabilities, check Durable Object exports, wrap. With a `prelude` option the output is the whole file the CLI writes; without it, the region.
- `src/from-config.ts`: `fromConfig(config)` maps a project config to the same metadata, so the CLI's path and a Cloudflare client reach the emitter alike.
- `src/host.ts`: for a host that compiles locally: `loadPrelude` and `bakeAssets`.

## Macros

Bun runs a macro (`import x from "mod" with { type: "macro" }`) while it parses a module, in the emitting process, and its own resolver answers the macro import, so the plugin that answers every other specifier never sees it. `bun --no-macros` does not stop it through `Bun.build` (checked on Bun 1.4.4). Three layers keep one from running. They are not three of the same kind, and which one holds alone is stated here:

- **A full parser.** Every code module is parsed by [meriyah](https://github.com/meriyah/meriyah) (pinned to an exact version): a module as an ES module, a `cjs` module as a CommonJS script. It follows the grammar, so it reads `/` as division or as a regex where the spec does, and it reports every import clause itself. Any attribute (`with { ... }`, on an import, an `export ... from` or a dynamic `import(x, options)`) is refused (`import-attribute-refused`); a module it cannot parse is refused (`syntax-error`), which includes the legacy `assert { ... }` clause (V8 dropped it, so it is a syntax error on Cloudflare too) and, in a `cjs` module, `import`, `export` and top-level `await`. A source nested deeper than the parser's stack allows is refused (`limit-exceeded`). The parser is a pure JavaScript one on purpose: it fails with an error on hostile nesting, where a native parser (oxc, checked at 0.160.0) crashes the process at about 15,000 levels, and it is linear where acorn (8.19.0) is quadratic in the number of `let` or `function` declarations in one scope (91 s for 100,000 `let`s).
- **A second reader that must agree.** Every code module must also parse in Bun's own transpiler (`scanImports`, which runs no macro), and Bun's list of static imports must equal the parser's, in order. An import one saw and the other missed is refused (`source-unverifiable`). This holds against a parser bug in either; it does not stop a macro on its own, because Bun cannot be asked where an import is.
- **Bun's own switch.** `Bun.build` runs with `macros: false`, so a macro import that got past both fails with "Macros are disabled". **This is the only layer that stops a macro no matter what the two readers say**: the other two are checks on the source, this one is on what Bun does. The config is built in one place (`bundlerConfig` in `src/virtual-bundle.ts`), and a test builds a macro through that very object and asserts that Bun refuses and no file is written, so dropping the option, or a Bun upgrade that stops honouring it, fails the suite. Without it, the same input emits and runs the macro (it was checked: 45 marker files appeared when the test run had the option removed).

An earlier version read the imports with a lexer (es-module-lexer) as the first reader. It guesses at `/` after `function(){}` and after `yield`, and Bun does not; with a regex that only Bun saw, both lists could be made to name the same import while Bun read a macro import (the reviewer's `x = function(){} / 1; import ... with { type: "macro" }; y = 1 / /;import "node:fs";/ / 1 / 1;`). The test in `src/source-check.test.ts` replays it and its `async function`, `function*` and `yield` variants through the emitter, and sweeps 39 prefixes in 3 shapes for both module kinds with Bun, built with the emitter's own config, as the judge: every program in which Bun reads a macro import (22 of 117) is refused, and none writes a marker. A lexer also refuses valid programs it misreads (`void function(){} / 1`), so it is not used.

What Bun allows: import attributes of other kinds (`json`, `file`, `toml`, `sqlite`) do not run code in the bundler as macros do, but uploads accept none of them. The resolver answers every specifier, so no loader reads a disk. The emit also runs in its own no-network, read-only unit.

Cost, measured on Bun 1.4.4 (an Apple-silicon Mac, peak resident size from `/usr/bin/time -l`), for 8 MiB of one module: the source checks alone take 0.4 to 0.9 s and 0.45 to 0.75 GB for ordinary shapes (statements, minified code, big arrays, division chains, about 500,000 declarations) and 1.8 s and 0.95 GB for the worst, a chain of `1+1+...`; the whole emit (checks, bundle, wrap) takes 1.2 to 2.7 s and 0.75 to 0.98 GB. The parser holds the syntax tree, which is most of that, so a builder capped near 1 GB is at its limit on the hostile shapes. Only each node's start offset is kept (`range` arrays cost 6 s and 1.2 GB on the chain).

## Flags

Decided from the date the upload declared, never the floored one. `nodejs_compat` is on by default from 2026-08-04 (unless `no_nodejs_compat`), `process.env` is populated from text and JSON bindings, secrets and version metadata from 2025-04-01 with `nodejs_compat` (`nodejs_compat_populate_process_env` turns it on earlier, `nodejs_compat_do_not_populate_process_env` off), source: https://developers.cloudflare.com/workers/configuration/compatibility-flags/ (read 2026-11-26). The floor then moves only the runtime generation. `no_nodejs_compat_v2` alone selects Node compatibility v1 and is refused; with `no_nodejs_compat` it is how Cloudflare's docs turn the 2026-08-04 default off. Flags that contradict each other are refused.

## Parity notes

- Cron expressions are normalised by the CLI's rules: `?`, `#`, `L` and `W` forms, which Cloudflare accepts, are refused.
- `new_module_registry` and `legacy_module_registry` are accepted as no-ops: the registry differs in `import.meta.url`, `import.meta.main`, `import.meta.resolve()` and attribute validation, which uploads here do not use. The `import.meta.url` fixture is not in this package yet.
- `global_fetch_strictly_public` is accepted: without it Cloudflare fetches a zone's own origin, which Sproutboat does not do either way.
- `node:process` and the free `process` are one object with `env` and `nextTick`; the rest of Node's `process` (`hrtime`, `memoryUsage`, ...) is not provided.
- `process.env` holds text and secret bindings as they are and a JSON binding as its JSON string, as Cloudflare does, and a value written to a bound name is stored as `String(value)`. Two differences remain: the JSON text is compact (the metadata is parsed, so the author's own spacing is not kept), and a name nothing binds is a plain property, which keeps the type it is given (Cloudflare coerces every write; that needs a `Proxy`, which the compiler does not take).
- A CommonJS module cannot use `import`, `export`, `import.meta` or top-level `await` (a syntax error here, as on Cloudflare). `await (x)` at the top level of a CommonJS module parses as a call to a function named `await`, as it does there; Bun may read it as top-level `await`.
- **Size caps.** Cloudflare's limits page (read 2026-11-26) gives a Worker 64 MiB uncompressed on both plans and no compressed limit. Sproutboat's caps are lower on purpose, because the code is compiled here and every byte reaches the compiler: 8 MiB of code, 1 MiB of data modules (one static-data region per module), 8 MiB of sourcemaps (stored, never compiled; the page does not say whether they count), 16 MiB for everything and 16 MiB once text and data are string literals. All are counted in UTF-8 bytes.

## Bundler differences

For the same project, the emitter's bundle and the CLI's are byte-identical but for three things (`test/bundler-equivalence.test.ts` normalises exactly these, and nothing that runs):

- Bun prints `// <path>` before each module. The CLI's paths are files on disk; the emitter's carry the plugin namespace (`sb-module:lib/a.mjs`, `sb-file:lib/b.cjs`). An ES module's path ends in `.mjs` (a `.js` is swapped for it): Bun reads that as Node's ES-module rule, which makes a default import of a CommonJS module its `module.exports`, even when the module sets `__esModule` (what tsc and Babel print), as on Cloudflare and in the CLI. The names in errors are the uploaded ones.
- Bun names the default export after the entry's directory when the file is `index`: `project_default` on disk, `index_default` for the virtual `index.js`.
- The `process` stub: the CLI copies every string on `globalThis.env`; the emitter copies the text, JSON and secret bindings of the upload by name, as Cloudflare does. It is cut out of both and compared by behaviour.

## Tests

`test/equivalence.test.ts` holds the emitter to the CLI for CLI bundle plus config: for 23 CLI projects, `emitLocal(fromConfig(config))` of the CLI's own bundle writes the same bytes as `build --emit-only`, `build --standalone --emit-only` and a Cloud deploy's emit. It does not exercise the virtual bundler, because each CLI bundle is one module. A stale fixture (the prelude changed) fails the whole-file tests; regenerate with `bun packages/emit/test/capture-cli-fixtures.ts <cli-dir>`, only when the CLI's emit changes on purpose. `SB_EMIT_ALLOW_STALE_FIXTURES=1` skips them locally and never in CI.

`test/bundler-equivalence.test.ts` covers the bundler path that Alchemy and wrangler uploads take: three multi-file projects (relative imports, Node built-ins with free globals, CommonJS, builtin-shadowing names) are bundled by the CLI and by the emitter. The outputs are byte-identical once three listed differences are normalised, and both answer every request the same way when run; a CommonJS module that sets `__esModule` is one of the fixtures, and a test pins that its default import is `module.exports`. A golden pins the emitter's output per Bun version. Regenerate with `bun packages/emit/test/capture-bundler-fixtures.ts <cli-dir>`.

`test/alchemy.test.ts` emits a real Alchemy v2 bundle. `test/wrangler.test.ts` emits `wrangler deploy --dry-run` output. `src/hostile.test.ts` holds the size caps, the linear-time checks and the raw-C pass-through; `src/source-check.test.ts` holds the macro and syntax-error cases.
