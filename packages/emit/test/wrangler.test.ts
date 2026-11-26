/** `wrangler deploy --dry-run --outdir` output (wrangler 4.161.0) uploaded as Cloudflare would carry it. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { emitFromBundle, WORKERS_COMPAT_FLOOR, type JsonObject, type ModuleInput } from "../src/index";

const root = join(import.meta.dir, "fixtures/wrangler");
const metadata = (name: string): JsonObject => JSON.parse(readFileSync(join(root, name, "metadata.json"), "utf8"));
const text = (name: string, file: string) => readFileSync(join(root, name, file), "utf8");

describe("wrangler dry-run output", () => {
  test("node-compat: node:buffer, node:crypto and node:events resolve, import.meta.url is a stable name", async () => {
    const modules: ModuleInput[] = [{ name: "index.js", type: "esm", content: text("node-compat", "index.js") }];
    // The API floors Cloudflare's date: before 2026-11-17 the source check rejects the Node polyfill a bundle inlines.
    const result = await emitFromBundle(
      { modules, metadata: metadata("node-compat") },
      { name: "node-compat", validation: { compatibilityFloor: WORKERS_COMPAT_FLOOR } },
    );
    expect(result.bundled).not.toMatch(/^import .*"node:/m);
    expect(result.region).toContain('"file:///bundle/index.js"');
    expect(result.region).toContain("__sbRegisterDO({ Counter: Counter })");
    expect(result.bindings.runtime.do).toEqual([{ binding: "COUNTER", className: "Counter" }]);
    // The flat step form of migrations that wrangler sends is accepted.
    expect(result.metadata.migrations?.steps).toEqual([{ new_sqlite_classes: ["Counter"] }]);
  });

  test("multi-module: a relative import, a text module and a data module", async () => {
    const modules: ModuleInput[] = [
      { name: "index.js", type: "esm", content: text("multi-module", "index.js") },
      { name: "lib/greet.js", type: "esm", content: text("multi-module", "lib/greet.js") },
      { name: "schema.sql", type: "text", content: text("multi-module", "schema.sql") },
      { name: "blob.bin", type: "data", content: new Uint8Array(readFileSync(join(root, "multi-module", "blob.bin"))) },
    ];
    const result = await emitFromBundle({ modules, metadata: metadata("multi-module") }, { name: "multi-module" });
    expect(result.bundled).toContain('"hi"');
    expect(result.bundled).toContain("CREATE TABLE t (a);");
    expect(result.bundled).toContain("new Uint8Array");
    expect(result.bundled).not.toMatch(/^import /m);
  });
});
