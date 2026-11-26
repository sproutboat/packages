/** A real Alchemy v2 Cloudflare bundle, with the metadata a Cloudflare script upload for it carries. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  ASSETS_STORE_MIN_DATE,
  emitForCloud,
  WORKERS_COMPAT_FLOOR,
  type JsonObject,
  type ModuleInput,
} from "../src/index";

const validation = {
  now: new Date("2026-11-26"),
  maxCompatibilityDate: "2026-11-26",
  compatibilityFloor: WORKERS_COMPAT_FLOOR,
  assetStoreMinDate: ASSETS_STORE_MIN_DATE,
};

const dir = join(import.meta.dir, "fixtures/alchemy-v2");
const metadata: JsonObject = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
const read = (name: string) => readFileSync(join(dir, name), "utf8");
const modules: ModuleInput[] = [
  { name: "Api.js", type: "esm", content: read("Api.js") },
  { name: "Stream-DDlk2XGl.js", type: "esm", content: read("Stream-DDlk2XGl.js") },
  { name: "Redacted-POB6WFL3.js", type: "esm", content: read("Redacted-POB6WFL3.js") },
  { name: "rolldown-runtime-DhBXf5t-.js", type: "esm", content: read("rolldown-runtime-DhBXf5t-.js") },
  { name: "Redacted-POB6WFL3.js.map", type: "sourcemap", content: read("Redacted-POB6WFL3.js.map") },
];

describe("an Alchemy v2 Cloudflare bundle", () => {
  test("emits with Cloudflare-shaped metadata: a DO binding and a new_sqlite_classes migration", async () => {
    const result = await emitForCloud({ modules, metadata }, { name: "alchemy-demo", validation });
    expect(result.metadata.compatibility_date).toBe(WORKERS_COMPAT_FLOOR);
    expect(result.metadata.migrations).toEqual({
      new_tag: "alchemy-demo-v1",
      steps: [{ new_sqlite_classes: ["COUNTER", "ROOMS", "RPCCOUNTER"] }],
    });
    expect(result.bindings.runtime.do).toEqual([
      { binding: "COUNTER", className: "COUNTER" },
      { binding: "ROOMS", className: "ROOMS" },
      { binding: "RPCCOUNTER", className: "RPCCOUNTER" },
    ]);
    expect(result.bindings.record.bindings.map((b) => `${b.kind}:${b.name}`)).toEqual([
      "do:COUNTER",
      "do:ROOMS",
      "do:RPCCOUNTER",
    ]);
    expect(result.warnings.join("\n")).toContain("ignored: observability, annotations");
    // The chunks became one module; the cloudflare:workers import is the wrapper's to turn into globals.
    expect([...result.bundled.matchAll(/^import .*?from "([^"]+)"/gm)].map((m) => m[1])).toEqual([
      "cloudflare:workers",
    ]);
    expect(result.region).not.toMatch(/^import /m);
    expect(result.region).toContain("__sbRegisterDO({ COUNTER: COUNTER, ROOMS: ROOMS, RPCCOUNTER: RPCCOUNTER })");
    expect(result.region).toContain('const env = {"ALCHEMY_PHASE":"runtime"');
    expect(result.region.startsWith("globalThis.__sbCompat = ")).toBe(true);
  });

  test("the same bundle is refused by name when a piece of the upload is wrong", async () => {
    const wrong = async (patch: JsonObject, reason: string) => {
      const refused = emitForCloud({ modules, metadata: { ...metadata, ...patch } }, { name: "x", validation });
      await expect(refused).rejects.toThrow(reason);
    };
    await wrong({ compatibility_flags: ["new_module_registry", "legacy_module_registry"] }, "legacy_module_registry");
    await wrong(
      { migrations: { new_tag: "v2", steps: [{ deleted_classes: ["COUNTER"] }] } },
      "deleted_classes is not supported",
    );
    await wrong({ main_module: "Missing.js" }, "main_module");
  });
});
