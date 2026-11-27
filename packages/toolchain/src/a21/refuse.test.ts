import { afterAll, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractPatchedTree } from "./patched-tree";
import { INTRINSIC_REFUSAL } from "./pin";

/**
 * Raw C and the compiler's intrinsics must not be reachable from compiled app code (sproutd's shape: entry, worker.js, shared prelude). Every way found to name
 * an intrinsic must fail with SB_INPUT_REFUSED. Not refused, and fine: a name built at run time (`globalThis["Porf" + "for"]`) reads a global that holds
 * no intrinsic, and `Porffor.c` needs a template tag resolvable at compile time; those must compile and put no hostile text into the C.
 */

const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

let treePromise: Promise<string> | undefined;
const tree = () => (treePromise ??= extractPatchedTree().then((root) => (temporary.push(root), root)));

const HOSTILE = "#error HOSTILE_C_REACHED";
const C = `\`\n${HOSTILE}\n\``;
const PRELUDE = "globalThis.__sbPreludeProbe = 1;\nPorffor.c`int sb_prelude_probe(void) { return 1; }`;\nexport {};\n";

let n = 0;
async function compile(worker: string, flags: string[] = [], extra: Record<string, string> = {}) {
  const root = await tree();
  const work = join(root, `w${n++}`);
  await mkdir(work);
  await writeFile(join(work, "shared-prelude.js"), PRELUDE);
  await writeFile(join(work, "anchor-ns.js"), "export {};\n");
  await writeFile(join(work, "worker.js"), `import "./shared-prelude.js";\n${worker}\n`);
  await writeFile(
    join(work, "app.js"),
    'import "./worker.js";\nexport default { fetch() { return new Response("x"); } };\n',
  );
  for (const [name, text] of Object.entries(extra)) await writeFile(join(work, name), text);
  const out = join(work, "out");
  const run = Bun.spawnSync(
    [
      "bun",
      join(root, "runtime/index.js"),
      "c",
      join(work, "app.js"),
      "-o",
      out,
      "--sb-entry-file=/sproutd/app.js",
      ...flags,
    ],
    { cwd: work, stdout: "pipe", stderr: "pipe" },
  );
  const log = new TextDecoder().decode(run.stderr) + new TextDecoder().decode(run.stdout);
  let reached = false;
  let preludeC = false;
  let ffiLinked = false;
  if (run.exitCode === 0) {
    for (const f of await readdir(out)) {
      if (f.includes("node_ffi")) ffiLinked = true;
      if (!f.endsWith(".c") && !f.endsWith(".h")) continue;
      const text = await readFile(join(out, f), "utf8");
      if (new RegExp(`^${HOSTILE}`, "m").test(text)) reached = true;
      if (text.includes("sb_prelude_probe")) preludeC = true;
    }
  }
  return { ok: run.exitCode === 0, log, reached, preludeC, ffiLinked };
}

