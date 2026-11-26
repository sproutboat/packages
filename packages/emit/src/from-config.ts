/**
 * One mapping of a project config (wrangler.jsonc or the legacy sproutboat.jsonc, both normalised to SproutboatConfig)
 * to Cloudflare script-upload metadata. The CLI's config path and a Cloudflare client reach the emitter the same way.
 */
import {
  queueSettings,
  resourceRefs,
  type QueueBinding,
  type QueueRef,
  type SproutboatConfig,
} from "@sproutboat/config";
import type { AssetsConfig, QueueConsumer, UploadMetadata, WorkerBinding } from "./metadata";

export type FromConfigOptions = {
  /** The name of the bundle's entry module. */
  mainModule?: string;
  flags?: readonly string[];
};

const isQueueBinding = (entry: QueueRef): entry is QueueBinding => Object(entry) === entry;

/** Secret names are declared without values: the values travel apart, sealed. */
export function fromConfig(config: SproutboatConfig, options: FromConfigOptions = {}): UploadMetadata {
  const bindings: WorkerBinding[] = [];
  for (const [name, text] of Object.entries(config.vars ?? {})) bindings.push({ type: "plain_text", name, text });
  for (const ref of resourceRefs(config.kv_namespaces))
    bindings.push(
      ref.id === undefined
        ? { type: "kv_namespace", name: ref.binding }
        : { type: "kv_namespace", name: ref.binding, namespace_id: ref.id },
    );
  for (const ref of resourceRefs(config.d1_databases))
    bindings.push(
      ref.id === undefined ? { type: "d1", name: ref.binding } : { type: "d1", name: ref.binding, id: ref.id },
    );
  for (const ref of resourceRefs(config.r2_buckets))
    bindings.push(
      ref.id === undefined
        ? { type: "r2_bucket", name: ref.binding }
        : { type: "r2_bucket", name: ref.binding, bucket_name: ref.id },
    );

  // The CLI's rule: a worker consumes every queue it binds, unless a Wrangler file said `consume: false`.
  const notConsumed = new Set(
    (config.queues ?? []).flatMap((entry) =>
      isQueueBinding(entry) && "consume" in entry && entry.consume === false ? [entry.binding] : [],
    ),
  );
  const consumers: QueueConsumer[] = [];
  for (const queue of queueSettings(config.queues)) {
    bindings.push({ type: "queue", name: queue.binding, queue_name: queue.queue });
    if (notConsumed.has(queue.binding)) continue;
    const consumer: QueueConsumer = { queue: queue.queue };
    if (queue.maxBatchSize !== undefined) consumer.max_batch_size = queue.maxBatchSize;
    if (queue.maxBatchTimeout !== undefined) consumer.max_batch_timeout = queue.maxBatchTimeout;
    if (queue.maxRetries !== undefined) consumer.max_retries = queue.maxRetries;
    if (queue.retryDelay !== undefined) consumer.retry_delay = queue.retryDelay;
    if (queue.deadLetterQueue !== undefined) consumer.dead_letter_queue = queue.deadLetterQueue;
    consumers.push(consumer);
  }
  for (const name of config.analytics_engine_datasets ?? []) bindings.push({ type: "analytics_engine", name });
  for (const [name, className] of Object.entries(config.durable_objects ?? {}))
    bindings.push({ type: "durable_object_namespace", name, class_name: className });
  for (const service of config.services ?? [])
    bindings.push({ type: "service", name: service.binding, service: service.service });
  for (const limiter of config.ratelimiters ?? [])
    bindings.push({
      type: "ratelimit",
      name: limiter.binding,
      simple: { limit: limiter.limit, period: limiter.period },
    });
  if (config.assets?.binding) bindings.push({ type: "assets", name: config.assets.binding });
  for (const name of config.secrets ?? []) bindings.push({ type: "secret_text", name });
  if (config.version_metadata) bindings.push({ type: "version_metadata", name: config.version_metadata });

  const metadata: UploadMetadata = {
    main_module: options.mainModule ?? "index.js",
    compatibility_date: config.compatibility_date,
    compatibility_flags: [...(options.flags ?? [])],
    bindings,
  };
  if (consumers.length > 0) metadata.queue_consumers = consumers;
  if (config.triggers?.crons !== undefined) metadata.triggers = { crons: config.triggers.crons };
  if (config.assets !== undefined) {
    const assetsConfig: AssetsConfig = {};
    if (config.assets.not_found_handling !== undefined)
      assetsConfig.not_found_handling = config.assets.not_found_handling;
    if (config.assets.run_sprout_first !== undefined) assetsConfig.run_worker_first = config.assets.run_sprout_first;
    metadata.assets = { config: assetsConfig };
  }
  return metadata;
}
