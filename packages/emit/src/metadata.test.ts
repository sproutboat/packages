import { describe, expect, test } from "bun:test";
import schema from "../schema/worker-metadata.schema.json";
import {
  ACCEPTED_BINDING_TYPES,
  ASSETS_STORE_MIN_DATE,
  IGNORED_METADATA_FIELDS,
  MODULE_TYPES,
  REFUSED_BINDING_TYPES,
  SUPPORTED_COMPATIBILITY_FLAGS,
  WORKERS_COMPAT_FLOOR,
  secretValues,
  stripSecretValues,
  validateMetadata,
  validateModules,
  type WorkerBinding,
} from "./index";

const base = { main_module: "index.js", compatibility_date: "2026-11-22" };
const ok = (input: Parameters<typeof validateMetadata>[0], options?: Parameters<typeof validateMetadata>[1]) => {
  const result = validateMetadata(input, options);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join("; "));
  return result;
};
const refusal = (input: Parameters<typeof validateMetadata>[0], options?: Parameters<typeof validateMetadata>[1]) => {
  const result = validateMetadata(input, options);
  if (result.ok) throw new Error("expected a refusal");
  return result.errors;
};

describe("schema file", () => {
  test("lists exactly the accepted binding types, module types, flags and fields", () => {
    const types = schema.$defs.binding.oneOf.map((entry) => entry.properties.type.const).sort();
    expect(types).toEqual([...ACCEPTED_BINDING_TYPES].sort());
    expect([...schema.$defs.module.properties.type.enum].sort()).toEqual([...MODULE_TYPES].sort());
    expect([...schema.properties.compatibility_flags.items.enum].sort()).toEqual(
      [...SUPPORTED_COMPATIBILITY_FLAGS].sort(),
    );
    for (const field of IGNORED_METADATA_FIELDS) expect(Object.keys(schema.properties)).toContain(field);
    expect(schema.properties.compatibility_flags.items.enum).not.toContain("wasm");
  });
  test("a service binding's environment: the schema takes what the validator takes (production), nothing else", () => {
    const service = schema.$defs.binding.oneOf.find((entry) => entry.properties.type.const === "service");
    expect(service?.properties).toHaveProperty("environment", { const: "production" });
    const binding = (environment: string) => ({ type: "service", name: "BILLING", service: "billing", environment });
    expect(ok({ ...base, bindings: [binding("production")] }).value.bindings).toHaveLength(1);
    expect(refusal({ ...base, bindings: [binding("staging")] })[0]?.reason).toBe("binding-invalid");
  });
  test("accepted and refused binding types do not overlap", () => {
    for (const type of REFUSED_BINDING_TYPES)
      expect(ACCEPTED_BINDING_TYPES.some((accepted) => accepted === type)).toBe(false);
  });
});

describe("validateMetadata, dates and serialisation", () => {
  const old = { ...base, compatibility_date: "2026-11-20" };
  test("a floor newer than the newest date the builder knows is refused, not emitted", () => {
    const errors = refusal(old, { maxCompatibilityDate: "2026-11-21", compatibilityFloor: "2026-11-22" });
    expect(errors[0]?.reason).toBe("compat-date-invalid");
    expect(errors[0]?.message).toContain(
      "builds as 2026-11-22, which is newer than the newest date this builder knows, 2026-11-21",
    );
  });
  test("a floor in the future is refused", () => {
    const errors = refusal(old, { now: new Date("2026-11-21T10:00:00Z"), compatibilityFloor: "2026-11-22" });
    expect(errors[0]?.message).toContain("builds as 2026-11-22, which is in the future");
  });
  test("a floor inside both bounds still raises the date", () => {
    const result = ok(old, {
      now: new Date("2026-11-25T00:00:00Z"),
      maxCompatibilityDate: "2026-11-24",
      compatibilityFloor: "2026-11-22",
    });
    expect(result.value.compatibility_date).toBe("2026-11-22");
  });
  test("metadata that cannot be serialised is a refusal, not an exception (a cycle, a BigInt, nesting past the stack)", () => {
    type Nested = number | Nested[];
    let deep: Nested = 1;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    const cycle = { ...base, self: {} };
    cycle.self = cycle;
    // SAFETY: none of these is Json on purpose; a JavaScript caller can pass them, and validateMetadata must refuse them.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- none of these is Json on purpose: a JavaScript caller can pass them, and validateMetadata must refuse them.
    const inputs = [cycle, { ...base, big: 10n }, { ...base, deep }] as unknown as Parameters<
      typeof validateMetadata
    >[0][];
    for (const input of inputs)
      expect(refusal(input)[0]).toEqual({
        reason: "metadata-invalid",
        message: "metadata cannot be serialized to JSON",
        path: "metadata",
      });
  });
});

