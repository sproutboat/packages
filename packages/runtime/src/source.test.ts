import { expect, test } from "bun:test";
import { GUARDED_GLOBALS_DATE, validateHttpSyncSource } from "./source";

const wrap = (body: string) => `var d={fetch(){${body}return new Response("ok");}};export{d as default};`;

const GUARDED = [
  // a bundled `buffer` polyfill declares its own Buffer
  `function Buffer(a){return a;}Buffer.isBuffer=function(b){return b instanceof Buffer;};`,
  // upstash: a polyfill behind a test for another global
  `if(typeof atob==="undefined"){global.atob=(b)=>Buffer.from(b,"base64").toString("utf8");}`,
  // supabase-js: a Node branch behind a feature test
  `function b64(d){if(typeof Buffer!=="undefined")return Buffer.from(d).toString("base64");return btoa(d);}`,
  `if(typeof Deno!=="undefined"&&typeof Deno.unrefTimer==="function"){Deno.unrefTimer(t);}`,
  // @neondatabase/serverless: the feature test names the member itself
  `var B=typeof globalThis.Buffer=="function"&&typeof globalThis.Buffer.allocUnsafe=="function"?globalThis.Buffer:null;`,
  // an error message that mentions an API
  `throw new Error("Buffer.write(string, encoding, offset[, length]) is no longer supported");`,
  `// process.env is read here in Node\n`,
];

test("before the guarded-globals date every Node global match fails, as it always did", () => {
  for (const body of GUARDED) {
    expect(validateHttpSyncSource(wrap(body), "2026-10-22").ok).toBe(false);
    expect(validateHttpSyncSource(wrap(body)).ok).toBe(false);
  }
});

test("from the guarded-globals date a feature-tested use, a string and a comment pass", () => {
  for (const body of GUARDED) expect(validateHttpSyncSource(wrap(body), GUARDED_GLOBALS_DATE).ok).toBe(true);
});

test("from the guarded-globals date an unguarded use still fails", () => {
  for (const body of [
    `var x=process.env.TOKEN;`,
    `var b=Buffer.from("a");`,
    `var b=new Buffer(4);`,
    `var x=Bun.file("a");`,
    // a feature test far above does not guard this one
    `if(typeof Deno!=="undefined"){}${" ".repeat(700)}var x=process.env.TOKEN;`,
  ]) {
    const result = validateHttpSyncSource(wrap(body), GUARDED_GLOBALS_DATE);
    expect(result.ok).toBe(false);
  }
});

// Effect ships exactly this: a guarded lookup that never runs here, since there is no `process`.
const EFFECT_LOOKUP = `var R=globalThis.process?.getBuiltinModule?.("node:async_hooks")?.AsyncResource;`;

test("the text node: inside a string is not an import, at any date", () => {
  for (const body of [
    EFFECT_LOOKUP,
    `var m="see https://nodejs.org/api/node:fs.html";var t='node:path';`,
    "var m=`node:crypto is unavailable`;",
  ]) {
    for (const date of [undefined, "2026-10-22", GUARDED_GLOBALS_DATE, "2026-11-17"])
      expect(validateHttpSyncSource(wrap(body), date)).toEqual({ ok: true });
  }
});

test("a real node: import or require is still refused, at any date", () => {
  for (const module of [
    `import fs from "node:fs";export default{fetch(){return new Response("x");}};`,
    `import"node:fs";export default{fetch(){return new Response("x");}};`,
    `import{a}from'node:path';export default{fetch(){return new Response("x");}};`,
    `export*from"node:fs";export default{fetch(){return new Response("x");}};`,
    wrap(`var f=require("node:fs");`),
    wrap("var f=require(`node:fs`);"),
    wrap(`var f=import("node:fs");`),
  ]) {
    for (const date of [undefined, "2026-10-22", GUARDED_GLOBALS_DATE, "2026-11-17"])
      expect(validateHttpSyncSource(module, date).ok).toBe(false);
  }
});

