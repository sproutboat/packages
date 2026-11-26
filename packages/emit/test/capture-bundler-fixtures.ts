/**
 * Regenerates test/fixtures/bundler from a CLI checkout: `bun packages/emit/test/capture-bundler-fixtures.ts <cli-dir>`.
 * Rerun it when the CLI's bundler, the emitter's or Bun changes on purpose, and read the diff.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emitLocal } from "../src/index";
import { projectModules } from "./project-modules";

const cliDir = resolve(process.argv[2] ?? "");
if (!existsSync(join(cliDir, "src/bundle.ts"))) throw new Error("usage: bun capture-bundler-fixtures.ts <cli-dir>");
const root = resolve(import.meta.dir, "fixtures/bundler");
const bundler = await import(join(cliDir, "src/bundle.ts"));

for (const name of readdirSync(root).sort()) {
  const dir = join(root, name);
  const fixture = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
  const project = join(dir, "project");
  // Bun prints module paths relative to the working directory, so bundle from the project as the CLI does.
  process.chdir(project);
  const cli = await bundler.bundleHandler(join(project, "index.js"), project, {
    compatibilityDate: fixture.compatibility_date,
  });
  writeFileSync(join(dir, "cli-bundle.js"), cli.code);
  const emitted = await emitLocal(
    {
      modules: projectModules(project),
      metadata: {
        main_module: "index.js",
        compatibility_date: fixture.compatibility_date,
        compatibility_flags: fixture.compatibility_flags,
        bindings: fixture.bindings,
      },
    },
    { name: name },
  );
  writeFileSync(join(dir, "emit-bundled.js"), emitted.bundled);
  writeFileSync(join(dir, "bun-version.txt"), `${Bun.version}\n`);
  console.log(`${name}: cli ${cli.code.length} bytes, emit ${emitted.bundled.length} bytes`);
}
