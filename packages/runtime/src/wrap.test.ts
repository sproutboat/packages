import { expect, test } from "bun:test";
import { IMPORT_META_URL, inlineImportMeta } from "./wrap";

const META = "const __sbImportMeta = ";

test("a body without import.meta is returned as it was", () => {
  const body = "const a = 1;\nconst b = 'import.meta.env';";
  expect(inlineImportMeta(body)).toBe(body);
});

test("every use of import.meta reads one object with url, main and resolve", () => {
  for (const use of [
    "import.meta.url",
    "import.meta.env",
    "import.meta.env?.MODE",
    "import.meta?.env",
    "{ ...import.meta.env }",
    "{ ...import.meta }",
    "import.meta.resolve('./x')",
    "import.meta['env']",
    "(import.meta)",
  ]) {
    const out = inlineImportMeta(`const v = ${use};`);
    expect(out.startsWith(META)).toBe(true);
    expect(out).toContain(`url: "${IMPORT_META_URL}"`);
    expect(out).not.toMatch(/\bimport\.meta\b/);
    expect(out.endsWith(`const v = ${use.replaceAll("import.meta", "__sbImportMeta")};`)).toBe(true);
  }
});

test("import.meta in a string, a comment or a member name is not touched", () => {
  const body = [
    "const a = 'import.meta.env';",
    'const b = "see import.meta.url";',
    "// import.meta.env here",
    "/* import.meta.env */",
    "const c = x.import.meta;",
    "const d = `import.meta.env`;",
    "const e = `<${'a'}> import.meta`;",
  ].join("\n");
  expect(inlineImportMeta(body)).toBe(body);
});

test("a template interpolation is code, so its import.meta is rewritten", () => {
  const out = inlineImportMeta("const s = `${import.meta.url} import.meta`;");
  expect(out).toContain("const s = `${__sbImportMeta.url} import.meta`;");
});

test("the object is declared once, ahead of the first use", () => {
  const out = inlineImportMeta("a(import.meta.url);\nb(import.meta.env);");
  expect(out.split(META).length).toBe(2);
  expect(out.indexOf(META)).toBe(0);
});

test("repeated calls behave the same (no regex state is kept)", () => {
  for (let i = 0; i < 3; i++) expect(inlineImportMeta("x(import.meta.env)").startsWith(META)).toBe(true);
});

// Compat sprint wave 1.
import {
  dynamicImports,
  inlineNodeDynamicImports,
  maskNonCode,
  neutraliseExports,
  neutraliseExportsDetailed,
  wrapNativeFetchHandler,
} from "./wrap";

test("maskNonCode keeps length and lines and blanks strings, templates, comments and regex bodies, not template expressions", () => {
  const src = "var a='x\\'y',b=`t${f(\"q\")+`n${1}`}u`,c=/a'b/g;// it's\n/* x\ny */var d=e/2/f;";
  const masked = maskNonCode(src);
  expect(masked.length).toBe(src.length);
  expect(masked.split("\n").length).toBe(src.split("\n").length);
  expect(masked).toBe(
    ["var a='    ',b=` ${f(\" \")+` ${1}`} `,c=/   /g;       ", "    ", "    var d=e/2/f;"].join("\n"),
  );
});

test("dynamicImports finds literal specifiers and whether a failure is caught", () => {
  const src = "try{await import(`node:sqlite`)}catch{}\nawait import('./a.js');\nimport(x);\n'import(\"y\")';";
  const sites = dynamicImports(src);
  expect(sites.map((s) => [s.specifier, s.handled])).toEqual([
    ["node:sqlite", true],
    ["./a.js", false],
    [null, false],
  ]);
});

test("a caught import of a node: module becomes a rejected promise; a string with the same text is left alone", () => {
  const src =
    "var m=\"import('node:fs')\";async function f(){try{return await import(/*x*/`node:sqlite`)}catch{return null}}";
  const out = inlineNodeDynamicImports(src);
  expect(out).toContain("\"import('node:fs')\"");
  expect(out).toContain('Promise.reject(new Error("node:sqlite is not available"))');
  expect(out).not.toContain("import(/*x*/");
});

// A Rolldown bundle ends in `export{Rn as C,__name as D,...,qK as default}` and has its own `var D`: the aliases used to become
// `const D = __name`, a SyntaxError that only the compile reported.
const ROLLDOWN = [
  "var D=1;var __name=(f)=>f;var Rn=class Chat{};var qK={fetch(){return new Response(String(D));}};",
  "export{Rn as C,__name as D,Rn as Chat,qK as default};",
].join("\n");

test("exported names that collide with the bundle's own names are not declared", () => {
  const out = neutraliseExports(ROLLDOWN)!;
  expect(out).not.toMatch(/const D\b/);
  expect(() => new Function(out)).not.toThrow();
  expect(neutraliseExportsDetailed(ROLLDOWN)!.aliases).toEqual({ C: "Rn", D: "__name", Chat: "Rn" });
});

test("a Durable Object class exported under another name is registered from the export table", () => {
  const bindings = {
    kv: [],
    secrets: [],
    d1: [],
    r2: [],
    queues: [],
    analytics: [],
    do: [{ binding: "CHAT", className: "Chat" }],
    services: [],
    crons: [],
    ratelimiters: [],
    assets: "",
  };
  const wrapped = wrapNativeFetchHandler(
    ROLLDOWN,
    "",
    {},
    bindings,
    8080,
    "2026-11-20",
    "app",
    undefined,
    "broker",
    undefined,
    "always",
  );
  expect(wrapped).toContain('__sbRegisterDO({ "Chat": __sbExports["Chat"] })');
  expect(() => new Function(wrapped.replace(/export default/, "return"))).not.toThrow();
});

test("a bundle with no renamed export compiles to the text it always did", () => {
  const out = neutraliseExports("class Counter{}\nexport{Counter,x as default};")!;
  expect(out).toBe("class Counter{}\nconst __sbHandlers = x;");
});