const refused = {
  direct: `Porffor.c${C};`,
  "a function that is called": `function f() { Porffor.c${C} } f();`,
  "an arrow function": `const f = () => Porffor.c${C}; f();`,
  "a class static block": `class A { static { Porffor.c${C} } }`,
  "an alias of Porffor": `const P = Porffor; P.c${C};`,
  "an alias of the tag": `const c = Porffor.c; c${C};`,
  "a destructured tag": `const { c } = Porffor; c${C};`,
  "the comma form": `(0, Porffor.c)${C};`,
  "a computed key": `Porffor["c"]${C};`,
  "through globalThis": `globalThis.Porffor.c${C};`,
  "the dunder name": `__Porffor_c${C};`,
  "a unicode escape": `\\u0050orffor.c${C};`,
  "a code point escape": `\\u{50}orffor.c${C};`,
  "Porffor.IR": "Porffor.IR.i32_load(0, 0);",
  "Porffor.malloc": "Porffor.malloc(8);",
  "Porffor.link": "Porffor.link`sqlite3`;",
  "Porffor.dlopen": "Porffor.dlopen('x');",
  "an intrinsic called by name": "__Porffor_malloc(8);",
  "a builtin implementation by name": "__Array_prototype_join.call(1);",
  "an ecma262 internal": "__ecma262_ToString(1);",
  "a name with a dunder in the owner": "__Uint8Array___proto__;",
  "an accessor": "__RegExp_$1$get;",
  "an object key": "const o = { Porffor: 1 };",
  "a member name": "const o = {}; o.__Porffor_c;",
  "eval of a literal": `eval('Porffor.c' + '${"`"}${"\\n"}${HOSTILE}${"\\n"}${"`"}');`,
  "an indirect eval": `(0, eval)('Porffor.c${"`"}${"\\n"}${HOSTILE}${"\\n"}${"`"}');`,
  "new Function": `new Function('Porffor.c${"`"}${"\\n"}${HOSTILE}${"\\n"}${"`"}')();`,
  Function: `Function('Porffor.c${"`"}${"\\n"}${HOSTILE}${"\\n"}${"`"}')();`,
  "vm.runInThisContext": `import vm from 'node:vm'; vm.runInThisContext('Porffor.c${"`"}${"\\n"}${HOSTILE}${"\\n"}${"`"}');`,
  "vm.Script": `import vm from 'node:vm'; new vm.Script('Porffor.c${"`"}${"\\n"}${HOSTILE}${"\\n"}${"`"}').runInThisContext();`,
  "a data: module": `import 'data:text/javascript,Porffor.c${"`"}%0A%23error HOSTILE_C_REACHED%0A${"`"}';`,
  "a dynamic data: import": `import('data:text/javascript,Porffor.c${"`"}%0A%23error HOSTILE_C_REACHED%0A${"`"}');`,
  // node:ffi is raw native access (dlopen of any library, calls through function pointers) and its runtime injects Porffor.c after the check
  // above has run, so one import used to reach libc from compiled app code.
  "an import of node:ffi": `import { dlopen } from 'node:ffi'; dlopen(null, { getuid: { arguments: [], return: 'i32' } });`,
  "a namespace import of node:ffi": `import * as ffi from 'node:ffi'; ffi.dlopen(null, {});`,
  "a side-effect import of node:ffi": `import 'node:ffi';`,
  "a re-export from node:ffi": `export { dlopen } from 'node:ffi';`,
  "a dynamic import of node:ffi": `import('node:ffi');`,
  "require of node:ffi": `const { dlopen } = require('node:ffi'); dlopen(null, {});`,
  "process.getBuiltinModule of node:ffi": `process.getBuiltinModule('node:ffi').dlopen(null, {});`,
  "node:ffi from a data: module": `import 'data:text/javascript,import "node:ffi"';`,
  "node:ffi from a data: module named like the prelude": `import 'data:text/javascript,import "node:ffi";//shared-prelude.js';`,
  "a data: module named like the prelude": `import 'data:text/javascript,Porffor.c${"`"}%0A%23error HOSTILE_C_REACHED%0A${"`"};//shared-prelude.js';`,
} satisfies Record<string, string>;

for (const [name, worker] of Object.entries(refused)) {
  test(`refused: ${name}`, async () => {
    const r = await compile(worker);
    expect(r.ok, r.log).toBe(false);
    expect(r.log).toContain("SB_INPUT_REFUSED");
    expect(r.reached).toBe(false);
  });
}

test("refused: another module the app imports (not only worker.js)", async () => {
  const r = await compile('import "./extra.js";', [], { "extra.js": `Porffor.c${C};\n` });
  expect(r.ok, r.log).toBe(false);
  expect(r.log).toContain("SB_INPUT_REFUSED");
});

test("refused: node:ffi from another module the app imports, through a bundler's createRequire-style helper too", async () => {
  const FFI =
    "import { dlopen } from 'node:ffi'; export const uid = dlopen(null, { getuid: { arguments: [], return: 'i32' } });\n";
  const viaImport = await compile('import "./extra.js";', [], { "extra.js": FFI });
  expect(viaImport.ok, viaImport.log).toBe(false);
  expect(viaImport.log).toContain("SB_INPUT_REFUSED");
  expect(viaImport.log).toContain("node:ffi");
  const viaHelper = await compile('import "./extra.js";', [], {
    "extra.js": "const __require = require; __require('node:ffi');\n",
  });
  expect(viaHelper.ok, viaHelper.log).toBe(false);
  expect(viaHelper.log).toContain("SB_INPUT_REFUSED");
  // loading it for its export names (cjs-module-lexer follows `module.exports = require(...)`) would link it as well
  const reexport = await compile('import "./extra.cjs";', [], {
    "extra.cjs": "module.exports = require('node:ffi');\n",
  });
  expect(reexport.ok, reexport.log).toBe(false);
  expect(reexport.log).toContain("SB_INPUT_REFUSED");
  const star = await compile('import "./extra.mjs";', [], { "extra.mjs": "export * from 'node:ffi';\n" });
  expect(star.ok, star.log).toBe(false);
  expect(star.log).toContain("SB_INPUT_REFUSED");
});

