import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PORFFOR_A21_PINS, type PorfforA21Channel } from "./pin";

/** Test helper: the patched tree unpacked into a fresh canonical directory (macOS's /var -> /private/var symlink would change unit names). The caller removes it. */
export async function extractPatchedTree(channel: PorfforA21Channel = "alpha-25"): Promise<string> {
  const pin = PORFFOR_A21_PINS[channel];
  const archive = resolve(import.meta.dir, "../../vendor", pin.vendoredArchive);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (digest !== pin.archiveSha256)
    throw new Error(`vendored archive sha256 ${digest} is not the manifest's ${pin.archiveSha256}`);
  const root = await realpath(await mkdtemp(join(tmpdir(), "sb-a21-")));
  const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", root, "--strip-components=1"], { stderr: "pipe" });
  if (tar.exitCode !== 0) throw new Error(new TextDecoder().decode(tar.stderr));
  return root;
}
