import { describe, expect, test } from "bun:test";
import {
  EmitError,
  MAX_BUNDLED_BYTES,
  MAX_DATA_TOTAL_BYTES,
  MAX_SOURCEMAP_BYTES,
  MAX_TOTAL_BYTES,
  emitLocal,
  type EmitReason,
  type ModuleInput,
} from "./index";
import { checkBundledSize } from "./virtual-bundle";

const HANDLER = `export default { fetch() { return new Response("ok"); } };\n`;
const esm = (name: string, content: string): ModuleInput => ({ name, type: "esm", content });
const MIB = 1024 * 1024;
const metadata = { main_module: "index.js", compatibility_date: "2026-11-22", compatibility_flags: ["nodejs_compat"] };

async function outcome(modules: ModuleInput[]): Promise<{ reason: EmitReason | "emitted"; message: string }> {
  try {
    await emitLocal({ modules, metadata }, { name: "app" });
  } catch (error) {
    if (error instanceof EmitError) return { reason: error.reason, message: error.message };
    throw error;
  }
  return { reason: "emitted", message: "" };
}

/** Whole copies of `unit` only, so the source ends at a complete statement at every length. */
const whole = (unit: string, length: number) => unit.repeat(Math.floor(length / unit.length));
const fill = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

describe("every check runs in time linear in the input (S1)", () => {
  // Each of these is as long as the code cap allows. The first two took 11 s and 14 s at 140 KB before the checks read tokens.
  const adversarial = {
    'import( repeated (the reviewer\'s "import(" case)': fill("import(", 8 * MIB - 64),
    "Buffer.x; then import repeated (the reviewer's second case)": `Buffer.x;${fill(" import", 8 * MIB - 64)}`,
    "braces only": fill("{", 8 * MIB - 64),
    "export{ repeated": fill("export{", 8 * MIB - 64),
    "template openers": fill("`${", 8 * MIB - 64),
  } satisfies { [name: string]: string };
  for (const [name, source] of Object.entries(adversarial)) {
    test(`8 MiB of ${name} is answered in under 2 s`, async () => {
      const started = performance.now();
      const result = await outcome([esm("index.js", source)]);
      expect(performance.now() - started).toBeLessThan(2000);
      // Input that nests without end is refused as too deep (the parser's stack) or as a syntax error, never a crash.
      expect(["syntax-error", "limit-exceeded"]).toContain(result.reason);
    });
  }

  // A linear check takes about 4 times as long for 4 times the input; the quadratic ones took 16 times.
  const valid = {
    "a long run of newlines": (n) => HANDLER + "\n".repeat(n),
    "a long run of spaces": (n) => HANDLER + " ".repeat(n),
    "regex literals": (n) => HANDLER + whole("x = /a/g;\n", n),
    "process and Buffer uses": (n) => HANDLER + whole("process.env.X; Buffer.from(y);\n", n),
    "const keywords": (n) => HANDLER + whole("{ const a = 1; }\n", n),
  } satisfies { [name: string]: (length: number) => string };
  for (const [name, make] of Object.entries(valid)) {
    test(`${name}: four times the input takes about four times as long`, async () => {
      const time = async (length: number) => {
        const started = performance.now();
        const result = await outcome([esm("index.js", make(length))]);
        // Only an emitted module is a measurement: a refusal would time the wrong path.
        expect(result.reason).toBe("emitted");
        return performance.now() - started;
      };
      await time(64 * 1024);
      const small = await time(512 * 1024);
      const large = await time(2 * MIB);
      expect(large / Math.max(small, 20)).toBeLessThan(10);
    });
  }
});

