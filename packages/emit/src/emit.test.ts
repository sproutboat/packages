import { describe, expect, test } from "bun:test";
import { EmitError, emitFromBundle, type EmitReason, type JsonObject, type ModuleInput } from "./index";

const esm = (name: string, content: string): ModuleInput => ({ name, type: "esm", content });
const HANDLER = `export default { fetch() { return new Response("ok"); } };`;
const meta = (extra: JsonObject = {}) => ({ main_module: "index.js", compatibility_date: "2026-11-23", ...extra });
const emit = (modules: ModuleInput[], metadata: JsonObject = meta(), options: { name?: string } = {}) =>
  emitFromBundle({ modules, metadata }, { name: options.name ?? "app" });

async function refusal(run: Promise<unknown>): Promise<{ reason: EmitReason; message: string }> {
  try {
    await run;
  } catch (error) {
    if (error instanceof EmitError) return { reason: error.reason, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("emitFromBundle", () => {
  test("a self-contained module passes through the wrapper untouched", async () => {
    const result = await emit([esm("index.js", HANDLER)]);
    expect(result.bundled).toBe(HANDLER);
    expect(result.region.startsWith("globalThis.__sbCompat = ")).toBe(true);
    expect(result.region).toContain("export default {\n  port: 8080");
    expect(result.region).not.toContain("Porffor.c");
  });

  test("several modules are bundled by name, relative and root-relative", async () => {
    const result = await emit([
      esm(
        "index.js",
        `import { greet } from "./lib/greet.js"; import shared from "chunks/shared.js"; export default { fetch() { return new Response(greet() + shared); } };`,
      ),
      esm("lib/greet.js", `import up from "../chunks/shared.js"; export const greet = () => "hi" + up;`),
      esm("chunks/shared.js", `export default "!";`),
    ]);
    expect(result.bundled).toContain('var shared_default = "!"');
    expect(result.bundled).not.toMatch(/^import /m);
  });

  test("text, data and cjs modules become code", async () => {
    const result = await emit([
      esm(
        "index.js",
        `import sql from "./schema.sql"; import blob from "./blob.bin"; import cjs from "./legacy.js"; export default { fetch() { return new Response(sql + blob.byteLength + cjs.v); } };`,
      ),
      { name: "schema.sql", type: "text", content: "CREATE TABLE t (a);" },
      { name: "blob.bin", type: "data", content: new Uint8Array([0, 1, 254, 255]) },
      { name: "legacy.js", type: "cjs", content: "module.exports = { v: 7 };" },
    ]);
    expect(result.bundled).toContain("CREATE TABLE t (a);");
    expect(result.bundled).toContain("charCodeAt");
    expect(result.bundled).toContain("þÿ");
  });

  test("cloudflare:workers stays an external, static and dynamic", async () => {
    const result = await emit(
      [
        esm(
          "index.js",
          `import { DurableObject } from "cloudflare:workers"; import { b } from "./b.js"; export class Room extends DurableObject {} export default { async fetch() { const { env } = await import("cloudflare:workers"); return new Response(String(b) + env); } };`,
        ),
        esm("b.js", `export const b = 1;`),
      ],
      meta({ bindings: [{ type: "durable_object_namespace", name: "ROOMS", class_name: "Room" }] }),
    );
    expect(result.region).toContain("__sbRegisterDO");
    expect(result.region).toContain("globalThis.DurableObject");
  });

  test("a Durable Object class that the bundle does not export is refused", async () => {
    const error = await refusal(
      emit(
        [esm("index.js", HANDLER)],
        meta({ bindings: [{ type: "durable_object_namespace", name: "ROOMS", class_name: "Room" }] }),
      ),
    );
    expect(error.reason).toBe("do-class-not-exported");
  });

  test("a class re-exported through a barrel module is found after bundling", async () => {
    const result = await emit(
      [
        esm("index.js", `export * from "./do.js"; export default { fetch() { return new Response("ok"); } };`),
        esm("do.js", `export class Room {}`),
      ],
      meta({ bindings: [{ type: "durable_object_namespace", name: "ROOMS", class_name: "Room" }] }),
    );
    expect(result.bindings.runtime.do).toEqual([{ binding: "ROOMS", className: "Room" }]);
  });

  test("secrets: names are bound, values never appear", async () => {
    const result = await emit(
      [esm("index.js", HANDLER)],
      meta({
        bindings: [
          { type: "secret_text", name: "API_KEY", text: "hunter2-very-secret" },
          { type: "plain_text", name: "MODE", text: "prod" },
        ],
      }),
    );
    const everything = JSON.stringify(result);
    expect(everything).not.toContain("hunter2-very-secret");
    expect(result.bindings.runtime.secrets).toEqual(["API_KEY"]);
    expect(result.region).toContain('"secrets":["API_KEY"]');
    expect(result.region).toContain('const env = {"MODE":"prod"}');
  });

  test("names the app already holds are bound as well", async () => {
    const result = await emitFromBundle(
      { modules: [esm("index.js", HANDLER)], metadata: meta({ bindings: [{ type: "secret_text", name: "A" }] }) },
      { name: "app", extraSecretNames: ["B", "A"] },
    );
    expect(result.bindings.runtime.secrets).toEqual(["A", "B"]);
    expect(result.bindings.record.bindings.map((b) => `${b.kind}:${b.name}`)).toEqual(["secret:A", "secret:B"]);
  });

  test("the Cloud emit carries assets settings and never files", async () => {
    const result = await emit(
      [esm("index.js", HANDLER)],
      meta({
        bindings: [{ type: "assets", name: "ASSETS" }],
        assets: { config: { not_found_handling: "single-page-application", run_worker_first: ["/api/*"] } },
      }),
    );
    expect(result.region).toContain(
      'globalThis.__sbAssets = {"manifest":{"notFound":"single-page-application","runSproutFirst":["/api/*"],"files":{}},"files":{}}',
    );
    expect(result.bindings.runtime.assets).toBe("ASSETS");
  });

  test("version metadata needs the caller's id", async () => {
    const metadata = meta({ bindings: [{ type: "version_metadata", name: "VERSION" }] });
    expect((await refusal(emit([esm("index.js", HANDLER)], metadata))).reason).toBe("binding-invalid");
    const result = await emitFromBundle(
      { modules: [esm("index.js", HANDLER)], metadata },
      { name: "app", versionMetadata: { id: "abc", tag: "app", timestamp: "2026-11-26T00:00:00.000Z" } },
    );
    expect(result.region).toContain(
      'env["VERSION"] = {"id":"abc","tag":"app","timestamp":"2026-11-26T00:00:00.000Z"};',
    );
  });

  test("GENERATION: unknown fields and warnings are reported, not lost", async () => {
    const result = await emit(
      [esm("index.js", HANDLER)],
      meta({
        observability: { enabled: true },
        bindings: [{ type: "kv_namespace", name: "CACHE", namespace_id: "abc" }],
      }),
    );
    expect(result.warnings.join("\n")).toContain("ignored: observability");
    expect(result.warnings.join("\n")).toContain("pins an account-level id");
    expect(result.bindings.runtime.resources).toEqual({ CACHE: { kind: "kv", id: "abc" } });
  });
});

describe("node built-ins and globals", () => {
  const nodeUser = `import { Buffer } from "node:buffer"; import path from "node:path"; export default { fetch() { return new Response(path.join("a", "b") + Buffer.from("x").length); } };`;
  const modules = [esm("index.js", nodeUser), esm("lib.js", "export const x = 1;")];

  test("before the default-on date, or with no_nodejs_compat, a node: import fails as on Cloudflare", async () => {
    for (const metadata of [
      meta({ compatibility_date: "2026-08-03" }),
      meta({ compatibility_flags: ["no_nodejs_compat"] }),
    ]) {
      const error = await refusal(emit(modules, metadata));
      expect(error.reason).toBe("no-such-module");
      expect(error.message).toBe('No such module "node:buffer". Imported from "index.js"');
    }
  });

  test("from 2026-08-04 nodejs_compat is on without the flag, as Alchemy v2 relies on", async () => {
    const result = await emit(modules);
    expect(result.bundled).toContain("normalizeStringPosix");
  });

  test("with it, the shim answers node:path and the bundler's polyfill the rest", async () => {
    const result = await emit(modules, meta({ compatibility_flags: ["nodejs_compat"] }));
    expect(result.bundled).toContain("normalizeStringPosix");
    expect(result.bundled).not.toMatch(/^import /m);
    expect(result.bundled).not.toContain("process.cwd");
  });

  test("free Buffer, process and global are bound inside the bundle under the flag", async () => {
    const free = `import "./lib.js"; export default { fetch() { return new Response(String(Buffer.from("x").length) + process.env.MODE + global.name); } };`;
    const result = await emit(
      [esm("index.js", free), esm("lib.js", "export const x = 1;")],
      meta({ compatibility_flags: ["nodejs_compat"], bindings: [{ type: "plain_text", name: "MODE", text: "m" }] }),
    );
    expect(result.bundled).toContain("var global = globalThis;");
    expect(result.bundled).toContain("browser: true");
    expect(result.bundled).toContain("Object.defineProperty(env, name");
  });

  test("a function named like a builtin is renamed so the unit stays admissible", async () => {
    const source = `import "./lib.js"; export const escapeIdentifier = function escape(s) { return s; }; export default { fetch() { return new Response(escapeIdentifier("a")); } };`;
    const result = await emit([esm("index.js", source), esm("lib.js", "export const x = 1;")]);
    expect(result.bundled).toContain("function escape_sb(");
  });
});

describe("hostile input", () => {
  test("a bare specifier that is not uploaded: Cloudflare's wording", async () => {
    const error = await refusal(
      emit([esm("index.js", `import _ from "lodash"; export default { fetch() { return new Response(_.name); } };`)]),
    );
    expect(error).toEqual({ reason: "no-such-module", message: 'No such module "lodash". Imported from "index.js"' });
  });

  test("a relative import that leaves the upload, and one that names nothing", async () => {
    expect(
      (await refusal(emit([esm("index.js", `import x from "../../etc/passwd"; export default { fetch() {} };`)])))
        .reason,
    ).toBe("no-such-module");
    expect(
      (await refusal(emit([esm("index.js", `import x from "./missing.js"; export default { fetch() {} };`)]))).message,
    ).toContain('No such module "./missing.js"');
  });

  test("a URL, a data: URL and an absolute path are not modules", async () => {
    for (const specifier of [
      "https://evil.example/x.js",
      "data:text/javascript,export default 1",
      "/etc/passwd",
      "file:///etc/passwd",
      "bun:sqlite",
      "cloudflare:email",
    ]) {
      const error = await refusal(
        emit(
          [esm("index.js", `import x from ${JSON.stringify(specifier)}; export default { fetch() {} };`)],
          meta({ compatibility_flags: ["nodejs_compat"] }),
        ),
      );
      expect(error.reason).toBe("no-such-module");
    }
  });

  test("a sourcemap is stored, never importable", async () => {
    const error = await refusal(
      emit([
        esm("index.js", `import m from "./index.js.map"; export default { fetch() {} };`),
        { name: "index.js.map", type: "sourcemap", content: "{}" },
      ]),
    );
    expect(error.reason).toBe("no-such-module");
  });

  test("import attributes are refused in every module, before the bundler sees them", async () => {
    const attacks = [
      `import x from "./a.js" with { type: "macro" }; export default { fetch() {} };`,
      `import x from "./a.js" with { type: "file" }; export default { fetch() {} };`,
      `import x from "./a.js" assert { type: "sqlite" }; export default { fetch() {} };`,
      `export { x } from "./a.js" with { type: "toml" }; export default { fetch() {} };`,
      `export default { async fetch() { return import("./a.js", { with: { type: "macro" } }); } };`,
    ];
    for (const source of attacks) {
      const error = await refusal(emit([esm("index.js", source), esm("a.js", "export const x = 1;")]));
      expect(error.reason).toBe("import-attribute-refused");
    }
    const inChunk = await refusal(
      emit([
        esm("index.js", `import "./a.js"; export default { fetch() {} };`),
        esm("a.js", `import b from "./b.js" with { type: "macro" }; export default b;`),
        esm("b.js", "export default 1;"),
      ]),
    );
    expect(inChunk.reason).toBe("import-attribute-refused");
  });

  test("a macro is never run: nothing is written, nothing is read", async () => {
    const marker = `/tmp/sb-emit-macro-${crypto.randomUUID()}`;
    await refusal(
      emit(
        [
          esm("index.js", `import { x } from "./m.js" with { type: "macro" }; export default { fetch() {} };`),
          esm(
            "m.js",
            `import { writeFileSync } from "node:fs"; export function x() { writeFileSync(${JSON.stringify(marker)}, "ran"); return 1; }`,
          ),
        ],
        meta({ compatibility_flags: ["nodejs_compat"] }),
      ),
    );
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("code in a module that only mentions the words is not refused", async () => {
    const result = await emit([
      esm(
        "index.js",
        `export default { fetch() { return new Response("import x from 'y' with { type: 'macro' }"); } }; // import a from "b" with { type: "file" }`,
      ),
    ]);
    expect(result.bundled).toContain("with { type: 'macro' }");
  });

  test("path traversal and absolute names are refused as module names", async () => {
    for (const name of ["../index.js", "a/../../b.js", "/abs.js", "a//b.js", "a\\b.js", "a\0b.js"]) {
      const error = await refusal(
        emitFromBundle(
          { modules: [esm("index.js", HANDLER), esm(name, "export const x = 1;")], metadata: meta() },
          { name: "app" },
        ),
      );
      expect(error.reason).toBe("module-invalid");
    }
  });

  test("main_module that is missing, or not an ES module", async () => {
    expect((await refusal(emit([esm("other.js", HANDLER)]))).reason).toBe("module-missing");
    expect((await refusal(emit([{ name: "index.js", type: "cjs", content: "module.exports = {}" }]))).reason).toBe(
      "module-type-unsupported",
    );
  });

  test("oversized: 257 modules, 8 MiB + 1, a 1 MiB + 1 data module, metadata at 256 KiB + 1", async () => {
    const many = [esm("index.js", HANDLER), ...Array.from({ length: 256 }, (_, i) => esm(`m${i}.js`, "export {};"))];
    expect((await refusal(emit(many))).reason).toBe("limit-exceeded");
    const big = esm("index.js", `${HANDLER}\n// ${"x".repeat(8 * 1024 * 1024)}`);
    expect((await refusal(emit([big]))).reason).toBe("limit-exceeded");
    const data = { name: "d.bin", type: "data" as const, content: new Uint8Array(1024 * 1024 + 1) };
    expect((await refusal(emit([esm("index.js", HANDLER), data]))).reason).toBe("limit-exceeded");
    expect(
      (await refusal(emit([esm("index.js", HANDLER)], meta({ annotations: { note: "x".repeat(256 * 1024) } })))).reason,
    ).toBe("limit-exceeded");
  });

  test("a deep import cycle bundles", async () => {
    const modules = [
      esm("index.js", `import { a0 } from "./m0.js"; export default { fetch() { return new Response(String(a0)); } };`),
    ];
    for (let i = 0; i < 200; i += 1)
      modules.push(
        esm(
          `m${i}.js`,
          `import { a${(i + 1) % 200} as next } from "./m${(i + 1) % 200}.js"; export const a${i} = () => next;`,
        ),
      );
    const result = await emit(modules);
    expect(result.bundled).toContain("a199");
  });

  test("wasm, python, an unknown module type and the service-worker format", async () => {
    for (const type of ["wasm", "python", "elf"]) {
      // SAFETY: a client can send any string as a module type; the emitter must refuse the ones outside ModuleType.
      const unchecked = type as "esm";
      const error = await refusal(
        emitFromBundle(
          { modules: [esm("index.js", HANDLER), { name: "x", type: unchecked, content: "" }], metadata: meta() },
          { name: "app" },
        ),
      );
      expect(error.reason).toBe("module-type-unsupported");
    }
    expect((await refusal(emit([esm("index.js", HANDLER)], meta({ body_part: "script" })))).reason).toBe(
      "service-worker-unsupported",
    );
  });

  test("unknown binding types and every refused Cloudflare type", async () => {
    for (const type of [
      "ai",
      "browser",
      "hyperdrive",
      "vectorize",
      "workflow",
      "send_email",
      "wasm_module",
      "inherit",
      "teleporter",
    ]) {
      const error = await refusal(emit([esm("index.js", HANDLER)], meta({ bindings: [{ type, name: "X" }] })));
      expect(error.reason).toBe("binding-type-unsupported");
    }
  });

  test("unknown compatibility flags are refused (D5)", async () => {
    const error = await refusal(
      emit([esm("index.js", HANDLER)], meta({ compatibility_flags: ["nodejs_compat", "export_commonjs_default"] })),
    );
    expect(error.reason).toBe("flag-unsupported");
    expect(error.message).toContain("export_commonjs_default");
  });

  test("migrations with rename, delete and transfer are refused (D7); new classes are kept", async () => {
    for (const step of [
      { renamed_classes: [{ from: "A", to: "B" }] },
      { deleted_classes: ["A"] },
      { transferred_classes: [{ from: "A", from_script: "x", to: "B" }] },
    ]) {
      const error = await refusal(
        emit([esm("index.js", HANDLER)], meta({ migrations: { new_tag: "v2", steps: [step] } })),
      );
      expect(error.reason).toBe("migration-unsupported");
    }
    const ok = await emit(
      [esm("index.js", HANDLER)],
      meta({ migrations: { new_tag: "v1", steps: [{ new_sqlite_classes: ["Room"] }] } }),
    );
    expect(ok.metadata.migrations).toEqual({ new_tag: "v1", steps: [{ new_sqlite_classes: ["Room"] }] });
  });

  test("a bundle the capability check rejects names the rule", async () => {
    const error = await refusal(
      emit(
        [esm("index.js", `export default { fetch() { return new Response(process.cwd() + Bun.version); } };`)],
        meta({ compatibility_date: "2026-11-10" }),
      ),
    );
    expect(error.reason).toBe("capability-check");
    expect(error.message).toContain("Node, Bun, and Deno APIs are not supported");
  });

  test("a module with no handler is refused", async () => {
    expect((await refusal(emit([esm("index.js", `export const x = 1;`)]))).reason).toBe("capability-check");
  });

  test("a compatibility date past the generation is refused", async () => {
    const error = await refusal(
      emitFromBundle(
        { modules: [esm("index.js", HANDLER)], metadata: meta({ compatibility_date: "2026-12-01" }) },
        { name: "app", validation: { maxCompatibilityDate: "2026-11-23" } },
      ),
    );
    expect(error.reason).toBe("compat-date-invalid");
  });
});

describe("review findings", () => {
  test("nodejs_als alone gives AsyncLocalStorage and no other built-in", async () => {
    const als = `import { AsyncLocalStorage } from "node:async_hooks"; export default { fetch() { return new Response(String(new AsyncLocalStorage().run(1, () => 1))); } };`;
    const old = meta({ compatibility_date: "2026-08-03", compatibility_flags: ["nodejs_als"] });
    expect((await emit([esm("index.js", als), esm("b.js", "export {};")], old)).bundled).toContain("AsyncLocalStorage");
    const buffer = `import { Buffer } from "node:buffer"; export default { fetch() { return new Response(Buffer.name); } };`;
    expect((await refusal(emit([esm("index.js", buffer)], old))).reason).toBe("no-such-module");
  });

  test("node:path exports posix by name as well as on the default export", async () => {
    const source = `import path, { posix } from "node:path"; export default { fetch() { return new Response(posix.join("a", "b") + path.posix.sep); } };`;
    const result = await emit([esm("index.js", source), esm("b.js", "export {};")]);
    expect(result.bundled).toContain("posix");
    expect(result.bundled).not.toMatch(/^import /m);
  });

  test("a builtin-named function expression is renamed in code, never inside a string", async () => {
    const source = `import "./lib.js"; export const note = "return function parseInt(x) {}"; export const f = function parseInt(x) { return x; }; export default { fetch() { return new Response(note + f(1)); } };`;
    const result = await emit([esm("index.js", source), esm("lib.js", "export {};")]);
    expect(result.bundled).toContain('"return function parseInt(x) {}"');
    expect(result.bundled).toContain("function parseInt_sb(x)");
  });

  test("a computed import() is not a way past the bundler: the source check refuses it", async () => {
    const source = `export default { async fetch(request) { const name = new URL(request.url).pathname; return new Response(String(await import(name))); } };`;
    const error = await refusal(emit([esm("index.js", source), esm("secret.js", "export default 1;")]));
    expect(error.reason).toBe("capability-check");
    expect(error.message).toContain("dynamic import() is not supported");
  });
});