// Compat sprint wave 1: the check reads tokens, not text (sweep gap 3, Alchemy better-auth gap 5).
const DATES = [undefined, "2026-10-22", GUARDED_GLOBALS_DATE, "2026-11-17", "2026-11-25"];

test("import( and node: inside a string, a template or a comment are not imports (openai SDK message)", () => {
  for (const body of [
    // openai/internal/uploads.mjs: a hint in an error message
    "throw new Error(\"Pass a File, or set `globalThis.File` to `import('node:buffer').File`.\");",
    'var hint=`load it with import("node:buffer") first`;',
    "// import('./x.js') is what the dev server does\n",
    "/* import('node:fs') */",
    // react-router: client script text carrying a dynamic import
    'var s=`<script type="module">import(${JSON.stringify(u)})</script>`;',
    "var t=\"require('fs')\";",
    "var r=/import\\(['\"]node:fs['\"]\\)/;",
  ]) {
    // the words are not code at any date; a message that names Buffer.write( is the date-gated rule below
    const result = validateHttpSyncSource(wrap(body), "2026-11-25");
    expect(result).toEqual({ ok: true });
    for (const date of [undefined, "2026-10-22"]) {
      const errors = validateHttpSyncSource(wrap(body), date);
      if (!errors.ok) expect(errors.errors.join()).not.toMatch(/import\(\)|CommonJS|survived/);
    }
  }
});

test("a code import() after a string that looks like code is still refused", () => {
  for (const body of [`var a="x";var m=await import(route.module);`, "var a=`${1}`;var m=import(`./${p}.js`);"]) {
    for (const date of DATES) {
      const result = validateHttpSyncSource(wrap(body), date);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join()).toContain("dynamic import()");
    }
  }
});

test("a caught import of a node: module is a probe, not an import (better-auth: node:sqlite, node:async_hooks)", () => {
  for (const body of [
    "async function f(){try{const {DatabaseSync}=await import(/* @vite-ignore */ /* webpackIgnore: true */ `node:sqlite`);return DatabaseSync}catch{return null}}",
    "async function f(){try{if(x){return (await import(`node:async_hooks`)).AsyncLocalStorage}}catch(e){return null}}",
    'var p=import("node:fs").catch(()=>null);',
  ]) {
    for (const date of DATES) expect(validateHttpSyncSource(wrap(body), date)).toEqual({ ok: true });
  }
});

test("an uncaught import of a node: module is still refused", () => {
  for (const body of [
    `async function f(){return await import("node:fs");}`,
    "try{}catch(e){await import(`node:fs`)}",
  ]) {
    for (const date of DATES) expect(validateHttpSyncSource(wrap(body), date).ok).toBe(false);
  }
});

test('an "in globalThis" test guards a Node global like typeof does (better-auth: "Buffer" in globalThis&&Buffer.prototype)', () => {
  for (const body of [
    'var q="Buffer"in globalThis&&Buffer.prototype.indexOf;',
    "var q=`Buffer`in globalThis&&Buffer.prototype.indexOf;",
    'if("Buffer" in globalThis){Buffer.from(x)}',
    'var q="process" in self ? process.env : {};',
  ]) {
    for (const date of [GUARDED_GLOBALS_DATE, "2026-11-25"])
      expect(validateHttpSyncSource(wrap(body), date)).toEqual({ ok: true });
  }
  // a test for a different global, or none, does not guard
  for (const body of ['var q="Deno" in globalThis;var b=Buffer.from("a");', "var b=Buffer.from('a');"])
    expect(validateHttpSyncSource(wrap(body), GUARDED_GLOBALS_DATE).ok).toBe(false);
});

test("a word-only mention of Buffer.write( in a string passes from the guarded date, and fails before it as always", () => {
  expect(validateHttpSyncSource(wrap('throw new Error("Buffer.write(x) is gone");'), "2026-10-22").ok).toBe(false);
  expect(validateHttpSyncSource(wrap('throw new Error("Buffer.write(x) is gone");'), "2026-11-25")).toEqual({
    ok: true,
  });
});
