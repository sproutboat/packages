/**
 * Regenerates test/fixtures/cli from a CLI checkout: `bun packages/emit/test/capture-cli-fixtures.ts <cli-dir>`.
 * It records the CLI's bundle, config and emit for each project. Rerun it only when the CLI's emit changes on purpose.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REGION_MARKER } from "../src/emit";
import { canonical } from "./canonical";

type Variant = { name: string; dir: string; date?: string; wrangler?: string; versionMetadata?: boolean };

const cliDir = resolve(process.argv[2] ?? "");
if (!existsSync(join(cliDir, "src/main.ts"))) throw new Error("usage: bun capture-cli-fixtures.ts <cli-dir>");
const out = resolve(import.meta.dir, "fixtures/cli");
const scratch = resolve(process.env.SB_EMIT_SCRATCH ?? join(import.meta.dir, "../.scratch"));

const projects = (): Variant[] => {
  const list: Variant[] = [];
  for (const name of readdirSync(join(cliDir, "examples"))) {
    const dir = join(cliDir, "examples", name);
    if (existsSync(join(dir, "sproutboat.jsonc"))) list.push({ name, dir });
    for (const nested of ["caller", "callee"])
      if (existsSync(join(dir, nested, "sproutboat.jsonc")))
        list.push({ name: `${name}-${nested}`, dir: join(dir, nested) });
  }
  list.push({ name: "quote-service", dir: join(cliDir, "dogfood/quote-service") });
  list.push({ name: "kitchen-sink", dir: join(cliDir, "dogfood/kitchen-sink") });
  // Dates from PROCESS_GLOBAL_DATE on bind `process` and `Buffer` for the handler's own code.
  for (const name of ["hello", "vars-secrets", "kv", "durable-object"])
    list.push({ name: `${name}-2026-11-23`, dir: join(cliDir, "examples", name), date: "2026-11-23" });
  list.push({
    name: "hello-version-metadata",
    dir: join(cliDir, "examples/hello"),
    date: "2026-11-23",
    versionMetadata: true,
  });
  // The Wrangler dialect: the same project through wrangler.jsonc, with a queue that is produced and not consumed.
  list.push({
    name: "wrangler-queue",
    dir: join(cliDir, "examples/queue"),
    wrangler: JSON.stringify({
      name: "wrangler-queue",
      main: "src/index.ts",
      compatibility_date: "2026-11-23",
      vars: { MODE: "wrangler" },
      queues: { producers: [{ binding: "JOBS", queue: "jobs" }], consumers: [{ queue: "other", max_batch_size: 5 }] },
    }),
  });
  return list;
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const regionOf = (full: string) => full.slice(full.indexOf(REGION_MARKER));

type CliRun = { ok: boolean; path?: string; text: string };

function cli(dir: string, args: string[]): CliRun {
  const run = Bun.spawnSync(["bun", join(cliDir, "src/main.ts"), "build", ...args, dir], {
    cwd: dir,
    env: { ...process.env, CI: "1", SPROUTBOAT_NO_UPDATE_CHECK: "1" },
  });
  const stdout = run.stdout.toString().trim().split("\n");
  const path = stdout.at(-1)?.trim();
  return {
    ok: run.exitCode === 0 && path !== undefined && existsSync(path),
    path,
    text: run.stderr.toString() + run.stdout.toString(),
  };
}

const projectConfig = await import(join(cliDir, "src/project-config.ts"));
const bundler = await import(join(cliDir, "src/bundle.ts"));
const standalone = await import(join(cliDir, "src/standalone-build.ts"));
const cloudBindings = await import(join(cliDir, "src/cloud-bindings.ts"));
// The fingerprint is of the prelude the CLI compiled with (its own runtime), not the one this repository holds: if the two
// differ, the whole-file tests say the fixtures are stale instead of failing a byte comparison.
const cliCompile = await import(join(cliDir, "src/compile.ts"));

rmSync(out, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const summary: Array<{ name: string; modes: string[]; bytes: number }> = [];

for (const variant of projects()) {
  const work = join(scratch, variant.name);
  cpSync(variant.dir, work, {
    recursive: true,
    filter: (source) => !source.includes(".sproutboat") && !source.includes("node_modules"),
  });
  const legacy = join(work, "sproutboat.jsonc");
  let configFile = existsSync(legacy) ? "sproutboat.jsonc" : "wrangler.jsonc";
  if (variant.wrangler !== undefined) {
    rmSync(legacy, { force: true });
    writeFileSync(join(work, "wrangler.jsonc"), variant.wrangler);
    configFile = "wrangler.jsonc";
  } else if (variant.date !== undefined) {
    const text = readFileSync(legacy, "utf8").replace(
      /"compatibility_date":\s*"[^"]+"/,
      `"compatibility_date": "${variant.date}"`,
    );
    writeFileSync(
      legacy,
      variant.versionMetadata
        ? text.replace('"name": "hello",', '"name": "hello",\n  "version_metadata": "VERSION",')
        : text,
    );
  }
  const loaded = projectConfig.loadProjectText(configFile, readFileSync(join(work, configFile), "utf8"), {
    directory: work,
  });
  if (!loaded.ok) throw new Error(`${variant.name}: ${loaded.errors.join("; ")}`);
  const config = loaded.value;
  const sourcePath = resolve(work, config.main);
  // Bun prints module paths relative to the working directory, so bundle from the project as the CLI does.
  process.chdir(work);
  const bundle = await bundler.bundleHandler(sourcePath, work, { compatibilityDate: config.compatibility_date });

  const dest = join(out, variant.name);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "bundle.js"), bundle.code);
  writeFileSync(join(dest, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  // The record side: what a Cloud deploy sends as spec.bindings, crons and queue_consumers.
  writeFileSync(
    join(dest, "record.json"),
    `${JSON.stringify(cloudBindings.mapCloudBindings(config, config.services?.length ?? 0), null, 2)}\n`,
  );
  if (config.assets !== undefined) {
    const assetDir = resolve(work, config.assets.directory);
    if (existsSync(assetDir)) cpSync(assetDir, join(dest, "assets"), { recursive: true });
  }

  const modes: { [mode: string]: { full: string; assetBake?: boolean } } = {};
  const input = { projectDir: work, config, sourcePath, source: bundle.code, target: "linux-x86_64" };
  // `build --emit-only`: the broker transport. The real command, in a process of its own.
  const broker = cli(work, ["--emit-only"]);
  if (broker.ok) modes.broker = { full: readFileSync(broker.path!, "utf8") };
  else throw new Error(`${variant.name}: build --emit-only failed:\n${broker.text}`);
  const stand = cli(work, ["--standalone", "--emit-only"]);
  if (stand.ok) modes.standalone = { full: readFileSync(stand.path!, "utf8") };
  // A Cloud deploy's emit (embedded, assets baked only when the worker reads them and they fit): the call `deploy` makes.
  const unit = await standalone.emitStandalone(input, { forCloud: true });
  modes.cloud = { full: readFileSync(unit.generatedPath, "utf8"), assetBake: unit.assetBake?.bake ?? false };

  const record: {
    [mode: string]: {
      sha256: string;
      canonicalSha256: string;
      bytes: number;
      preludeSha256: string;
      assetBake?: boolean;
    };
  } = {};
  for (const [mode, { full, assetBake }] of Object.entries(modes)) {
    writeFileSync(join(dest, `region.${mode}.js`), regionOf(full));
    record[mode] = {
      sha256: sha(full),
      canonicalSha256: sha(canonical(full)),
      bytes: full.length,
      preludeSha256: sha(await cliCompile.loadPrelude(mode === "broker" ? "broker" : "embedded")),
    };
    if (assetBake !== undefined) record[mode]!.assetBake = assetBake;
  }
  writeFileSync(join(dest, "modes.json"), `${JSON.stringify(record, null, 2)}\n`);
  summary.push({ name: variant.name, modes: Object.keys(modes), bytes: bundle.code.length });
  console.log(`${variant.name}: ${Object.keys(modes).join(", ")}, bundle ${bundle.code.length} bytes`);
}
rmSync(scratch, { recursive: true, force: true });
console.log(`${summary.length} fixtures in ${out}`);
