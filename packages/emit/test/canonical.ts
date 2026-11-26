/**
 * Baked asset files are listed in the order the file system returns them, which differs between macOS and Linux. The CLI
 * has always written them that way, so a byte comparison across machines sorts that one list first and touches nothing else.
 */
const ASSETS_LINE = /^globalThis\.__sbAssets = (.*);$/m;

type Entry = { hash: string; size: number; type: string };
type BakedFiles = { manifest: { files: { [path: string]: Entry } }; files: { [path: string]: string } };

function sorted<T>(entries: { [path: string]: T }): { [path: string]: T } {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function canonical(text: string): string {
  const found = ASSETS_LINE.exec(text);
  if (found === null) return text;
  const baked: BakedFiles = JSON.parse(found[1]!);
  baked.manifest.files = sorted(baked.manifest.files);
  baked.files = sorted(baked.files);
  return text.replace(ASSETS_LINE, () => `globalThis.__sbAssets = ${JSON.stringify(baked)};`);
}