describe("size caps are checked before anything is bundled (S3)", () => {
  test("data modules count together against the static-data region", async () => {
    const data = (name: string): ModuleInput => ({ name, type: "data", content: new Uint8Array(600 * 1024) });
    const result = await outcome([esm("index.js", HANDLER), data("a.bin"), data("b.bin")]);
    expect(result.reason).toBe("limit-exceeded");
    expect(result.message).toContain(`at most ${MAX_DATA_TOTAL_BYTES}`);
  });

  test("40 data modules of 1 MiB are refused at once, not built into a 167 MB bundle", async () => {
    const modules = [
      esm("index.js", HANDLER),
      ...Array.from({ length: 40 }, (_, i): ModuleInput => ({
        name: `d${i}.bin`,
        type: "data",
        content: new Uint8Array(MIB),
      })),
    ];
    const started = performance.now();
    expect((await outcome(modules)).reason).toBe("limit-exceeded");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("sourcemaps have a cap of their own", async () => {
    const map: ModuleInput = { name: "index.js.map", type: "sourcemap", content: "x".repeat(9 * MIB) };
    const result = await outcome([esm("index.js", HANDLER), map]);
    expect(result.reason).toBe("limit-exceeded");
    expect(result.message).toContain(`at most ${MAX_SOURCEMAP_BYTES}`);
    const fits: ModuleInput = { name: "index.js.map", type: "sourcemap", content: "x".repeat(8 * MIB) };
    expect((await outcome([esm("index.js", HANDLER), fits])).reason).toBe("emitted");
  });

  test("one total covers code, data and sourcemaps together", async () => {
    const modules: ModuleInput[] = [
      esm("index.js", `${HANDLER}// ${"x".repeat(7 * MIB)}`),
      { name: "a.map", type: "sourcemap", content: "x".repeat(8 * MIB) },
      { name: "t.txt", type: "text", content: "y".repeat(2 * MIB) },
    ];
    const result = await outcome(modules);
    expect(result.reason).toBe("limit-exceeded");
    expect(result.message).toContain(`at most ${MAX_TOTAL_BYTES}`);
  });

  test("a text module of control characters is counted as the string literal it becomes", async () => {
    const started = performance.now();
    const text: ModuleInput = { name: "t.txt", type: "text", content: "\u0001".repeat(3 * MIB) };
    const result = await outcome([esm("index.js", `import t from "./t.txt";\n${HANDLER}`), text]);
    expect(result.reason).toBe("limit-exceeded");
    expect(result.message).toContain(`at most ${MAX_BUNDLED_BYTES}`);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("every cap counts UTF-8 bytes: lone surrogates, which JSON.stringify prints as 6 bytes, are counted as 6 (R4)", async () => {
    // 2 MiB of control characters grow to 12 MiB; 1 Mi lone surrogates grow to 6 MiB. Counted one unit each, the sum was 13 MiB
    // and passed the check before bundling; counted as bytes it is 18 MiB and is refused there, with the same unit in the message.
    const modules: ModuleInput[] = [
      esm("index.js", `import a from "./a.txt"; import b from "./b.txt";\n${HANDLER}`),
      { name: "a.txt", type: "text", content: "\u0001".repeat(2 * MIB) },
      { name: "b.txt", type: "text", content: "\ud800".repeat(MIB) },
    ];
    const result = await outcome(modules);
    expect(result.reason).toBe("limit-exceeded");
    expect(result.message).toMatch(/grow to \d+ bytes once text and data modules become string literals/);
  });

  test("the cap on the bundled output counts UTF-8 bytes, not UTF-16 units (R4)", () => {
    // 4.5 Mi astral characters are 9 Mi units but 18 MB in UTF-8; by units they would pass a 16 MiB cap.
    const output = "\u{1F600}".repeat(4.5 * MIB);
    expect(output.length).toBeLessThan(MAX_BUNDLED_BYTES);
    let message = "";
    try {
      checkBundledSize(output);
    } catch (error) {
      message = error instanceof EmitError ? error.message : String(error);
    }
    expect(message).toBe(`the bundled module is ${Buffer.byteLength(output)} bytes; at most ${MAX_BUNDLED_BYTES}`);
  });

  test("a text module given as bytes is measured as the literal it becomes, like the string form (CodeRabbit)", async () => {
    const modules = (content: Uint8Array | string): ModuleInput[] => [
      esm("index.js", `import a from "./a.txt";\n${HANDLER}`),
      { name: "a.txt", type: "text", content },
    ];
    const bytes = new Uint8Array(3 * MIB).fill(1);
    const fromBytes = await outcome(modules(bytes));
    expect(fromBytes.reason).toBe("limit-exceeded");
    expect(fromBytes.message).toMatch(/grow to \d+ bytes once text and data modules become string literals/);
    expect((await outcome(modules("\u0001".repeat(3 * MIB)))).message).toBe(fromBytes.message);
  });

  test("short JSON escapes count 2 bytes, the other control characters 6 (CodeRabbit)", async () => {
    // 3 MiB of newlines print as 6 MiB: well inside the cap. The same count of \u0001 prints as 18 MiB: refused.
    const text = (content: string): ModuleInput[] => [
      esm("index.js", `import a from "./a.txt";\n${HANDLER}`),
      { name: "a.txt", type: "text", content },
    ];
    expect((await outcome(text("\n".repeat(3 * MIB)))).reason).toBe("emitted");
    expect((await outcome(text("\u0001".repeat(3 * MIB)))).reason).toBe("limit-exceeded");
  });

  test("text that stays under the expanded cap still bundles", async () => {
    const text: ModuleInput = { name: "t.txt", type: "text", content: "z".repeat(MIB) };
    const result = await emitLocal(
      {
        modules: [
          esm("index.js", `import t from "./t.txt";\nexport default { fetch() { return new Response(t); } };`),
          text,
        ],
        metadata,
      },
      { name: "app" },
    );
    expect(result.bundled.length).toBeGreaterThan(MIB);
  });
});

describe("raw C is the compile layer's to refuse, and emit hands it on unchanged (N1)", () => {
  const RAW = "Porffor.c`int x = 1;`";
  test("in an ES module", async () => {
    const result = await emitLocal({ modules: [esm("index.js", `${HANDLER}${RAW};`)], metadata }, { name: "app" });
    expect(result.bundled).toContain(RAW);
    expect(result.region).toContain(RAW);
  });

  test("in a text module a handler evaluates with new Function", async () => {
    const source = `import code from "./c.txt"; export default { fetch() { return new Response(String(new Function(code)())); } };`;
    const result = await emitLocal(
      { modules: [esm("index.js", source), { name: "c.txt", type: "text", content: `return ${RAW};` }], metadata },
      { name: "app" },
    );
    expect(result.bundled).toContain("Porffor.c`int x = 1;`");
  });

  test("split across modules", async () => {
    const result = await emitLocal(
      {
        modules: [
          esm("index.js", `import { c } from "./c.js";\n${HANDLER}c();`),
          esm("c.js", `export const c = () => ${RAW};`),
        ],
        metadata,
      },
      { name: "app" },
    );
    expect(result.bundled).toContain(RAW);
  });
});
