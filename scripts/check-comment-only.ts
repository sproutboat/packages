// Checks a comment-only change (types are erased, so typecheck too): transpile each changed file at BASE and in the working tree
// (Bun.Transpiler, whitespace minified) and require byte-identical output.
//   bun scripts/check-comment-only.ts [base-ref=origin/main]
const base = process.argv[2] ?? "origin/main";
const loaders = { ts: "ts", tsx: "tsx", js: "js", mjs: "js", cjs: "js" } as const;

const sh = async (cmd: string[]) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const err = await new Response(proc.stderr).text();
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err.trim()}`);
  return { out, code };
};

// Every source-file status is accounted for: M is compared; A is listed (new files have no "before"); anything else fails.
const isSource = (f: string) => /\.(ts|tsx|js|mjs|cjs)$/u.test(f);
// -z: NUL-separated status/path pairs, so unusual pathnames are never quoted.
const fields = (await sh(["git", "diff", "--name-status", "--no-renames", "-z", base])).out.split("\0").filter(Boolean);
const entries: [string, string][] = [];
for (let i = 0; i + 1 < fields.length; i += 2) entries.push([fields[i]!, fields[i + 1]!]);
// Lint wiring that is not a comment change, listed so it is skipped here and reviewed by hand.
const WIRING = new Set(["oxlint.config.ts"]);
const sourceEntries = entries.filter(([, f]) => isSource(f) && !WIRING.has(f));
const changed = sourceEntries.filter(([s]) => s === "M").map(([, f]) => f);
const added = sourceEntries.filter(([s]) => s === "A").map(([, f]) => f);
const other = sourceEntries.filter(([s]) => s !== "M" && s !== "A");

let identical = 0;
const differing: string[] = [];
for (const file of changed) {
  // SAFETY: isSource() admitted this path, so its extension is one of the loaders keys.
  const loader = loaders[file.split(".").at(-1) as keyof typeof loaders];
  const transpiler = new Bun.Transpiler({ loader, minifyWhitespace: true });
  const before = await sh(["git", "show", `${base}:${file}`]);
  const [a, b] = [transpiler.transformSync(before.out), transpiler.transformSync(await Bun.file(file).text())];
  if (a === b) identical += 1;
  else differing.push(file);
}

console.log(
  `${changed.length} changed files: ${identical} transpile byte-identical to ${base}, ${differing.length} differ`,
);
for (const file of differing) console.log(`DIFFERS ${file}`);
for (const file of added) console.log(`ADDED (not compared) ${file}`);
for (const [s, file] of other) console.log(`UNSUPPORTED ${s} ${file}`);
process.exit(differing.length === 0 && other.length === 0 ? 0 : 1);
