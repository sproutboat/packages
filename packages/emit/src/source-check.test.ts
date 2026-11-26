import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { EmitError, emitLocal, type EmitReason, type ModuleInput } from "./index";
import { checkCodeModule, positionOf } from "./source-check";
import { bundlerConfig } from "./virtual-bundle";

const HANDLER = `export default { fetch() { return new Response("ok"); } };`;
const esm = (name: string, content: string): ModuleInput => ({ name, type: "esm", content });
const metadata = { main_module: "index.js", compatibility_date: "2026-11-22", compatibility_flags: ["nodejs_compat"] };

async function refusal(modules: ModuleInput[]): Promise<{ reason: EmitReason; message: string }> {
  try {
    await emitLocal({ modules, metadata }, { name: "app" });
  } catch (error) {
    if (error instanceof EmitError) return { reason: error.reason, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

const markerPath = () => join(tmpdir(), `sb-emit-macro-${crypto.randomUUID()}`);
const writes = (marker: string) => `writeFileSync(${JSON.stringify(marker)}, "ran");`;
const FS = `import { writeFileSync } from "node:fs"`;

describe("a Bun macro never runs, however the source is written (B1)", () => {
  // Each of these fooled the regex over masked text, or would fool a tokenizer that guesses at `/`.
  type Attack = { name: string; source: (marker: string) => string; reason?: EmitReason };
  const attacks: Attack[] = [
    {
      name: "{} / 1 before the import (the reviewer's repro)",
      source: (m: string) => `const q = {} / 1; ${FS} with { type: "macro" }; ${writes(m)} const z = 2 /1;\n${HANDLER}`,
    },
    {
      name: "a division after a property named return",
      source: (m: string) =>
        `const o = { return: 4 }; const r = o.return / 1; ${FS} with { type: "macro" }; ${writes(m)} const z = 2 /1;\n${HANDLER}`,
    },
    {
      name: "a regex literal after the ) of an if",
      source: (m: string) => `if (1) /x/.test("x"); ${FS} with { type: "macro" }; ${writes(m)}\n${HANDLER}`,
    },
    {
      name: "a template literal that holds ${}",
      source: (m: string) =>
        `const t = \`\${ {} / 1 }\`; ${FS} with { type: "macro" }; ${writes(m)} const z = 2 /1;\n${HANDLER}`,
    },
    {
      // A module has no HTML comments, so this is a syntax error; Bun reads the line as a comment and would run the macro.
      name: "an HTML comment opener",
      source: (m: string) => `<!-- x\n${FS} with { type: "macro" }; ${writes(m)}\n${HANDLER}`,
      reason: "syntax-error",
    },
    {
      name: "a hashbang",
      source: (m: string) => `#!/usr/bin/env node\n${FS} with { type: "macro" }; ${writes(m)}\n${HANDLER}`,
    },
    {
      name: "an attribute split by comments",
      source: (m: string) => `${FS} /* a */ with /* b */ { type: /* c */ "macro" }; ${writes(m)}\n${HANDLER}`,
    },
    {
      // V8 dropped the legacy clause, so on Cloudflare it is a syntax error too; Bun still reads it as an attribute.
      name: "the legacy assert clause",
      source: (m: string) => `${FS} assert { type: "macro" }; ${writes(m)}\n${HANDLER}`,
      reason: "syntax-error",
    },
    {
      name: "the assert keyword written with an escape",
      source: (m: string) => `${FS} \\u0061ssert { type: "macro" }; ${writes(m)}\n${HANDLER}`,
      reason: "syntax-error",
    },
    {
      name: "the word macro written with an escape",
      source: (m: string) => `${FS} with { type: "\\x6dacro" }; ${writes(m)}\n${HANDLER}`,
    },
    {
      name: "export from with an attribute",
      source: (m: string) => `export { writeFileSync } from "node:fs" with { type: "macro" }; ${writes(m)}\n${HANDLER}`,
    },
    {
      name: "export * from with an attribute",
      source: (m: string) => `export * from "node:fs" with { type: "macro" }; ${writes(m)}\n${HANDLER}`,
    },
    { name: "a side-effect import", source: () => `import "node:fs" with { type: "macro" };\n${HANDLER}` },
    {
      name: "a dynamic import with options",
      source: () => `export default { async fetch() { return import("node:fs", { with: { type: "macro" } }); } };`,
    },
    {
      name: "no semicolon after the clause",
      source: (m: string) => `${FS} with { type: "macro" }\n${writes(m)}\n${HANDLER}`,
    },
    {
      name: "the clause on the next line",
      source: (m: string) => `${FS}\nwith { type: "macro" }; ${writes(m)}\n${HANDLER}`,
    },
  ];

  for (const { name, source, reason } of attacks) {
    test(`${name}: refused, nothing is written`, async () => {
      const marker = markerPath();
      const error = await refusal([esm("index.js", source(marker))]);
      expect(error.reason).toBe(reason ?? "import-attribute-refused");
      expect(await Bun.file(marker).exists()).toBe(false);
    });
  }

  test("in a module the entry imports", async () => {
    const marker = markerPath();
    const error = await refusal([
      esm("index.js", `import "./a.js";\n${HANDLER}`),
      esm("a.js", `const q = {} / 1; ${FS} with { type: "macro" }; ${writes(marker)} 2 /1;`),
    ]);
    expect(error.reason).toBe("import-attribute-refused");
    expect(error.message).toContain('"a.js"');
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("in a cjs module an import is a syntax error, as it is on Cloudflare", async () => {
    const marker = markerPath();
    const error = await refusal([
      esm("index.js", `import "./a.js";\n${HANDLER}`),
      { name: "a.js", type: "cjs", content: `const q = {} / 1; ${FS} with { type: "macro" }; ${writes(marker)} 2 /1;` },
    ]);
    expect(error.reason).toBe("syntax-error");
    expect(error.message).toContain('"a.js"');
    expect(error.message).toContain("a CommonJS module cannot use import, export, import.meta or top-level await");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("in a module nothing imports", async () => {
    const marker = markerPath();
    const error = await refusal([
      esm("index.js", HANDLER),
      esm("unused.js", `${FS} with { type: "macro" }; ${writes(marker)}`),
    ]);
    expect(error.reason).toBe("import-attribute-refused");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("the message names the module, line and column", async () => {
    const error = await refusal([esm("index.js", `\n\n  import x from "./a.js" with { type: "file" };\n${HANDLER}`)]);
    expect(error.message).toContain('module "index.js"');
    expect(error.message).toContain("line 3, column");
  });

  test("a source no parser reads fails closed", async () => {
    const error = await refusal([esm("index.js", `${FS} with { type: "macro" ${HANDLER}`)]);
    expect(error.reason).toBe("syntax-error");
  });

  test("the emitter's own Bun.build config stops a macro that no source check saw (a dropped option or a Bun upgrade fails here)", async () => {
    const marker = markerPath();
    // `bundlerConfig` is what `bundleModules` builds with. The source checks run in `bundleModules`, not in the config, so a
    // macro written straight into a module reaches Bun here exactly as one that fooled both readers would.
    const config = bundlerConfig("sb:entry", [
      {
        name: "canary",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            args.importer === "" ? { path: "entry", namespace: "canary" } : { path: args.path, external: true },
          );
          build.onLoad({ filter: /.*/, namespace: "canary" }, () => ({
            contents: `${FS} with { type: "macro" }; ${writes(marker)} export default 1;`,
            loader: "js",
          }));
        },
      },
    ]);
    let failure = "built";
    try {
      await Bun.build(config);
    } catch (error) {
      failure = error instanceof AggregateError ? error.errors.map((e) => String(e.message)).join() : "?";
    }
    expect(failure).toContain("Macros are disabled");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("code that only mentions the words is not refused", async () => {
    const result = await emitLocal(
      {
        modules: [
          esm(
            "index.js",
            `export default { fetch() { return new Response("import x from 'y' with { type: 'macro' }"); } }; // import a from "b" with { type: "file" }`,
          ),
        ],
        metadata,
      },
      { name: "app" },
    );
    expect(result.bundled).toContain("with { type: 'macro' }");
  });
});

describe("two lexers fooled together (R1): the reviewer's input, and a sweep with Bun as the judge", () => {
  // es-module-lexer read `/` after `function(){}`, `async function(){}`, `function*(){}` and `yield` as a regex where Bun reads
  // a division, so it saw `import "node:fs"` where Bun saw the macro import, and the two lists matched. A parser that follows
  // the grammar reads the macro import itself.
  const reviewer = (prefix: string, marker: string) =>
    `let x, y;\nx = ${prefix} / 1; ${FS} with { type: "macro" }; y = 1 / /;import "node:fs";/ / 1 / 1;\n${writes(marker)}\n${HANDLER}`;

  for (const prefix of ["function(){}", "async function(){}", "function*(){}", "yield"]) {
    test(`x = ${prefix} / 1: refused through the emitter, no marker`, async () => {
      const marker = markerPath();
      const error = await refusal([esm("index.js", reviewer(prefix, marker))]);
      // `yield` is a reserved word in a module, so that variant is a syntax error before it is anything else.
      expect(error.reason).toBe(prefix === "yield" ? "syntax-error" : "import-attribute-refused");
      expect(await Bun.file(marker).exists()).toBe(false);
    });
  }

  /** Whether Bun, building with the emitter's own config, read a macro import in `source`. */
  async function bunSawMacro(source: string): Promise<boolean> {
    const config = bundlerConfig("sb:entry", [
      {
        name: "oracle",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            args.importer === "" ? { path: "entry", namespace: "oracle" } : { path: args.path, external: true },
          );
          build.onLoad({ filter: /.*/, namespace: "oracle" }, () => ({ contents: source, loader: "js" }));
        },
      },
    ]);
    try {
      await Bun.build(config);
    } catch (error) {
      return (
        error instanceof AggregateError && error.errors.some((e) => String(e.message).includes("Macros are disabled"))
      );
    }
    return false;
  }

  const prefixes = [
    "x = function(){}",
    "x = async function(){}",
    "x = function*(){}",
    "x = async function*(){}",
    "x = function f(){}",
    "x = class {}",
    "x = class A { m() {} }",
    "x = () => {}",
    "x = async () => {}",
    "if (1)",
    "if (1) y = 2; else",
    "for (;;)",
    "while (0)",
    "with (a)",
    "x = a\n",
    "x = a++\n",
    "x = yield",
    "x = await",
    "x = typeof",
    "x = void",
    "x = return",
    "let",
    "of",
    "x = a.return",
    "x = a.yield",
    "x = {}",
    "x = ({})",
    "x = (a)",
    "x = [a]",
    "x = `t`",
    "x = this",
    "x = 1",
    "x = /a/",
    "x = }",
    "<!--\n",
    "x = 1;\n-->",
    "x = a ? function(){} :",
    "x = delete",
    "x = new",
  ];
  const forms = [
    (p: string, m: string) =>
      `let x, y, a;\n${p} / 1; ${FS} with { type: "macro" }; ${writes(m)} y = 1 / /;import "node:fs";/ / 1 / 1;\n${HANDLER}`,
    (p: string, m: string) =>
      `let x, y, a;\n${p} /re/g; import "node:fs"; y = 1 / /; ${FS} with { type: "macro" }; ${writes(m)} /g / 1;\n${HANDLER}`,
    (p: string, m: string) =>
      `let x, y, a;\n${p} / 1 / /\n${FS} with { type: "macro" }; ${writes(m)}\n/ 1;import "node:fs";\n${HANDLER}`,
  ];

  for (const kind of ["esm", "cjs"] as const) {
    test(`${kind}: every program in which Bun reads a macro import is refused, and none writes a marker`, async () => {
      let judged = 0;
      for (const prefix of prefixes)
        for (const form of forms) {
          const marker = markerPath();
          const source = form(prefix, marker);
          if (!(await bunSawMacro(source))) continue;
          judged += 1;
          let refused: unknown;
          try {
            checkCodeModule("m.js", source, kind);
          } catch (error) {
            refused = error;
          }
          if (!(refused instanceof EmitError))
            throw new Error(`Bun reads a macro import here, and the check did not refuse it:\n${source}`);
          expect(await Bun.file(marker).exists()).toBe(false);
        }
      // Not vacuous: Bun reads a macro import in a good many of them (the reviewer's three among them).
      expect(judged).toBeGreaterThanOrEqual(10);
    });
  }

  test("through the emitter, every one of those is refused or built without a marker", async () => {
    for (const prefix of prefixes)
      for (const form of forms) {
        const marker = markerPath();
        try {
          await emitLocal({ modules: [esm("index.js", form(prefix, marker))], metadata }, { name: "app" });
        } catch (error) {
          if (!(error instanceof EmitError)) throw error;
        }
        expect(await Bun.file(marker).exists()).toBe(false);
      }
  });
});

describe("positions count every ECMAScript line terminator", () => {
  test("LF, CR, CR LF (once), U+2028 and U+2029", () => {
    const at = (text: string) => positionOf(text, text.indexOf("X"));
    expect(at("a\nbX")).toEqual({ line: 2, column: 2 });
    expect(at("a\rbX")).toEqual({ line: 2, column: 2 });
    expect(at("a\r\nbX")).toEqual({ line: 2, column: 2 });
    expect(at("a\u2028b\u2029X")).toEqual({ line: 3, column: 1 });
    expect(at("a\r\r\nX")).toEqual({ line: 3, column: 1 });
  });

  test("a refusal on the second line of a CR-only module says line 2", async () => {
    const error = await refusal([
      esm("index.js", `const a = 1;\rimport("x", { with: { type: "json" } });\r${HANDLER}`),
    ]);
    expect(error.reason).toBe("import-attribute-refused");
    expect(error.message).toContain("line 2, column");
  });
});

describe("a syntax error is an EmitError with a stable reason, a line and a column (S2)", () => {
  test("in the main module", async () => {
    const error = await refusal([esm("index.js", `export default {\n  fetch() { return 1 +; }\n};`)]);
    expect(error.reason).toBe("syntax-error");
    expect(error.message).toBe('syntax error in "index.js" at line 2, column 23: Unexpected ;');
  });

  test("in an imported module, naming that module", async () => {
    const error = await refusal([
      esm("index.js", `import "./lib/a.js";\n${HANDLER}`),
      esm("lib/a.js", `export const a = (;`),
    ]);
    expect(error.reason).toBe("syntax-error");
    expect(error.message).toContain('"lib/a.js" at line 1, column 19');
  });

  test("in a cjs module", async () => {
    const error = await refusal([
      esm("index.js", `import "./a.js";\n${HANDLER}`),
      { name: "a.js", type: "cjs", content: "module.exports = {;" },
    ]);
    expect(error.reason).toBe("syntax-error");
  });

  test("an unexpected export, and an unterminated module", async () => {
    expect((await refusal([esm("index.js", `export default {`)])).reason).toBe("syntax-error");
    expect((await refusal([esm("index.js", `export { nope };\nexport default {`)])).reason).toBe("syntax-error");
  });
});
