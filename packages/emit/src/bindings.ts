/**
 * Cloudflare binding metadata to the two shapes Sproutboat needs: the `Bindings` object baked into the module for the
 * runtime, and the entries of the app record (`spec.bindings`) that the API stores. One mapping, so they cannot disagree.
 */
import { isBindingName } from "@sproutboat/config";
import type { Bindings, QueueSettings } from "@sproutboat/runtime";
import { EmitError, issue } from "./errors";
import { MAX_BINDINGS, MAX_QUEUE_CONSUMERS } from "./limits";
import type { Json, WorkerMetadata } from "./metadata";

export type RecordBinding = {
  name: string;
  kind: "kv" | "d1" | "r2" | "queue" | "do" | "ae" | "ratelimit" | "assets" | "secret";
  resource_id: string | null;
  config: { [key: string]: string | number };
};

export type RecordQueueConsumer = {
  queue: string;
  max_batch_size: number;
  max_batch_timeout_ms: number;
  max_retries: number;
  dead_letter_queue: string | null;
};

/** What the runtime reads from the module, plus the informational `vars` and `resources` the CLI has always baked. */
export type RuntimeBindings = Bindings & {
  vars: { [name: string]: Json };
  resources: { [binding: string]: { kind: string; id: string } };
};

export type DerivedBindings = {
  runtime: RuntimeBindings;
  record: {
    bindings: RecordBinding[];
    services: Array<{ name: string; service: string }>;
    crons: string[];
    queue_consumers: RecordQueueConsumer[];
  };
  /** The binding that carries `{id, tag, timestamp}`, when the upload has one. */
  versionMetadata?: string;
  warnings: string[];
};

export type DeriveOptions = {
  /** Secret names the app already holds. Bound as well, as Cloudflare binds every secret of a Worker. */
  extraSecretNames?: readonly string[];
};

const list = <T>(): T[] => [];

const RESOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Cloudflare's defaults for a queue consumer, which the runtime applies when a setting is left out. */
const QUEUE_DEFAULTS = { maxBatchSize: 10, maxBatchTimeout: 0, maxRetries: 3 };

function resourceIdFor(what: string, name: string): string {
  const id = name.toLowerCase();
  if (!RESOURCE_ID_RE.test(id))
    throw new EmitError([
      issue(
        "binding-invalid",
        `${what} "${name}" cannot be a Cloud resource name: lowercased it must be 1 to 64 characters, start with a letter or digit, and use only letters, digits, "_" and "-"`,
      ),
    ]);
  return id;
}