test("node:ffi stays available where intrinsics are: --sb-allow-intrinsics and a standalone build's entry; bare 'ffi' is no builtin", async () => {
  const FFI = "import { dlopen } from 'node:ffi'; globalThis.sbFfi = typeof dlopen;\n";
  const allowed = await compile(FFI, ["--sb-allow-intrinsics"]);
  expect(allowed.ok, allowed.log).toBe(true);
  const root = await tree();
  const work = join(root, `w${n++}`);
  await mkdir(work);
  await writeFile(join(work, "app.js"), `${FFI}export default { fetch() { return new Response("x"); } };\n`);
  const run = Bun.spawnSync(
    ["bun", join(root, "runtime/index.js"), "c", join(work, "app.js"), "-o", join(work, "out")],
    { cwd: work, stdout: "pipe", stderr: "pipe" },
  );
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  // a plain `import 'ffi'` is not the builtin (it needs the node: prefix), so it is not refused as one: it is an unresolved package
  const bare = await compile("import 'ffi';");
  expect(bare.log).not.toContain("raw native access");
});

test("a specifier built at run time cannot link node:ffi: it compiles, and no ffi unit is in the output", async () => {
  for (const worker of [
    "const m = 'ffi'; globalThis.sbA = () => process.getBuiltinModule('node:' + m);",
    "const m = 'ffi'; globalThis.sbB = () => require('node:' + m);",
    "const m = 'ffi'; globalThis.sbC = () => import('node:' + m);",
    "import { createRequire } from 'node:module'; const r = createRequire('/x.js'); globalThis.sbD = () => r('node:ffi');",
  ]) {
    const r = await compile(worker);
    expect(r.ok, worker + "\n" + r.log).toBe(true);
    expect(r.ffiLinked, worker + "\n" + r.log).toBe(false);
  }
}, 120_000);

test("not refused, and harmless: names built at run time never reach the C", async () => {
  const names = [
    `globalThis["Porffor"].c${C};`,
    `globalThis["Porf" + "for"].c${C};`,
    `const k = "__Porffor_c"; globalThis[k]${C};`,
    `const s = "Porffor.c"; eval(s + "${"`"}${"\\n"}${HOSTILE}${"\\n"}${"`"}");`,
  ];
  for (const worker of names) {
    const r = await compile(worker);
    expect(r.reached, worker).toBe(false);
  }
}, 60_000);

test("an ordinary app compiles: strings, comments, flags named like dunders and every plain builtin pass", async () => {
  const r = await compile(
    [
      "const a = [1, 2, 3].join('-'); const m = Math.max(1, 2); const b = new Uint8Array(4);",
      "globalThis.__DEV__ = 1; const __esModule = true; const o = { __proto__: null };",
      // Rolldown's CommonJS interop helpers (every Alchemy bundle has them): a dunder with an underscore tail that is not a builtin's.
      "const __toESMCache_node = new WeakMap(), __toESMCache_esm = new WeakMap(); __toESMCache_node.set({}, 1); __toESMCache_esm.set({}, 2);",
      // Names libraries write that look like an intrinsic and are not one: no builtin has such a namespace.
      "const __COMPILER_RUNTIME = 1, __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = 2, __zod_x = 3, __rou3_y = 4, __kysely_z = 5, __unsafe_ensureInitialized = 6, __vite_import_meta_env__ = 7;",
      "if (__COMPILER_RUNTIME + __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED + __zod_x + __rou3_y + __kysely_z + __unsafe_ensureInitialized + __vite_import_meta_env__ !== 28) throw new Error('x');",
      "const d = 'Porffor.c and __Porffor_malloc in a string'; // Porffor.c in a comment",
      "/* __Porffor_malloc, __Array_prototype_join */",
      "const f = new Function('a', 'b', 'return a + b'); const s = eval('1 + 2');",
      "console.log(a, m, b, d, __DEV__, __esModule, o, f(1, 2), s, typeof Porffor_);",
    ].join("\n"),
  );
  expect(r.ok, r.log).toBe(true);
});

