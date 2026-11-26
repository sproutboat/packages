/** What a host that compiles locally adds around `emitLocal`: the prelude, and files baked into the module. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readAssetRules, walkAssets, type AssetManifest } from "@sproutboat/assets";
import { TRANSPORT_MARKER, preludePath, transportPath, type Transport } from "@sproutboat/runtime";
import type { BakedAssets } from "./emit";

/** Baking megabytes of assets makes the compile crawl; past this the error says what to do instead. */
export const MAX_BAKED_ASSET_BYTES = 8_000_000;

/** The prelude with its transport spliced in, read from the installed runtime. A packaged host embeds the same text. */
export function loadPrelude(transport: Transport): string {
  const core = readFileSync(preludePath, "utf8");
  if (!core.includes(TRANSPORT_MARKER)) throw new Error("the prelude is missing its transport marker");
  return core.replace(TRANSPORT_MARKER, readFileSync(transportPath(transport), "utf8"));
}

export type AssetSettings = { not_found_handling?: AssetManifest["notFound"]; run_worker_first?: boolean | string[] };

/** The files of an asset directory as a latin1 string each, with the manifest the edge and the shim read. */
export function bakeAssets(directory: string, settings: AssetSettings): BakedAssets {
  const manifest: AssetManifest = {
    notFound: settings.not_found_handling ?? "none",
    runSproutFirst: settings.run_worker_first ?? false,
    files: walkAssets(directory),
  };
  const rules = readAssetRules(directory);
  if (rules.headers.length) manifest.headers = rules.headers;
  if (rules.redirects.length) manifest.redirects = rules.redirects;
  const files: { [path: string]: string } = {};
  let total = 0;
  for (const key of Object.keys(manifest.files)) {
    const bytes = readFileSync(resolve(directory, `.${key}`));
    total += bytes.byteLength;
    if (total > MAX_BAKED_ASSET_BYTES)
      throw new Error(
        `assets are too large to compile into a standalone binary (over ${MAX_BAKED_ASSET_BYTES / 1_000_000} MB). Serve them from R2, or drop the assets binding and put a web server in front.`,
      );
    files[key] = bytes.toString("latin1");
  }
  return { manifest, files };
}