describe("validateMetadata", () => {
  test("accepts the smallest upload", () => {
    const result = ok(base);
    expect(result.value).toEqual({
      ...base,
      declared_compatibility_date: base.compatibility_date,
      compatibility_flags: [],
      node: { compat: true, als: false, populateProcessEnv: true },
      bindings: [],
    });
    expect(result.warnings).toEqual([]);
  });

  test("accepts every binding type of the table", () => {
    const bindings: WorkerBinding[] = [
      { type: "plain_text", name: "MODE", text: "prod" },
      { type: "json", name: "CONFIG", json: { a: [1, 2] } },
      { type: "secret_text", name: "API_KEY" },
      { type: "kv_namespace", name: "CACHE", namespace_id: "ignored" },
      { type: "d1", name: "DB", id: "ignored" },
      { type: "r2_bucket", name: "FILES", bucket_name: "ignored" },
      { type: "queue", name: "JOBS", queue_name: "jobs" },
      { type: "durable_object_namespace", name: "ROOMS", class_name: "Room" },
      { type: "service", name: "AUTH", service: "auth" },
      { type: "analytics_engine", name: "EVENTS", dataset: "events" },
      { type: "ratelimit", name: "LIMIT", namespace_id: "1", simple: { limit: 5, period: 60 } },
      { type: "assets", name: "ASSETS" },
      { type: "version_metadata", name: "VERSION" },
    ];
    expect(ok({ ...base, bindings }).value.bindings).toEqual(bindings);
  });

  test("refuses each Cloudflare binding type with no equivalent, by name", () => {
    for (const type of REFUSED_BINDING_TYPES) {
      const [error] = refusal({ ...base, bindings: [{ type, name: "X" }] });
      expect(error?.reason).toBe("binding-type-unsupported");
      expect(error?.message).toContain(`"${type}"`);
    }
  });

  test("refuses an unknown binding type", () => {
    const [error] = refusal({ ...base, bindings: [{ type: "teleporter", name: "X" }] });
    expect(error?.reason).toBe("binding-type-unsupported");
    expect(error?.message).toBe('unknown binding type "teleporter"');
  });

  test("refuses bad names, duplicates and a script_name on a Durable Object", () => {
    expect(refusal({ ...base, bindings: [{ type: "assets", name: "__proto__" }] })[0]?.reason).toBe("binding-invalid");
    expect(refusal({ ...base, bindings: [{ type: "assets", name: "a-b" }] })[0]?.reason).toBe("binding-invalid");
    expect(
      refusal({
        ...base,
        bindings: [
          { type: "assets", name: "A" },
          { type: "version_metadata", name: "A" },
        ],
      })[0]?.message,
    ).toContain('two bindings are named "A"');
    const [error] = refusal({
      ...base,
      bindings: [{ type: "durable_object_namespace", name: "D", class_name: "C", script_name: "other" }],
    });
    expect(error?.message).toContain("no cross-app Durable Objects");
  });

  test("refuses a service entrypoint other than default and an R2 jurisdiction", () => {
    expect(
      refusal({ ...base, bindings: [{ type: "service", name: "S", service: "x", entrypoint: "Named" }] })[0]?.path,
    ).toBe("metadata.bindings[0].entrypoint");
    expect(refusal({ ...base, bindings: [{ type: "r2_bucket", name: "R", jurisdiction: "eu" }] })[0]?.reason).toBe(
      "binding-invalid",
    );
  });

  test("counts secrets, services and assets toward 64, not vars", () => {
    const vars = Array.from({ length: 100 }, (_, i) => ({ type: "plain_text", name: `V${i}`, text: "x" }));
    ok({ ...base, bindings: vars });
    const secrets = Array.from({ length: 65 }, (_, i) => ({ type: "secret_text", name: `S${i}` }));
    expect(refusal({ ...base, bindings: secrets })[0]?.reason).toBe("limit-exceeded");
    ok({ ...base, bindings: secrets.slice(0, 64) });
  });

  test("unknown compatibility flags are refused, naming the flag (D5)", () => {
    const [error] = refusal({ ...base, compatibility_flags: ["nodejs_compat", "brand_new_flag"] });
    expect(error?.reason).toBe("flag-unsupported");
    expect(error?.message).toContain('"brand_new_flag"');
    expect(
      ok({ ...base, compatibility_flags: ["nodejs_compat", "nodejs_als", "nodejs_compat"] }).value.compatibility_flags,
    ).toEqual(["nodejs_compat", "nodejs_als"]);
  });

  test("refuses service-worker format", () => {
    const [error] = refusal({ ...base, body_part: "script" });
    expect(error?.reason).toBe("service-worker-unsupported");
    expect(error?.message).toBe("service-worker format is not supported; upload an ES module");
  });

  describe("compatibility date", () => {
    test("is required and a real day", () => {
      expect(refusal({ main_module: "index.js" })[0]?.reason).toBe("compat-date-invalid");
      expect(refusal({ ...base, compatibility_date: "2026-02-30" })[0]?.reason).toBe("compat-date-invalid");
      expect(refusal({ ...base, compatibility_date: "yesterday" })[0]?.reason).toBe("compat-date-invalid");
    });
    test("refused in the future, or newer than the generation knows", () => {
      const now = new Date("2026-11-26T12:00:00Z");
      expect(refusal({ ...base, compatibility_date: "2026-11-27" }, { now })[0]?.message).toContain("in the future");
      expect(
        refusal({ ...base, compatibility_date: "2026-11-25" }, { maxCompatibilityDate: "2026-11-23" })[0]?.message,
      ).toContain("2026-11-23");
      ok({ ...base, compatibility_date: "2026-11-23" }, { now, maxCompatibilityDate: "2026-11-23" });
    });
    test("floors a Cloudflare date only when asked", () => {
      const old = { ...base, compatibility_date: "2025-06-01" };
      expect(ok(old).value.compatibility_date).toBe("2025-06-01");
      const floored = ok(old, { compatibilityFloor: WORKERS_COMPAT_FLOOR });
      expect(floored.value.compatibility_date).toBe(WORKERS_COMPAT_FLOOR);
      expect(floored.warnings.join()).toContain("the build uses 2026-11-22");
    });
    test("an assets binding needs the asset store date when asked", () => {
      const old = { ...base, compatibility_date: "2026-11-18", bindings: [{ type: "assets", name: "ASSETS" }] };
      ok(old);
      expect(refusal(old, { assetStoreMinDate: ASSETS_STORE_MIN_DATE })[0]?.reason).toBe("assets-date-unsupported");
      const firstOnly = {
        ...base,
        compatibility_date: "2026-11-18",
        assets: { config: { run_worker_first: ["/api/*"] } },
      };
      expect(refusal(firstOnly, { assetStoreMinDate: ASSETS_STORE_MIN_DATE })[0]?.reason).toBe(
        "assets-date-unsupported",
      );
      ok(
        { ...base, compatibility_date: "2026-11-18", assets: { config: { not_found_handling: "none" } } },
        { assetStoreMinDate: ASSETS_STORE_MIN_DATE },
      );
    });
  });

  describe("migrations (D7)", () => {
    test("accepts new_classes and new_sqlite_classes, as steps or as one flat step", () => {
      const steps = ok({
        ...base,
        migrations: {
          old_tag: "v1",
          new_tag: "v2",
          steps: [{ new_sqlite_classes: ["Room"] }, { new_classes: ["Counter"] }],
        },
      }).value.migrations;
      expect(steps).toEqual({
        old_tag: "v1",
        new_tag: "v2",
        steps: [{ new_sqlite_classes: ["Room"] }, { new_classes: ["Counter"] }],
      });
      expect(ok({ ...base, migrations: { new_tag: "v1", new_classes: ["A"] } }).value.migrations).toEqual({
        new_tag: "v1",
        steps: [{ new_classes: ["A"] }],
      });
      expect(ok({ ...base, migrations: { steps: [{ renamed_classes: [] }] } }).value.migrations?.steps).toEqual([{}]);
    });
    test("refuses rename, delete and transfer, in a step and flat", () => {
      for (const key of ["renamed_classes", "deleted_classes", "transferred_classes"]) {
        const value = key === "deleted_classes" ? ["Old"] : [{ from: "A", to: "B" }];
        const inStep = refusal({ ...base, migrations: { new_tag: "v2", steps: [{ [key]: value }] } });
        expect(inStep[0]?.reason).toBe("migration-unsupported");
        expect(inStep[0]?.path).toBe(`metadata.migrations.steps[0].${key}`);
        expect(refusal({ ...base, migrations: { new_tag: "v2", [key]: value } })[0]?.reason).toBe(
          "migration-unsupported",
        );
      }
    });
  });

  test("crons are normalised and checked; consumers must name a bound queue", () => {
    expect(ok({ ...base, triggers: { crons: ["0  3 * * *"] } }).value.triggers).toEqual({ crons: ["0 3 * * *"] });
    expect(refusal({ ...base, triggers: { crons: ["* * *"] } })[0]?.reason).toBe("metadata-invalid");
    expect(refusal({ ...base, triggers: { crons: Array.from({ length: 17 }, () => "* * * * *") } })[0]?.reason).toBe(
      "limit-exceeded",
    );
    const queue = { type: "queue", name: "JOBS", queue_name: "jobs" };
    expect(
      ok({ ...base, bindings: [queue], queue_consumers: [{ queue: "jobs", max_batch_size: 10 }] }).value
        .queue_consumers,
    ).toEqual([{ queue: "jobs", max_batch_size: 10 }]);
    expect(refusal({ ...base, queue_consumers: [{ queue: "jobs" }] })[0]?.message).toContain("does not bind");
    expect(
      refusal({ ...base, bindings: [queue], queue_consumers: [{ queue: "jobs", max_retries: 101 }] })[0]?.reason,
    ).toBe("metadata-invalid");
  });

  test("assets config: known values, html_handling default only, no jwt", () => {
    const config = {
      not_found_handling: "single-page-application" as const,
      run_worker_first: ["/api/*"],
      _headers: "/*\n  X-A: 1",
      _redirects: "/a /b 301",
    };
    expect(ok({ ...base, assets: { config } }).value.assets).toEqual({ config });
    expect(refusal({ ...base, assets: { config: { html_handling: "force-trailing-slash" } } })[0]?.message).toContain(
      "force-trailing-slash",
    );
    expect(refusal({ ...base, assets: { jwt: "x" } })[0]?.path).toBe("metadata.assets.jwt");
  });

  test("ignored fields warn once; unknown fields refuse; annotations carry the message", () => {
    const result = ok({
      ...base,
      observability: { enabled: true },
      tags: ["a"],
      annotations: { "workers/message": "deploy 7" },
    });
    expect(result.warnings).toEqual(["ignored: observability, tags, annotations (no effect on Sproutboat Cloud)"]);
    expect(result.value.message).toBe("deploy 7");
    expect(refusal({ ...base, surprise: 1 })[0]?.message).toBe("unknown metadata field: surprise");
  });

  test("main_module must match the bundle's, and metadata is capped at 256 KiB", () => {
    expect(refusal(base, { bundleMainModule: "other.js" })[0]?.message).toContain("does not match");
    const big = { ...base, annotations: { note: "x".repeat(256 * 1024) } };
    expect(refusal(big)[0]?.reason).toBe("limit-exceeded");
  });

  test("keep_bindings accepts secret_text only", () => {
    expect(ok({ ...base, keep_bindings: ["secret_text"] }).value.keep_bindings).toEqual(["secret_text"]);
    expect(refusal({ ...base, keep_bindings: ["kv_namespace"] })[0]?.reason).toBe("binding-type-unsupported");
  });
});

