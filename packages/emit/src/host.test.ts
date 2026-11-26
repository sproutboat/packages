import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AssetManifest } from "@sproutboat/assets";
import { bakeAssets } from "./host";

describe("bakeAssets", () => {
  test("each manifest entry describes the bytes that are baked", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-emit-assets-"));
    try {
      mkdirSync(join(dir, "img"));
      writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
      writeFileSync(join(dir, "img/dot.bin"), Uint8Array.from([0, 1, 2, 250, 255]));
      const baked = bakeAssets(dir, {});
      // SAFETY: bakeAssets builds the manifest as an AssetManifest; BakedAssets only types it as opaque.
      const manifest = baked.manifest as AssetManifest;
      const entries = Object.entries(manifest.files);
      expect(entries.map(([path]) => path).sort()).toEqual(["/img/dot.bin", "/index.html"]);
      for (const [path, entry] of entries) {
        const bytes = Buffer.from(baked.files[path]!, "latin1");
        expect(entry.size).toBe(bytes.byteLength);
        expect(entry.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
