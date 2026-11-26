/**
 * The proof of one code path: for each project the CLI emitted, `emitFromBundle(fromConfig(config), the CLI's bundle)` writes the
 * same bytes. Fixtures come from capture-cli-fixtures.ts.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { SproutboatConfig } from "@sproutboat/config";
import { bakeAssets, deriveBindings, emitFromBundle, fromConfig, loadPrelude, type EmitOptions } from "../src/index";

type Mode = "broker" | "standalone" | "cloud";
const asMode = (name: string): Mode => {
  if (name === "broker" || name === "standalone" || name === "cloud") return name;
  throw new Error(`unknown mode ${name}`);
};
type ModeRecord = { sha256: string; bytes: number; preludeSha256: string; assetBake?: boolean };

const root = resolve(import.meta.dir, "fixtures/cli");
const names = readdirSync(root).sort();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const VERSION_LINE = /env\["([^"]+)"\] = \{"id":"([^"]+)","tag":"([^"]+)","timestamp":"([^"]+)"\};/;

function optionsFor(
  dir: string,
  config: SproutboatConfig,
  mode: Mode,
  record: ModeRecord,
  golden: string,
): EmitOptions {
  const options: EmitOptions = { name: config.name, transport: mode === "broker" ? "broker" : "embedded" };
  const version = VERSION_LINE.exec(golden);
  if (version !== null) options.versionMetadata = { id: version[2]!, tag: version[3]!, timestamp: version[4]! };
  const bakes = mode === "standalone" || (mode === "cloud" && record.assetBake === true);
  if (bakes && config.assets !== undefined)
    options.bakedAssets = bakeAssets(join(dir, "assets"), {
      not_found_handling: config.assets.not_found_handling,
      run_worker_first: config.assets.run_sprout_first,
    });
  return options;
}

describe("the CLI's emit, reproduced from its bundle and config", () => {
  test("there are fixtures", () => {
    expect(names.length).toBeGreaterThanOrEqual(20);
  });

  for (const name of names) {
    const dir = join(root, name);
    const config: SproutboatConfig = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    const bundle = readFileSync(join(dir, "bundle.js"), "utf8");
    const modes: { [mode: string]: ModeRecord } = JSON.parse(readFileSync(join(dir, "modes.json"), "utf8"));
    const modules = [{ name: "index.js", type: "esm" as const, content: bundle }];

    for (const [modeName, record] of Object.entries(modes)) {
      const mode = asMode(modeName);
      const golden = readFileSync(join(dir, `region.${mode}.js`), "utf8");

      test(`${name} (${mode}): the region is byte-identical`, async () => {
        const result = await emitFromBundle(
          { modules, metadata: fromConfig(config) },
          optionsFor(dir, config, mode, record, golden),
        );
        expect(result.region).toBe(golden);
        // Without a prelude the output is the region and nothing else.
        expect(result.source).toBe(result.region);
      });

      test(`${name} (${mode}): with the prelude the whole file is byte-identical`, async () => {
        const transport = mode === "broker" ? "broker" : "embedded";
        const prelude = loadPrelude(transport);
        // The recorded file was written with the prelude of that day; a runtime change makes this a recapture, not a failure.
        if (sha(prelude) !== record.preludeSha256) return;
        const options = { ...optionsFor(dir, config, mode, record, golden), prelude };
        const result = await emitFromBundle({ modules, metadata: fromConfig(config) }, options);
        expect(result.source.length).toBe(record.bytes);
        expect(sha(result.source)).toBe(record.sha256);
      });
    }
  }

  test("the fixtures include assets, version metadata, the Wrangler dialect and a date past PROCESS_GLOBAL_DATE", () => {
    expect(existsSync(join(root, "assets/assets"))).toBe(true);
    expect(names).toContain("hello-version-metadata");
    expect(names).toContain("wrangler-queue");
    expect(names).toContain("hello-2026-11-23");
  });
});

describe("the record side: spec.bindings, crons and queue consumers", () => {
  for (const name of names) {
    test(`${name}: deriveBindings(fromConfig(config)) is what a Cloud deploy sends today`, async () => {
      const dir = join(root, name);
      const config: SproutboatConfig = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      const expected = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
      const derived = deriveBindings(fromConfig(config));
      expect(derived.record.bindings).toEqual(expected.bindings);
      expect(derived.record.crons).toEqual(expected.crons);
      expect(derived.record.queue_consumers).toEqual(expected.queue_consumers);
      expect(derived.warnings).toEqual(expected.warnings);
    });
  }
});