describe("secrets", () => {
  const metadata = ok({
    ...base,
    bindings: [
      { type: "secret_text", name: "A", text: "value-a" },
      { type: "secret_text", name: "B" },
      { type: "plain_text", name: "C", text: "plain" },
    ],
  }).value;
  test("values come out for sealing, and strip leaves names only", () => {
    expect([...secretValues(metadata)]).toEqual([["A", "value-a"]]);
    const stripped = stripSecretValues(metadata);
    expect(JSON.stringify(stripped)).not.toContain("value-a");
    expect(stripped.bindings.map((b) => b.name)).toEqual(["A", "B", "C"]);
  });
});

describe("validateModules", () => {
  const esm = (name: string, content = "export default 1") => ({ name, type: "esm" as const, content });
  test("accepts a normal bundle", () => {
    expect(
      validateModules([esm("index.js"), esm("chunks/a.js"), { name: "q.sql", type: "text", content: "x" }], {
        mainModule: "index.js",
      }),
    ).toEqual([]);
  });
  test("refuses path traversal and absolute names", () => {
    for (const name of [
      "../x.js",
      "a/../../x.js",
      "/etc/passwd",
      "a//b.js",
      "./a.js",
      "a\\b.js",
      "a\0b.js",
      "",
      "a/",
    ]) {
      const [error] = validateModules([esm(name)]);
      expect(error?.reason).toBe("module-invalid");
    }
    expect(validateModules([esm("x".repeat(257))])[0]?.reason).toBe("module-invalid");
  });
  test("refuses wasm, python and unknown types, names the module", () => {
    expect(validateModules([{ name: "a.wasm", type: "wasm" }])[0]?.message).toContain("WebAssembly");
    expect(validateModules([{ name: "a.py", type: "python" }])[0]?.message).toContain("Python");
    expect(validateModules([{ name: "a", type: "elf" }])[0]?.reason).toBe("module-type-unsupported");
  });
  test("caps: 257 modules, 8 MiB of code, 1 MiB data module", () => {
    expect(validateModules(Array.from({ length: 257 }, (_, i) => esm(`m${i}.js`)))[0]?.reason).toBe("limit-exceeded");
    expect(validateModules([esm("a.js", "x".repeat(8 * 1024 * 1024 + 1))])[0]?.reason).toBe("limit-exceeded");
    expect(validateModules([esm("a.js", "x".repeat(8 * 1024 * 1024))])).toEqual([]);
    expect(validateModules([{ name: "d", type: "data", content: new Uint8Array(1024 * 1024 + 1) }])[0]?.reason).toBe(
      "limit-exceeded",
    );
    expect(validateModules([{ name: "d", type: "data", content: new Uint8Array(1024 * 1024) }])).toEqual([]);
  });
  test("main_module must be an uploaded esm module; duplicates refuse", () => {
    expect(validateModules([esm("a.js")], { mainModule: "b.js" })[0]?.reason).toBe("module-missing");
    expect(validateModules([{ name: "a.js", type: "cjs" }], { mainModule: "a.js" })[0]?.reason).toBe(
      "module-type-unsupported",
    );
    expect(validateModules([esm("a.js"), esm("a.js")])[0]?.message).toContain("two modules");
    expect(validateModules([])[0]?.reason).toBe("module-missing");
  });
  test("a digest, when present, is 64 hex characters", () => {
    expect(validateModules([{ name: "a.js", type: "esm", sha256: "abc" }])[0]?.reason).toBe("module-invalid");
    expect(validateModules([{ name: "a.js", type: "esm", sha256: "a".repeat(64) }])).toEqual([]);
  });
});