/** Map validated metadata. Throws EmitError for anything the Cloud would refuse that validation could not see. */
export function deriveBindings(metadata: WorkerMetadata, options: DeriveOptions = {}): DerivedBindings {
  const warnings: string[] = [];
  const pinned: string[] = [];
  const vars: RuntimeBindings["vars"] = {};
  const resources: RuntimeBindings["resources"] = {};
  const runtime: Bindings = {
    kv: [],
    secrets: [],
    d1: [],
    r2: [],
    queues: [],
    queueConfig: [],
    analytics: [],
    do: [],
    services: [],
    crons: metadata.triggers?.crons ?? [],
    ratelimiters: [],
    assets: "",
  };
  const record: DerivedBindings["record"] = {
    bindings: [],
    services: [],
    crons: metadata.triggers?.crons ?? [],
    queue_consumers: [],
  };
  const byKind = {
    kv: list<RecordBinding>(),
    d1: list<RecordBinding>(),
    r2: list<RecordBinding>(),
    queue: list<RecordBinding>(),
  };
  const rest: RecordBinding[] = [];
  const pinnedIds = { kv: list<[string, string]>(), d1: list<[string, string]>(), r2: list<[string, string]>() };
  let versionMetadata: string | undefined;
  const queueByName = new Map<string, string>();

  for (const binding of metadata.bindings) {
    switch (binding.type) {
      case "plain_text":
        vars[binding.name] = binding.text;
        break;
      case "json":
        vars[binding.name] = binding.json;
        break;
      case "secret_text":
        runtime.secrets.push(binding.name);
        break;
      case "kv_namespace":
        runtime.kv.push(binding.name);
        byKind.kv.push({
          name: binding.name,
          kind: "kv",
          resource_id: resourceIdFor("kv_namespaces binding", binding.name),
          config: {},
        });
        if (binding.namespace_id !== undefined) {
          pinnedIds.kv.push([binding.name, binding.namespace_id]);
          pinned.push(`kv_namespaces.${binding.name}`);
        }
        break;
      case "d1":
        runtime.d1.push(binding.name);
        byKind.d1.push({
          name: binding.name,
          kind: "d1",
          resource_id: resourceIdFor("d1_databases binding", binding.name),
          config: {},
        });
        if (binding.id !== undefined) {
          pinnedIds.d1.push([binding.name, binding.id]);
          pinned.push(`d1_databases.${binding.name}`);
        }
        break;
      case "r2_bucket":
        runtime.r2.push(binding.name);
        byKind.r2.push({
          name: binding.name,
          kind: "r2",
          resource_id: resourceIdFor("r2_buckets binding", binding.name),
          config: {},
        });
        if (binding.bucket_name !== undefined) {
          pinnedIds.r2.push([binding.name, binding.bucket_name]);
          pinned.push(`r2_buckets.${binding.name}`);
        }
        break;
      case "queue": {
        runtime.queues.push(binding.name);
        const resource = resourceIdFor("queue", binding.queue_name);
        if (queueByName.has(resource))
          throw new EmitError([
            issue(
              "binding-invalid",
              `queues: two bindings name the queue "${resource}" (queue names are lowercase on the Cloud)`,
            ),
          ]);
        queueByName.set(resource, binding.name);
        byKind.queue.push({
          name: binding.name,
          kind: "queue",
          resource_id: resource,
          config: { queue: binding.queue_name },
        });
        break;
      }
      case "durable_object_namespace":
        runtime.do.push({ binding: binding.name, className: binding.class_name });
        rest.push({ name: binding.name, kind: "do", resource_id: null, config: { class_name: binding.class_name } });
        break;
      case "service":
        runtime.services.push({ binding: binding.name, service: binding.service });
        record.services.push({ name: binding.name, service: binding.service });
        break;
      case "analytics_engine":
        runtime.analytics.push(binding.name);
        rest.push({ name: binding.name, kind: "ae", resource_id: null, config: {} });
        break;
      case "ratelimit":
        runtime.ratelimiters.push({
          binding: binding.name,
          limit: binding.simple.limit,
          period: binding.simple.period,
        });
        rest.push({
          name: binding.name,
          kind: "ratelimit",
          resource_id: null,
          config: { limit: binding.simple.limit, period: binding.simple.period },
        });
        break;
      case "assets":
        runtime.assets = binding.name;
        rest.push({ name: binding.name, kind: "assets", resource_id: null, config: {} });
        break;
      case "version_metadata":
        versionMetadata = binding.name;
        break;
    }
  }

  const taken = new Map(metadata.bindings.map((binding) => [binding.name, binding.type]));
  for (const name of options.extraSecretNames ?? []) {
    if (!isBindingName(name))
      throw new EmitError([
        issue("binding-invalid", `stored secret name ${JSON.stringify(name)} is not a binding name`),
      ]);
    const other = taken.get(name);
    if (other !== undefined && other !== "secret_text")
      throw new EmitError([
        issue("binding-invalid", `stored secret "${name}" has the name of this upload's ${other} binding`),
      ]);
    if (!runtime.secrets.includes(name)) runtime.secrets.push(name);
  }

  // Each queue binding names its queue and takes the settings of the consumer that names that queue.
  const consumers = new Map(
    (metadata.queue_consumers ?? []).map((consumer) => [consumer.queue.toLowerCase(), consumer]),
  );
  runtime.queueConfig = byKind.queue.map((entry): QueueSettings => {
    const queue = String(entry.config.queue);
    const settings: QueueSettings = { binding: entry.name, queue };
    const consumer = consumers.get(queue.toLowerCase());
    if (consumer?.max_batch_size !== undefined) settings.maxBatchSize = consumer.max_batch_size;
    if (consumer?.max_batch_timeout !== undefined) settings.maxBatchTimeout = consumer.max_batch_timeout;
    if (consumer?.max_retries !== undefined) settings.maxRetries = consumer.max_retries;
    if (consumer?.retry_delay !== undefined) settings.retryDelay = consumer.retry_delay;
    if (consumer?.dead_letter_queue !== undefined) settings.deadLetterQueue = consumer.dead_letter_queue;
    return settings;
  });
  for (const entry of byKind.queue) {
    const consumer = consumers.get(String(entry.config.queue).toLowerCase());
    if (consumer?.retry_delay !== undefined) entry.config.retry_delay = consumer.retry_delay;
  }
  for (const consumer of metadata.queue_consumers ?? []) {
    record.queue_consumers.push({
      queue: resourceIdFor("queue", consumer.queue),
      max_batch_size: consumer.max_batch_size ?? QUEUE_DEFAULTS.maxBatchSize,
      max_batch_timeout_ms: Math.round((consumer.max_batch_timeout ?? QUEUE_DEFAULTS.maxBatchTimeout) * 1000),
      max_retries: consumer.max_retries ?? QUEUE_DEFAULTS.maxRetries,
      dead_letter_queue:
        consumer.dead_letter_queue === undefined
          ? null
          : resourceIdFor("dead_letter_queue", consumer.dead_letter_queue),
    });
  }

  // Record order is the CLI's: kv, d1, r2, queues, then analytics, Durable Objects, rate limits, assets, secrets.
  const order = (kind: RecordBinding["kind"]) => rest.filter((entry) => entry.kind === kind);
  record.bindings = [
    ...byKind.kv,
    ...byKind.d1,
    ...byKind.r2,
    ...byKind.queue,
    ...order("ae"),
    ...order("do"),
    ...order("ratelimit"),
    ...order("assets"),
    ...runtime.secrets.map((name): RecordBinding => ({ name, kind: "secret", resource_id: null, config: {} })),
  ];
  if (record.bindings.length + record.services.length > MAX_BINDINGS)
    throw new EmitError([
      issue(
        "limit-exceeded",
        `the upload declares ${record.bindings.length + record.services.length} bindings (secrets, services and assets count); the Cloud takes at most ${MAX_BINDINGS} per app`,
      ),
    ]);
  if (record.queue_consumers.length > MAX_QUEUE_CONSUMERS)
    throw new EmitError([
      issue(
        "limit-exceeded",
        `${record.queue_consumers.length} queue consumers; the Cloud takes at most ${MAX_QUEUE_CONSUMERS} per app`,
      ),
    ]);
  if (pinned.length > 0)
    warnings.push(
      `${pinned.join(", ")} pin${pinned.length === 1 ? "s" : ""} an account-level id; on the Cloud each app's storage is private to it, so the id is ignored and the app gets its own`,
    );
  for (const kind of ["kv", "d1", "r2"] as const)
    for (const [name, id] of pinnedIds[kind]) resources[name] = { kind, id };
  const result: DerivedBindings = { runtime: { ...runtime, vars, resources }, record, warnings };
  if (versionMetadata !== undefined) result.versionMetadata = versionMetadata;
  return result;
}