test("the platform's own code stays allowed: the shared prelude (a Porffor.c of its own) and the entry compile", async () => {
  const r = await compile("export const ok = 1;");
  expect(r.ok, r.log).toBe(true);
  expect(r.preludeC).toBe(true);
});

test("a standalone build is unchanged: its author's bundle is the entry, and the entry is trusted", async () => {
  const root = await tree();
  const work = join(root, `w${n++}`);
  await mkdir(work);
  await writeFile(
    join(work, "app.js"),
    `Porffor.c\`int sb_standalone_probe(void) { return 1; }\`;\nexport default { fetch() { return new Response("x"); } };\n`,
  );
  const run = Bun.spawnSync(
    ["bun", join(root, "runtime/index.js"), "c", join(work, "app.js"), "-o", join(work, "out")],
    { cwd: work, stdout: "pipe", stderr: "pipe" },
  );
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
});

test("--sb-allow-intrinsics switches the refusal off (the platform's own template compile), and only that flag does", async () => {
  const allowed = await compile(`Porffor.c${C};`, ["--sb-allow-intrinsics"]);
  expect(allowed.reached).toBe(true);
  for (const flag of ["--sb-allow-intrinsics=false", "--no-sb-allow-intrinsics"]) {
    const r = await compile(`Porffor.c${C};`, [flag]);
    expect(r.ok, `${flag}: ${r.log}`).toBe(false);
    expect(r.log).toContain("SB_INPUT_REFUSED");
  }
});

test("every intrinsic the tree defines is a name the refusal recognises (a new alpha cannot add one that slips by)", async () => {
  const root = await tree();
  const script = `
    import ${JSON.stringify(join(root, "compiler/prefs.js"))};
    const { BuiltinFuncs, BuiltinVars } = await import(${JSON.stringify(join(root, "compiler/builtins.js"))});
    const { isIntrinsicName, REFUSAL_LEVEL } = await import(${JSON.stringify(join(root, "compiler/refuse.js"))});
    const f = BuiltinFuncs();
    const names = [...new Set([...Object.keys(f), ...Object.keys(BuiltinVars({ builtinFuncs: f }))])].filter(x => x.startsWith("__"));
    console.log(JSON.stringify({ n: names.length, level: REFUSAL_LEVEL, missed: names.filter(x => !isIntrinsicName(x)), porffor: isIntrinsicName("Porffor") }));
  `;
  const run = Bun.spawnSync(["bun", "-e", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  const out = JSON.parse(new TextDecoder().decode(run.stdout).trim().split("\n").pop()!);
  expect(out.n).toBeGreaterThan(1000);
  expect(out.missed).toEqual([]);
  expect(out.porffor).toBe(true);
  expect(out.level).toBe(INTRINSIC_REFUSAL);
});

test("the shared prelude beside the entry stays trusted when the directory is reached through a symlink (macOS /var), and a look-alike elsewhere does not", async () => {
  const root = await tree();
  const real = join(root, `w${n++}`);
  await mkdir(real);
  await writeFile(join(real, "shared-prelude.js"), PRELUDE);
  await writeFile(join(real, "worker.js"), `import "./shared-prelude.js";\nexport const ok = 1;\n`);
  await writeFile(
    join(real, "app.js"),
    'import "./worker.js";\nexport default { fetch() { return new Response("x"); } };\n',
  );
  const link = join(root, `l${n++}`);
  await symlink(real, link);
  const run = Bun.spawnSync(
    [
      "bun",
      join(root, "runtime/index.js"),
      "c",
      join(link, "app.js"),
      "-o",
      join(real, "out"),
      "--sb-entry-file=/sproutd/app.js",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  // A shared-prelude.js in another directory (a subdirectory, imported by the app) is the app's, not the platform's.
  await mkdir(join(real, "sub"));
  await writeFile(join(real, "sub/shared-prelude.js"), PRELUDE);
  await writeFile(join(real, "worker.js"), `import "./shared-prelude.js";\nimport "./sub/shared-prelude.js";\n`);
  const bad = Bun.spawnSync(
    [
      "bun",
      join(root, "runtime/index.js"),
      "c",
      join(link, "app.js"),
      "-o",
      join(real, "out2"),
      "--sb-entry-file=/sproutd/app.js",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(bad.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(bad.stderr)).toContain("SB_INPUT_REFUSED");
});