describe("review findings", () => {
  test("one assets binding and one version metadata binding", () => {
    const two = (type: string) => [
      { type, name: "A" },
      { type, name: "B" },
    ];
    expect(refusal({ ...base, bindings: two("assets") })[0]?.message).toBe("an upload has at most one assets binding");
    expect(refusal({ ...base, bindings: two("version_metadata") })[0]?.message).toContain("version_metadata");
  });

  test("a service binding names the app of its project: another environment is refused", () => {
    const service = (environment: string) => ({
      ...base,
      bindings: [{ type: "service", name: "S", service: "x", environment }],
    });
    ok(service("production"));
    expect(refusal(service("staging"))[0]?.path).toBe("metadata.bindings[0].environment");
  });

  test("migrations take steps or one flat step, never both", () => {
    expect(refusal({ ...base, migrations: { steps: [], deleted_classes: ["Old"] } })[0]?.message).toContain(
      "mixes steps with deleted_classes",
    );
    expect(refusal({ ...base, migrations: { steps: [{ new_classes: ["A"] }], new_classes: ["B"] } })[0]?.reason).toBe(
      "metadata-invalid",
    );
  });

  test("two consumers of one queue are refused whatever the case", () => {
    const queue = { type: "queue", name: "JOBS", queue_name: "jobs" };
    const errors = refusal({ ...base, bindings: [queue], queue_consumers: [{ queue: "jobs" }, { queue: "JOBS" }] });
    expect(errors[0]?.message).toContain('"JOBS" twice');
  });
});
