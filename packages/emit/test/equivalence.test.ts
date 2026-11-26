/**
 * The proof of one code path: for each project the CLI emitted, `emitLocal(fromConfig(config), the CLI's bundle)` writes the
 * same bytes. Fixtures come from capture-cli-fixtures.ts.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { SproutboatConfig } from "@sproutboat/config";
import { canonical } from "./canonical";
import { bakeAssets, deriveBindings, emitLocal, fromConfig, loadPrelude, type EmitOptions } from "../src/index";

type Mode = "broker" | "standalone" | "cloud";
const asMode = (name: string): Mode => {
  if (name === "broker" || name === "standalone" || name === "cloud") return name;
  throw new Error(`unknown mode ${name}`);
};
type ModeRecord = {
  sha256: string;
  canonicalSha256: string;
  bytes: number;
  preludeSha256: string;
  assetBake?: boolean;
};

const root = resolve(import.meta.dir, "fixtures/cli");
const names = readdirSync(root).sort();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const allowStale = process.env.SB_EMIT_ALLOW_STALE_FIXTURES === "1" && process.env.CI === undefined;
const staleMessage = (name: string, mode: string) =>
  `fixtures stale: the prelude changed since ${name} (${mode}) was captured. Run \`bun packages/emit/test/capture-cli-fixtures.ts <cli-dir>\` with a CLI checkout that has the new runtime, review the diff, and commit it. While you work, SB_EMIT_ALLOW_STALE_FIXTURES=1 skips these tests locally (never in CI).`;

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
        const result = await emitLocal(
          { modules, metadata: fromConfig(config) },
          optionsFor(dir, config, mode, record, golden),
        );
        expect(canonical(result.region)).toBe(canonical(golden));
        // Without a prelude the output is the region and nothing else.
        expect(result.source).toBe(result.region);
      });

      const transport = mode === "broker" ? "broker" : "embedded";
      const stale = sha(loadPrelude(transport)) !== record.preludeSha256;
      // Only a developer who is mid-change may skip a stale fixture, and the skip shows in the run. CI always fails.
      const run = stale && allowStale ? test.skip : test;
      run(`${name} (${mode}): with the prelude the whole file is byte-identical`, async () => {
        const prelude = loadPrelude(transport);
        if (stale) throw new Error(staleMessage(name, mode));
        const options = { ...optionsFor(dir, config, mode, record, golden), prelude };
        const result = await emitLocal({ modules, metadata: fromConfig(config) }, options);
        expect(result.source.length).toBe(record.bytes);
        expect(sha(canonical(result.source))).toBe(record.canonicalSha256);
        // On the machine the CLI ran on, the plain bytes match as well.
        if (process.platform === "darwin") expect(sha(result.source)).toBe(record.sha256);
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

describe("canonical", () => {
  test("sorts the baked file lists and nothing else", () => {
    const entry = { hash: "h", size: 1, type: "text/plain" };
    const line = (order: string[]) =>
      `a\nglobalThis.__sbAssets = ${JSON.stringify({ manifest: { notFound: "none", files: Object.fromEntries(order.map((k) => [k, entry])) }, files: Object.fromEntries(order.map((k) => [k, "x"])) })};\nb\n`;
    expect(canonical(line(["/b", "/a"]))).toBe(canonical(line(["/a", "/b"])));
    expect(canonical("no assets here")).toBe("no assets here");
  });
});
