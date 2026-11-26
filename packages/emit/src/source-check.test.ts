import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { EmitError, emitLocal, type EmitReason, type ModuleInput } from "./index";

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
  const attacks = [
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
      name: "an HTML comment opener",
      source: (m: string) => `<!-- x\n${FS} with { type: "macro" }; ${writes(m)}\n${HANDLER}`,
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
      name: "the legacy assert clause",
      source: (m: string) => `${FS} assert { type: "macro" }; ${writes(m)}\n${HANDLER}`,
    },
    {
      name: "the assert keyword written with an escape",
      source: (m: string) => `${FS} \\u0061ssert { type: "macro" }; ${writes(m)}\n${HANDLER}`,
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

  for (const { name, source } of attacks) {
    test(`${name}: refused, nothing is written`, async () => {
      const marker = markerPath();
      const error = await refusal([esm("index.js", source(marker))]);
      expect(error.reason).toBe("import-attribute-refused");
      expect(await Bun.file(marker).exists()).toBe(false);
    });
  }

  test("in a module the entry imports, whatever its type", async () => {
    for (const type of ["esm", "cjs"] as const) {
      const marker = markerPath();
      const error = await refusal([
        esm("index.js", `import "./a.js";\n${HANDLER}`),
        { name: "a.js", type, content: `const q = {} / 1; ${FS} with { type: "macro" }; ${writes(marker)} 2 /1;` },
      ]);
      expect(error.reason).toBe("import-attribute-refused");
      expect(error.message).toContain('"a.js"');
      expect(await Bun.file(marker).exists()).toBe(false);
    }
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

  test("a source the lexer cannot read fails closed, with the parser's own message", async () => {
    const error = await refusal([esm("index.js", `${FS} with { type: "macro" ${HANDLER}`)]);
    expect(error.reason).toBe("syntax-error");
  });

  test("Bun still honours macros: false (the last layer: a Bun upgrade that drops it fails here)", async () => {
    const marker = markerPath();
    const config: Parameters<typeof Bun.build>[0] & { macros: false } = {
      entrypoints: ["sb:entry"],
      target: "browser",
      macros: false,
      plugins: [
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
      ],
    };
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
