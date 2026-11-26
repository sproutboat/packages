import { describe, expect, test } from "bun:test";
import { runBundle } from "../test/run-bundle";
import {
  ASSETS_STORE_MIN_DATE,
  EmitError,
  WORKERS_COMPAT_FLOOR,
  emitForCloud,
  emitLocal,
  resolveNodeFlags,
  validateMetadata,
  type CloudEmitOptions,
  type EmitReason,
  type JsonObject,
  type ModuleInput,
} from "./index";

const esm = (name: string, content: string): ModuleInput => ({ name, type: "esm", content });
const HANDLER = `export default { fetch() { return new Response("ok"); } };`;
const NOW = new Date("2026-11-26T12:00:00Z");
const CLOUD: CloudEmitOptions["validation"] = {
  now: NOW,
  maxCompatibilityDate: "2026-11-26",
  compatibilityFloor: WORKERS_COMPAT_FLOOR,
  assetStoreMinDate: ASSETS_STORE_MIN_DATE,
};
const meta = (extra: JsonObject = {}) => ({ main_module: "index.js", compatibility_date: "2026-09-01", ...extra });
const cloud = (modules: ModuleInput[], metadata: JsonObject) =>
  emitForCloud({ modules, metadata }, { name: "app", validation: CLOUD });

async function refusal(run: Promise<unknown>): Promise<{ reason: EmitReason; message: string }> {
  try {
    await run;
  } catch (error) {
    if (error instanceof EmitError) return { reason: error.reason, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("Node support is decided from the declared date, never from the floored one (S4)", () => {
  const bufferUser = `import { Buffer } from "node:buffer"; export default { fetch() { return new Response(String(Buffer.from("x").length)); } };`;

  test("an upload dated 2025-01-01 with no nodejs_compat has no node: imports, as on Cloudflare", async () => {
    const error = await refusal(
      cloud([esm("index.js", bufferUser), esm("b.js", "export {};")], meta({ compatibility_date: "2025-01-01" })),
    );
    expect(error.reason).toBe("no-such-module");
    expect(error.message).toContain('No such module "node:buffer"');
  });

  test("the floor still moves the runtime generation, and keeps the declared date beside it", async () => {
    const result = await cloud([esm("index.js", HANDLER)], meta({ compatibility_date: "2025-01-01" }));
    expect(result.metadata.compatibility_date).toBe(WORKERS_COMPAT_FLOOR);
    expect(result.metadata.declared_compatibility_date).toBe("2025-01-01");
    expect(result.metadata.node).toEqual({ compat: false, als: false, populateProcessEnv: false });
    expect(result.region).toContain(`__sbCompat = "${WORKERS_COMPAT_FLOOR}"`);
  });

  test("the same date with the flag does get Node, and free Buffer and process", async () => {
    const result = await cloud(
      [esm("index.js", bufferUser)],
      meta({ compatibility_date: "2025-01-01", compatibility_flags: ["nodejs_compat"] }),
    );
    expect(result.metadata.node.compat).toBe(true);
    expect(result.bundled).not.toMatch(/^import .*node:/m);
  });

  // Cloudflare: a JSON binding that is not a string is the raw JSON string in process.env; a JSON string is exposed parsed.
  const reads = `export default { fetch() { const raw = process.env.CFG; return new Response([process.env.A, typeof raw, raw, raw === undefined ? undefined : JSON.parse(raw).x[1], process.env.N, process.env.Q, process.env.S, process.env.NOPE].map(String).join("|")); } };`;
  const expectedBody = 'a|string|{"x":[1,2]}|2|42|quoted|secret!|undefined';
  const bindings = [
    { type: "plain_text", name: "A", text: "a" },
    { type: "json", name: "CFG", json: { x: [1, 2] } },
    { type: "json", name: "N", json: 42 },
    { type: "json", name: "Q", json: "quoted" },
    { type: "secret_text", name: "S" },
  ];
  const env = () => {
    const value = { A: "a", CFG: { x: [1, 2] }, N: 42, Q: "quoted", NOPE: "not a text binding" };
    Object.defineProperty(value, "S", { get: () => "secret!", enumerable: true });
    return value;
  };

  test("an upload dated 2026-09-01 (Alchemy's fixture date) reads text, JSON and secret bindings from process.env", async () => {
    const result = await cloud([esm("index.js", reads)], meta({ bindings }));
    expect(result.metadata.node).toEqual({ compat: true, als: false, populateProcessEnv: true });
    const answer = await runBundle(result.bundled, env());
    expect(answer.body).toBe(expectedBody);
  });

  test("a value written to a bound name is stored as a string, as on Cloudflare (a name nothing binds is a plain property)", async () => {
    const writes = `export default { fetch() { process.env.A = 5; process.env.CFG = { y: 1 }; process.env.A = process.env.A + 1; process.env.EXTRA = 7; return new Response([typeof process.env.A, process.env.A, process.env.CFG, typeof process.env.EXTRA].join("|")); } };`;
    const result = await cloud([esm("index.js", writes)], meta({ bindings }));
    expect((await runBundle(result.bundled, env())).body).toBe("string|51|[object Object]|number");
  });

  test("import process from node:process is the same object as the free process", async () => {
    const imported = `import process, { env } from "node:process"; export default { fetch() { return new Response(String(process.env.A) + String(env === process.env)); } };`;
    const result = await cloud([esm("index.js", imported)], meta({ bindings }));
    expect((await runBundle(result.bundled, env())).body).toBe("atrue");
  });

  test("nodejs_compat_populate_process_env is honoured, not accepted as a no-op", async () => {
    const modules = [esm("index.js", reads)];
    const on = await cloud(
      modules,
      meta({
        compatibility_date: "2025-03-31",
        compatibility_flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
        bindings,
      }),
    );
    expect((await runBundle(on.bundled, env())).body).toBe(expectedBody);
    // Before 2025-04-01 the default is off, as on Cloudflare.
    const off = await cloud(
      modules,
      meta({ compatibility_date: "2025-03-31", compatibility_flags: ["nodejs_compat"], bindings }),
    );
    expect((await runBundle(off.bundled, env())).body).toBe(
      "undefined|undefined|undefined|undefined|undefined|undefined|undefined|undefined",
    );
    const optedOut = await cloud(
      modules,
      meta({ compatibility_flags: ["nodejs_compat_do_not_populate_process_env"], bindings }),
    );
    expect(optedOut.metadata.node.populateProcessEnv).toBe(false);
    expect((await runBundle(optedOut.bundled, env())).body).toBe(
      "undefined|undefined|undefined|undefined|undefined|undefined|undefined|undefined",
    );
  });

  test("before 2024-09-23 nodejs_compat alone is Node.js compatibility v1, which is refused; v2 needs its own flag", () => {
    const refused = resolveNodeFlags(["nodejs_compat"], "2024-09-22");
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.message).toContain("compatibility v1");
    expect(resolveNodeFlags(["nodejs_compat", "nodejs_compat_v2"], "2024-09-22").ok).toBe(true);
    expect(resolveNodeFlags(["nodejs_compat_v2"], "2024-09-22").ok).toBe(true);
    expect(resolveNodeFlags(["nodejs_compat"], "2024-09-23").ok).toBe(true);
    expect(resolveNodeFlags([], "2024-09-22").ok).toBe(true);
  });

  test("the date table of flags.ts", () => {
    const node = (flags: string[], date: string) => {
      const resolved = resolveNodeFlags(flags, date);
      if (!resolved.ok) throw new Error(resolved.message);
      return resolved.value;
    };
    expect(node([], "2026-08-03").compat).toBe(false);
    expect(node([], "2026-08-04").compat).toBe(true);
    expect(node(["nodejs_compat"], "2024-09-23")).toEqual({ compat: true, als: false, populateProcessEnv: false });
    expect(node(["nodejs_compat"], "2025-03-31").populateProcessEnv).toBe(false);
    expect(node(["nodejs_compat"], "2025-04-01").populateProcessEnv).toBe(true);
    expect(node(["no_nodejs_compat"], "2026-09-01").compat).toBe(false);
    expect(node(["no_nodejs_compat", "no_nodejs_compat_v2"], "2026-09-01").compat).toBe(false);
    expect(node(["nodejs_als"], "2026-01-01")).toEqual({ compat: false, als: true, populateProcessEnv: false });
    expect(node(["nodejs_compat_populate_process_env"], "2026-01-01").populateProcessEnv).toBe(false);
  });

  test("the opt-out flags Cloudflare documents are accepted, and each one takes effect", async () => {
    const error = await refusal(
      cloud(
        [esm("index.js", bufferUser), esm("b.js", "export {};")],
        meta({ compatibility_flags: ["no_nodejs_compat", "no_nodejs_compat_v2"] }),
      ),
    );
    expect(error.reason).toBe("no-such-module");
    const legacy = await cloud([esm("index.js", HANDLER)], meta({ compatibility_flags: ["legacy_module_registry"] }));
    expect(legacy.metadata.compatibility_flags).toEqual(["legacy_module_registry"]);
    expect(
      validateMetadata(meta({ compatibility_flags: ["no_nodejs_als"], compatibility_date: "2026-01-01" })).ok,
    ).toBe(true);
  });

  test("a flag that cannot be honoured, or contradicts another, is refused by name", async () => {
    const refused = async (flags: string[], date = "2026-09-01") =>
      refusal(cloud([esm("index.js", HANDLER)], meta({ compatibility_date: date, compatibility_flags: flags })));
    expect((await refused(["no_nodejs_compat_v2"])).message).toContain("Node.js compatibility v1");
    expect((await refused(["nodejs_compat", "no_nodejs_compat_v2"], "2025-01-01")).message).toContain("v1");
    expect((await refused(["nodejs_compat", "no_nodejs_compat"])).message).toContain("contradict");
    expect((await refused(["nodejs_als", "no_nodejs_als"])).reason).toBe("flag-unsupported");
    expect((await refused(["new_module_registry", "legacy_module_registry"])).message).toContain(
      "legacy_module_registry",
    );
    expect(
      (await refused(["nodejs_compat_populate_process_env", "nodejs_compat_do_not_populate_process_env"])).reason,
    ).toBe("flag-unsupported");
    expect((await refused(["no_nodejs_als"])).message).toContain("AsyncLocalStorage");
  });
});

describe("the Cloud entry point cannot be called without its safety options (S5)", () => {
  const modules = [esm("index.js", HANDLER)];
  const assets = meta({ compatibility_date: "2025-01-01", bindings: [{ type: "assets", name: "ASSETS" }] });

  test("a JavaScript caller that leaves one out is stopped, whichever it is", async () => {
    for (const field of ["now", "maxCompatibilityDate", "compatibilityFloor", "assetStoreMinDate"] as const) {
      const { [field]: _omitted, ...partial } = CLOUD;
      const options = { name: "app", validation: partial };
      let thrown: unknown;
      try {
        // @ts-expect-error -- the test plays an untyped caller that forgot a field the type requires.
        await emitForCloud({ modules, metadata: meta() }, options);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect(String(thrown)).toContain(field);
    }
  });

  test("a bad date in an option is as bad as a missing one", async () => {
    const options = { name: "app", validation: { ...CLOUD, compatibilityFloor: "soon" } };
    await expect(emitForCloud({ modules, metadata: meta() }, options)).rejects.toBeInstanceOf(TypeError);
  });

  test("a future date and a date past the generation are refused", async () => {
    expect((await refusal(cloud(modules, meta({ compatibility_date: "2026-11-27" })))).message).toContain(
      "in the future",
    );
    const options = { name: "app", validation: { ...CLOUD, maxCompatibilityDate: "2026-11-23" } };
    expect(
      (await refusal(emitForCloud({ modules, metadata: meta({ compatibility_date: "2026-11-25" }) }, options))).message,
    ).toContain("2026-11-23");
  });

  test("an assets binding below the asset store date is refused once the floor is no higher than it", async () => {
    const options = { name: "app", validation: { ...CLOUD, compatibilityFloor: "2026-11-10" } };
    const error = await refusal(emitForCloud({ modules, metadata: assets }, options));
    expect(error.reason).toBe("assets-date-unsupported");
  });

  test("with the standard floor, the same old assets date builds as the floor, which reads the store", async () => {
    const result = await cloud(modules, assets);
    expect(result.metadata.compatibility_date).toBe(WORKERS_COMPAT_FLOOR);
    expect(result.warnings.join("\n")).toContain("the build uses 2026-11-22");
  });

  test("the local entry point is the one that leaves checks out, and says so in its name", async () => {
    const result = await emitLocal({ modules, metadata: assets }, { name: "app" });
    expect(result.metadata.compatibility_date).toBe("2025-01-01");
  });
});

describe("review nits", () => {
  test("a json var with a __proto__ key, at any depth, is refused (N2)", async () => {
    // JSON.parse makes __proto__ an own key, as the upload would carry it; an object literal would set a prototype instead.
    const raws = [
      '{"type":"json","name":"CFG","json":{"__proto__":{"polluted":1}}}',
      '{"type":"json","name":"CFG","json":{"a":[{"b":{"__proto__":1}}]}}',
    ];
    for (const raw of raws) {
      const error = await refusal(cloud([esm("index.js", HANDLER)], meta({ bindings: [JSON.parse(raw)] })));
      expect(error.reason).toBe("binding-invalid");
      expect(error.message).toContain("__proto__");
    }
  });

  test("fields no binding of that type reads are refused, not dropped (N6)", async () => {
    const refused = async (binding: JsonObject) =>
      refusal(cloud([esm("index.js", HANDLER)], meta({ bindings: [binding] })));
    expect((await refused({ type: "kv_namespace", name: "K", bogus: 1 })).message).toContain("bindings[0].bogus");
    const consumer = async (entry: JsonObject) =>
      refusal(
        cloud(
          [esm("index.js", HANDLER)],
          meta({
            bindings: [{ type: "queue", name: "Q", queue_name: "jobs" }],
            queue_consumers: [{ queue: "jobs", ...entry }],
          }),
        ),
      );
    expect((await consumer({ max_concurrency: 4 })).message).toContain("max_concurrency");
    expect((await consumer({ max_batch_size: 2.5 })).message).toContain("whole number");
    expect((await consumer({ max_retries: 1.5 })).message).toContain("whole number");
    const config = (extra: JsonObject) =>
      refusal(cloud([esm("index.js", HANDLER)], meta({ assets: { config: extra } })));
    expect((await config({ serve_directly: true })).message).toContain("serve_directly");
  });

  test("a stored secret needs a binding name, and cannot take another binding's name (N7)", async () => {
    const withSecrets = (extraSecretNames: string[], bindings: JsonObject[] = []) =>
      emitForCloud(
        { modules: [esm("index.js", HANDLER)], metadata: meta({ bindings }) },
        { name: "app", validation: CLOUD, extraSecretNames },
      );
    expect((await refusal(withSecrets(["not a name"]))).reason).toBe("binding-invalid");
    expect((await refusal(withSecrets(["__proto__"]))).reason).toBe("binding-invalid");
    const collision = await refusal(withSecrets(["CACHE"], [{ type: "kv_namespace", name: "CACHE" }]));
    expect(collision.message).toContain("kv_namespace");
    const same = await withSecrets(["API"], [{ type: "secret_text", name: "API" }]);
    expect(same.bindings.runtime.secrets).toEqual(["API"]);
  });
});
