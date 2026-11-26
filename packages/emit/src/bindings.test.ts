import { describe, expect, test } from "bun:test";
import { deriveBindings, EmitError, validateMetadata, type JsonObject } from "./index";

const derive = (extra: JsonObject, options?: Parameters<typeof deriveBindings>[1]) => {
  const checked = validateMetadata({ main_module: "index.js", compatibility_date: "2026-11-23", ...extra });
  if (!checked.ok) throw new Error(checked.errors.map((e) => e.message).join("; "));
  return deriveBindings(checked.value, options);
};

describe("deriveBindings", () => {
  test("a queue is consumed only when the upload declares a consumer (D4)", () => {
    const queue = { type: "queue", name: "JOBS", queue_name: "Jobs" };
    expect(derive({ bindings: [queue] }).record.queue_consumers).toEqual([]);
    const withConsumer = derive({
      bindings: [queue],
      queue_consumers: [{ queue: "jobs", max_batch_size: 5, max_batch_timeout: 2, dead_letter_queue: "Dead" }],
    });
    expect(withConsumer.record.queue_consumers).toEqual([
      { queue: "jobs", max_batch_size: 5, max_batch_timeout_ms: 2000, max_retries: 3, dead_letter_queue: "dead" },
    ]);
    expect(withConsumer.runtime.queueConfig).toEqual([
      { binding: "JOBS", queue: "Jobs", maxBatchSize: 5, maxBatchTimeout: 2, deadLetterQueue: "Dead" },
    ]);
    expect(withConsumer.record.bindings).toEqual([
      { name: "JOBS", kind: "queue", resource_id: "jobs", config: { queue: "Jobs" } },
    ]);
  });

  test("storage ids are ignored with one warning; the baked resources map keeps them", () => {
    const derived = derive({
      bindings: [
        { type: "kv_namespace", name: "CACHE", namespace_id: "kv_1" },
        { type: "d1", name: "DB", id: "d1_1" },
        { type: "r2_bucket", name: "FILES" },
      ],
    });
    expect(derived.record.bindings.map((b) => `${b.kind}:${b.name}:${b.resource_id}`)).toEqual([
      "kv:CACHE:cache",
      "d1:DB:db",
      "r2:FILES:files",
    ]);
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain("kv_namespaces.CACHE, d1_databases.DB");
    expect(derived.runtime.resources).toEqual({ CACHE: { kind: "kv", id: "kv_1" }, DB: { kind: "d1", id: "d1_1" } });
  });

  test("a name that cannot be a Cloud resource id is refused, and so are two bindings of one queue", () => {
    expect(() => derive({ bindings: [{ type: "kv_namespace", name: "_CACHE" }] })).toThrow(EmitError);
    const twice = [
      { type: "queue", name: "A", queue_name: "same" },
      { type: "queue", name: "B", queue_name: "SAME" },
    ];
    expect(() => derive({ bindings: twice })).toThrow("two bindings name the queue");
  });

  test("services count toward 64 and are resolved by the API: the record carries the project", () => {
    const derived = derive({ bindings: [{ type: "service", name: "AUTH", service: "auth" }] });
    expect(derived.record.services).toEqual([{ name: "AUTH", service: "auth" }]);
    expect(derived.runtime.services).toEqual([{ binding: "AUTH", service: "auth" }]);
    const many = Array.from({ length: 64 }, (_, i) => ({ type: "kv_namespace", name: `K${i}` }));
    expect(() => derive({ bindings: [...many, { type: "service", name: "S", service: "s" }] })).toThrow("at most 64");
  });

  test("vars keep their JSON type; version metadata is named, not baked here", () => {
    const derived = derive({
      bindings: [
        { type: "plain_text", name: "MODE", text: "prod" },
        { type: "json", name: "LIMITS", json: { a: [1] } },
        { type: "version_metadata", name: "VERSION" },
      ],
    });
    expect(derived.runtime.vars).toEqual({ MODE: "prod", LIMITS: { a: [1] } });
    expect(derived.versionMetadata).toBe("VERSION");
  });
});
