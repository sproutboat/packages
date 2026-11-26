/**
 * The emitter's input: a Cloudflare script upload with Cloudflare's field names. `triggers.crons` and `queue_consumers`
 * are Sproutboat extensions (Cloudflare sets them through other endpoints). Unaccepted fields are refused by name.
 */
import { isBindingName } from "@sproutboat/config";
import { issue, type EmitIssue, type EmitReason } from "./errors";
import { SUPPORTED_COMPATIBILITY_FLAGS, resolveNodeFlags, type NodeFlags } from "./flags";
import {
  isArray,
  isBoolean,
  isCount,
  isNumber,
  isRecord,
  isString,
  isStringArray,
  type Input,
  type Json,
  type JsonObject,
} from "./json";
import {
  MAX_BINDINGS,
  MAX_CODE_BYTES,
  MAX_BUNDLED_BYTES,
  MAX_CRONS,
  MAX_DATA_MODULE_BYTES,
  MAX_DATA_TOTAL_BYTES,
  MAX_METADATA_BYTES,
  MAX_MODULE_NAME_LENGTH,
  MAX_MODULES,
  MAX_QUEUE_CONSUMERS,
  MAX_SOURCEMAP_BYTES,
  MAX_TOTAL_BYTES,
} from "./limits";

export type { Json } from "./json";

/** Module types of the upload. `wasm` and Python are refused with their own reason (section 2.3 of design 032). */
export const MODULE_TYPES = ["esm", "cjs", "text", "data", "sourcemap"] as const;
export type ModuleType = (typeof MODULE_TYPES)[number];

/** Cloudflare part content types, mapped to ours. */
export const CONTENT_TYPE_TO_MODULE_TYPE = new Map<string, ModuleType | "wasm" | "python">([
  ["application/javascript+module", "esm"],
  ["text/javascript+module", "esm"],
  ["application/javascript", "cjs"],
  ["text/javascript", "cjs"],
  ["text/plain", "text"],
  ["application/octet-stream", "data"],
  ["application/source-map", "sourcemap"],
  ["application/wasm", "wasm"],
  ["text/x-python", "python"],
  ["application/python", "python"],
]);

/** A module as the API carries it: by digest, the bytes uploaded separately. */
export type ModuleDescriptor = { name: string; type: ModuleType; sha256: string };
/** A module as the emitter receives it. Text for esm, cjs, text and sourcemap; bytes for data. */
export type ModuleInput = { name: string; type: ModuleType; content: string | Uint8Array };

export type WorkerBinding =
  | { type: "plain_text"; name: string; text: string }
  | { type: "json"; name: string; json: Json }
  | { type: "secret_text"; name: string; text?: string }
  | { type: "kv_namespace"; name: string; namespace_id?: string }
  | { type: "d1"; name: string; id?: string }
  | { type: "r2_bucket"; name: string; bucket_name?: string }
  | { type: "queue"; name: string; queue_name: string }
  | { type: "durable_object_namespace"; name: string; class_name: string }
  | { type: "service"; name: string; service: string }
  | { type: "analytics_engine"; name: string; dataset?: string }
  | { type: "ratelimit"; name: string; namespace_id?: string; simple: { limit: number; period: number } }
  | { type: "assets"; name: string }
  | { type: "version_metadata"; name: string };

/** What a client uploads: the fields of WorkerMetadata the emitter does not derive. */
export type UploadMetadata = Omit<WorkerMetadata, "declared_compatibility_date" | "node">;

export type WorkerBindingType = WorkerBinding["type"];

export const ACCEPTED_BINDING_TYPES: readonly WorkerBindingType[] = [
  "plain_text",
  "json",
  "secret_text",
  "kv_namespace",
  "d1",
  "r2_bucket",
  "queue",
  "durable_object_namespace",
  "service",
  "analytics_engine",
  "ratelimit",
  "assets",
  "version_metadata",
];

function isBindingType(value: string): value is WorkerBindingType {
  return ACCEPTED_BINDING_TYPES.some((type) => type === value);
}

/** Cloudflare binding types with no equivalent here. Refused by name. */
export const REFUSED_BINDING_TYPES: readonly string[] = [
  "ai",
  "browser",
  "hyperdrive",
  "vectorize",
  "workflow",
  "send_email",
  "mtls_certificate",
  "dispatch_namespace",
  "pipelines",
  "images",
  "secrets_store_secret",
  "secret_key",
  "wasm_module",
  "text_blob",
  "data_blob",
  "inherit",
];

export type MigrationStep = { new_classes?: string[]; new_sqlite_classes?: string[] };
export type Migrations = { old_tag?: string; new_tag?: string; steps: MigrationStep[] };

export type AssetsConfig = {
  not_found_handling?: "none" | "single-page-application" | "404-page";
  /** Cloudflare's `run_worker_first`: true, or route patterns (`!` negates). */
  run_worker_first?: boolean | string[];
  html_handling?: "auto-trailing-slash";
  _headers?: string;
  _redirects?: string;
};

export type QueueConsumer = {
  queue: string;
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  retry_delay?: number;
  dead_letter_queue?: string;
};

export type WorkerMetadata = {
  main_module: string;
  /** The date the build runs as: the declared date, raised to the floor when one was given. Runtime semantics only. */
  compatibility_date: string;
  /** The date the upload declared. Node support and process.env population are decided from this one. */
  declared_compatibility_date: string;
  compatibility_flags: string[];
  /** What the flags and the declared date make of Node support (Cloudflare's own rules, see flags.ts). */
  node: NodeFlags;
  bindings: WorkerBinding[];
  /** Binding types kept from the app's current version (only `secret_text` is meaningful here). */
  keep_bindings?: string[];
  keep_assets?: boolean;
  migrations?: Migrations;
  assets?: { config?: AssetsConfig };
  /** Sproutboat extension: Cloudflare sets crons through `PUT .../schedules`. */
  triggers?: { crons: string[] };
  /** Sproutboat extension: Cloudflare sets consumers through the queue consumers API. */
  queue_consumers?: QueueConsumer[];
  /** `annotations["workers/message"]`, the build's message. */
  message?: string;
};

/** Fields Cloudflare's upload accepts that have no effect here. One warning names them. */
export const IGNORED_METADATA_FIELDS: readonly string[] = [
  "observability",
  "logpush",
  "tail_consumers",
  "placement",
  "usage_model",
  "tags",
  "annotations",
  "limits",
];

const KNOWN_FIELDS = new Set([
  "main_module",
  "body_part",
  "compatibility_date",
  "compatibility_flags",
  "bindings",
  "keep_bindings",
  "keep_assets",
  "migrations",
  "assets",
  "triggers",
  "queue_consumers",
  ...IGNORED_METADATA_FIELDS,
]);

export type ValidateMetadataOptions = {
  /** Refuse a date later than this one (the newest date the builder's generation knows). */
  maxCompatibilityDate?: string;
  /** Refuse a date in the future. Pass `new Date()` (or a fixed clock in tests). */
  now?: Date;
  /**
   * A date older than this builds as this date (plan 015: Cloudflare dates predate our semantics). Off by default so a
   * legacy project keeps its own date. Only the runtime generation moves: the flags are decided from the declared date.
   * The Cloud path (`validateMetadataForCloud`) cannot leave it out.
   */
  compatibilityFloor?: string;
  /** The `bundle.main_module` of the request, when it carries one: it must match `metadata.main_module`. */
  bundleMainModule?: string;
  /** Refuse an `assets` binding or `run_worker_first` below this date (the bundle kind never bakes assets). */
  assetStoreMinDate?: string;
};

/**
 * What a bundle uploaded to the Cloud is always checked with. Every field is required, so a caller cannot forget one:
 * each of them left out used to fail open (an old assets date, a future date, a Cloudflare date below the floor).
 */
export type CloudValidation = {
  /** Refuse a date in the future. */
  now: Date;
  /** The newest date the builder's generation knows. */
  maxCompatibilityDate: string;
  /** Cloudflare dates below this build as it. Pass WORKERS_COMPAT_FLOOR unless the generation says otherwise. */
  compatibilityFloor: string;
  /** An assets binding or run_worker_first below this date is refused. Pass ASSETS_STORE_MIN_DATE. */
  assetStoreMinDate: string;
  /** The `bundle.main_module` of the request, when it carries one. */
  bundleMainModule?: string;
};

export type MetadataResult =
  | { ok: true; value: WorkerMetadata; warnings: string[] }
  | { ok: false; errors: EmitIssue[] };

/** The date every Cloudflare compatibility date below it builds as, from plan 015. */
export const WORKERS_COMPAT_FLOOR = "2026-11-22";
/** From this date the worker can read its assets from the Cloud's asset store, so a bundle needs no baked files. */
export const ASSETS_STORE_MIN_DATE = "2026-11-22";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLASS_NAME = /^[A-Za-z_$][\w$]*$/;
const CRON_CHARS = /^[0-9A-Za-z*,/ -]+$/;
const FLAT_STEP_KEYS = ["new_classes", "new_sqlite_classes"] as const;
const REFUSED_STEP_KEYS = ["renamed_classes", "deleted_classes", "transferred_classes"] as const;

/** A cron as stored: single spaces, five fields, at most 128 characters of the allowed set. Returns null if invalid. */
export function normalizeCron(expression: string): string | null {
  const cron = expression.trim().split(/\s+/).join(" ");
  if (cron.length > 128 || !CRON_CHARS.test(cron) || cron.split(" ").length !== 5) return null;
  return cron;
}

/** Whether `YYYY-MM-DD` names a real calendar day. */
export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A module name: relative, at most 256 characters, no `.` or `..` segment, no NUL, backslash or control character. */
export function moduleNameProblem(name: Input): string | null {
  if (!isString(name) || name === "") return "a module name is a non-empty string";
  if (name.length > MAX_MODULE_NAME_LENGTH) return `module name is longer than ${MAX_MODULE_NAME_LENGTH} characters`;
  if (name.includes("\\") || [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    return "module name has a control character or a backslash";
  if (name.startsWith("/")) return "module name must be relative";
  for (const segment of name.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return 'module name has an empty, "." or ".." segment';
  }
  return null;
}

type Collector = { errors: EmitIssue[]; warnings: string[] };

const bad = (c: Collector, reason: EmitReason, message: string, path: string) =>
  c.errors.push(issue(reason, message, path));

function stringField(
  c: Collector,
  source: JsonObject,
  key: string,
  path: string,
  required = false,
): string | undefined {
  const value = source[key];
  if (value === undefined) {
    if (required) bad(c, "binding-invalid", `${path}.${key} is required`, `${path}.${key}`);
    return undefined;
  }
  if (!isString(value) || value === "") {
    bad(c, "binding-invalid", `${path}.${key} must be a non-empty string`, `${path}.${key}`);
    return undefined;
  }
  return value;
}

/** The fields each binding type carries. The ones a binding is refused for are listed too: their own message applies. */
const BINDING_FIELDS = {
  plain_text: ["text"],
  json: ["json"],
  secret_text: ["text"],
  kv_namespace: ["namespace_id"],
  d1: ["id"],
  r2_bucket: ["bucket_name", "jurisdiction"],
  queue: ["queue_name"],
  durable_object_namespace: ["class_name", "script_name"],
  service: ["service", "environment", "entrypoint"],
  analytics_engine: ["dataset"],
  ratelimit: ["namespace_id", "simple"],
  assets: [],
  version_metadata: [],
} satisfies Record<WorkerBindingType, readonly string[]>;

/** A field this emitter does not read is refused, not dropped: a silently ignored field means different behaviour. */
function refuseUnknownFields(c: Collector, raw: JsonObject, allowed: readonly string[], path: string): boolean {
  const unknown = Object.keys(raw).filter((key) => key !== "type" && key !== "name" && !allowed.includes(key));
  for (const key of unknown)
    bad(c, "binding-invalid", `${path}.${key} is not a field this binding type takes here`, `${path}.${key}`);
  return unknown.length > 0;
}

/** Whether a JSON value holds the key __proto__ anywhere: baked into the module as an object literal it would set a prototype. */
function hasProtoKey(value: Input): boolean {
  const pending: Input[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (isArray(current)) pending.push(...current);
    else if (isRecord(current)) {
      if (Object.keys(current).includes("__proto__")) return true;
      pending.push(...Object.values(current));
    }
  }
  return false;
}

function validateBinding(c: Collector, raw: Input, index: number): WorkerBinding | undefined {
  const path = `metadata.bindings[${index}]`;
  if (!isRecord(raw)) {
    bad(c, "binding-invalid", `${path} must be an object`, path);
    return undefined;
  }
  const type = raw.type;
  if (!isString(type)) {
    bad(c, "binding-invalid", `${path}.type must be a string`, `${path}.type`);
    return undefined;
  }
  const name = raw.name;
  if (REFUSED_BINDING_TYPES.includes(type)) {
    const label = isString(name) ? ` (${name})` : "";
    bad(
      c,
      "binding-type-unsupported",
      `binding type "${type}"${label} is not supported on Sproutboat Cloud`,
      `${path}.type`,
    );
    return undefined;
  }
  if (!isBindingType(type)) {
    bad(c, "binding-type-unsupported", `unknown binding type "${type}"`, `${path}.type`);
    return undefined;
  }
  if (!isString(name) || !isBindingName(name)) {
    bad(
      c,
      "binding-invalid",
      `${path}.name must be a JavaScript identifier of letters, digits and underscores (not __proto__)`,
      `${path}.name`,
    );
    return undefined;
  }
  if (refuseUnknownFields(c, raw, BINDING_FIELDS[type], path)) return undefined;
  switch (type) {
    case "plain_text": {
      if (!isString(raw.text)) {
        bad(c, "binding-invalid", `${path}.text must be a string`, `${path}.text`);
        return undefined;
      }
      return { type, name, text: raw.text };
    }
    case "json": {
      if (raw.json === undefined) {
        bad(c, "binding-invalid", `${path}.json is required`, `${path}.json`);
        return undefined;
      }
      if (hasProtoKey(raw.json)) {
        bad(
          c,
          "binding-invalid",
          `${path}.json holds a "__proto__" key; baked into the module it would set a prototype instead of a property`,
          `${path}.json`,
        );
        return undefined;
      }
      return { type, name, json: raw.json };
    }
    case "secret_text": {
      if (raw.text === undefined) return { type, name };
      if (!isString(raw.text)) {
        bad(c, "binding-invalid", `${path}.text must be a string`, `${path}.text`);
        return undefined;
      }
      return { type, name, text: raw.text };
    }
    case "kv_namespace": {
      const id = stringField(c, raw, "namespace_id", path);
      return id === undefined ? { type, name } : { type, name, namespace_id: id };
    }
    case "d1": {
      const id = stringField(c, raw, "id", path);
      return id === undefined ? { type, name } : { type, name, id };
    }
    case "r2_bucket": {
      if (raw.jurisdiction !== undefined && raw.jurisdiction !== "default") {
        bad(c, "binding-invalid", `${path}.jurisdiction is not supported (storage is per app)`, `${path}.jurisdiction`);
        return undefined;
      }
      const bucket = stringField(c, raw, "bucket_name", path);
      return bucket === undefined ? { type, name } : { type, name, bucket_name: bucket };
    }
    case "queue": {
      const queue = stringField(c, raw, "queue_name", path, true);
      return queue === undefined ? undefined : { type, name, queue_name: queue };
    }
    case "durable_object_namespace": {
      const className = stringField(c, raw, "class_name", path, true);
      if (className === undefined) return undefined;
      if (!CLASS_NAME.test(className)) {
        bad(c, "binding-invalid", `${path}.class_name "${className}" is not a class name`, `${path}.class_name`);
        return undefined;
      }
      if (raw.script_name !== undefined) {
        bad(
          c,
          "binding-invalid",
          `${path}.script_name is not supported: a Durable Object class belongs to the app that defines it (no cross-app Durable Objects)`,
          `${path}.script_name`,
        );
        return undefined;
      }
      return { type, name, class_name: className };
    }
    case "service": {
      const service = stringField(c, raw, "service", path, true);
      if (service === undefined) return undefined;
      if (raw.environment !== undefined && raw.environment !== "production") {
        bad(
          c,
          "binding-invalid",
          `${path}.environment is not supported: a service binding names the app of its project`,
          `${path}.environment`,
        );
        return undefined;
      }
      if (raw.entrypoint !== undefined && raw.entrypoint !== "default") {
        bad(
          c,
          "binding-invalid",
          `${path}.entrypoint is not supported until named entrypoints exist`,
          `${path}.entrypoint`,
        );
        return undefined;
      }
      return { type, name, service };
    }
    case "analytics_engine": {
      const dataset = stringField(c, raw, "dataset", path);
      return dataset === undefined ? { type, name } : { type, name, dataset };
    }
    case "ratelimit": {
      const simple = raw.simple;
      if (!isRecord(simple) || !isCount(simple.limit) || !isCount(simple.period)) {
        bad(c, "binding-invalid", `${path}.simple needs a positive integer limit and period`, `${path}.simple`);
        return undefined;
      }
      const namespace = stringField(c, raw, "namespace_id", path);
      const base = { type, name, simple: { limit: simple.limit, period: simple.period } };
      return namespace === undefined ? base : { ...base, namespace_id: namespace };
    }
    case "assets":
      return { type, name };
    case "version_metadata":
      return { type, name };
  }
}

function migrationSteps(c: Collector, raw: JsonObject, path: string): Input[] {
  if (raw.steps === undefined) return [raw];
  if (!isArray(raw.steps)) {
    bad(c, "metadata-invalid", `${path}.steps must be an array`, `${path}.steps`);
    return [];
  }
  return raw.steps;
}

function validateMigrations(c: Collector, raw: Input): Migrations | undefined {
  if (raw === undefined) return undefined;
  const path = "metadata.migrations";
  if (!isRecord(raw)) {
    bad(c, "metadata-invalid", `${path} must be an object`, path);
    return undefined;
  }
  // Cloudflare takes either {old_tag, new_tag, steps: [...]} or one flat step, never both.
  const flat = [...FLAT_STEP_KEYS, ...REFUSED_STEP_KEYS].filter((key) => raw[key] !== undefined);
  if (raw.steps !== undefined && flat.length > 0)
    bad(c, "metadata-invalid", `${path} mixes steps with ${flat.join(", ")}; use one form`, path);
  const steps: MigrationStep[] = [];
  migrationSteps(c, raw, path).forEach((entry, at) => {
    const stepPath = raw.steps === undefined ? path : `${path}.steps[${at}]`;
    if (!isRecord(entry)) {
      bad(c, "metadata-invalid", `${stepPath} must be an object`, stepPath);
      return;
    }
    for (const key of REFUSED_STEP_KEYS) {
      const value = entry[key];
      if (value === undefined || (isArray(value) && value.length === 0)) continue;
      bad(
        c,
        "migration-unsupported",
        `${key} is not supported yet: renaming, deleting or moving a Durable Object class needs the storage to rename, delete or move its objects`,
        `${stepPath}.${key}`,
      );
    }
    const step: MigrationStep = {};
    for (const key of ["new_classes", "new_sqlite_classes"] as const) {
      const value = entry[key];
      if (value === undefined) continue;
      if (!isStringArray(value) || !value.every((name) => CLASS_NAME.test(name)))
        bad(c, "metadata-invalid", `${stepPath}.${key} must be an array of class names`, `${stepPath}.${key}`);
      else step[key] = value;
    }
    steps.push(step);
  });
  const out: Migrations = { steps };
  for (const tag of ["old_tag", "new_tag"] as const) {
    const value = raw[tag];
    if (value === undefined) continue;
    if (!isString(value) || value === "" || value.length > 128)
      bad(c, "metadata-invalid", `${path}.${tag} must be a string of at most 128 characters`, `${path}.${tag}`);
    else out[tag] = value;
  }
  return out;
}

function validateAssets(c: Collector, raw: Input): { config?: AssetsConfig } | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    bad(c, "metadata-invalid", "metadata.assets must be an object", "metadata.assets");
    return undefined;
  }
  if (raw.jwt !== undefined)
    bad(
      c,
      "metadata-invalid",
      "metadata.assets.jwt is not accepted: assets are uploaded through the asset routes of this API",
      "metadata.assets.jwt",
    );
  const rawConfig = raw.config;
  if (rawConfig === undefined) return {};
  const path = "metadata.assets.config";
  if (!isRecord(rawConfig)) {
    bad(c, "metadata-invalid", `${path} must be an object`, path);
    return {};
  }
  const config: AssetsConfig = {};
  for (const key of Object.keys(rawConfig))
    if (!ASSETS_CONFIG_KEYS.includes(key))
      bad(c, "metadata-invalid", `${path}.${key} is not an assets setting this emitter takes`, `${path}.${key}`);
  const notFound = rawConfig.not_found_handling;
  if (notFound !== undefined) {
    if (notFound === "none" || notFound === "single-page-application" || notFound === "404-page")
      config.not_found_handling = notFound;
    else
      bad(
        c,
        "metadata-invalid",
        `${path}.not_found_handling must be none, single-page-application or 404-page`,
        `${path}.not_found_handling`,
      );
  }
  const first = rawConfig.run_worker_first;
  if (first !== undefined) {
    if (isBoolean(first) || isStringArray(first)) config.run_worker_first = first;
    else
      bad(
        c,
        "metadata-invalid",
        `${path}.run_worker_first must be a boolean or an array of route patterns`,
        `${path}.run_worker_first`,
      );
  }
  const html = rawConfig.html_handling;
  if (html !== undefined) {
    if (html === "auto-trailing-slash") config.html_handling = html;
    else
      bad(
        c,
        "metadata-invalid",
        `${path}.html_handling ${JSON.stringify(html)} is not supported yet; only auto-trailing-slash is`,
        `${path}.html_handling`,
      );
  }
  for (const key of ["_headers", "_redirects"] as const) {
    const value = rawConfig[key];
    if (value === undefined) continue;
    if (isString(value)) config[key] = value;
    else bad(c, "metadata-invalid", `${path}.${key} must be a string`, `${path}.${key}`);
  }
  return { config };
}

const ASSETS_CONFIG_KEYS = ["not_found_handling", "run_worker_first", "html_handling", "_headers", "_redirects"];

const CONSUMER_LIMITS = [
  ["max_batch_size", 100, true],
  ["max_batch_timeout", 60, false],
  ["max_retries", 100, true],
  ["retry_delay", 86400, false],
] as const;

function validateConsumers(c: Collector, raw: Input): QueueConsumer[] | undefined {
  if (raw === undefined) return undefined;
  if (!isArray(raw)) {
    bad(c, "metadata-invalid", "metadata.queue_consumers must be an array", "metadata.queue_consumers");
    return undefined;
  }
  if (raw.length > MAX_QUEUE_CONSUMERS)
    bad(
      c,
      "limit-exceeded",
      `queue_consumers lists ${raw.length} consumers; at most ${MAX_QUEUE_CONSUMERS} per app`,
      "metadata.queue_consumers",
    );
  const out: QueueConsumer[] = [];
  raw.forEach((entry, at) => {
    const path = `metadata.queue_consumers[${at}]`;
    if (!isRecord(entry) || !isString(entry.queue) || entry.queue === "") {
      bad(c, "metadata-invalid", `${path}.queue must be a queue name`, `${path}.queue`);
      return;
    }
    const consumer: QueueConsumer = { queue: entry.queue };
    for (const key of Object.keys(entry))
      if (key !== "queue" && key !== "dead_letter_queue" && !CONSUMER_LIMITS.some(([known]) => known === key))
        bad(
          c,
          "metadata-invalid",
          `${path}.${key} is not a queue consumer setting this emitter takes`,
          `${path}.${key}`,
        );
    for (const [key, max, whole] of CONSUMER_LIMITS) {
      const value = entry[key];
      if (value === undefined) continue;
      if (!isNumber(value) || value < 0 || value > max || (whole && !Number.isInteger(value)))
        bad(
          c,
          "metadata-invalid",
          `${path}.${key} must be ${whole ? "a whole number" : "a number"} from 0 to ${max}`,
          `${path}.${key}`,
        );
      else consumer[key] = value;
    }
    const dead = entry.dead_letter_queue;
    if (dead !== undefined) {
      if (isString(dead) && dead !== "") consumer.dead_letter_queue = dead;
      else bad(c, "metadata-invalid", `${path}.dead_letter_queue must be a queue name`, `${path}.dead_letter_queue`);
    }
    out.push(consumer);
  });
  return out;
}

function validateCrons(c: Collector, raw: Input): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || (raw.crons !== undefined && !isStringArray(raw.crons))) {
    bad(c, "metadata-invalid", "metadata.triggers.crons must be an array of cron expressions", "metadata.triggers");
    return undefined;
  }
  const crons: string[] = [];
  (raw.crons ?? []).forEach((expression, at) => {
    const cron = isString(expression) ? normalizeCron(expression) : null;
    if (cron === null)
      bad(
        c,
        "metadata-invalid",
        `triggers.crons: ${JSON.stringify(expression)} is not a cron the Cloud accepts (5 fields of digits, letters and * , / -, at most 128 characters)`,
        `metadata.triggers.crons[${at}]`,
      );
    else crons.push(cron);
  });
  if (crons.length > MAX_CRONS)
    bad(
      c,
      "limit-exceeded",
      `triggers.crons lists ${crons.length} crons; the Cloud takes at most ${MAX_CRONS} per app`,
      "metadata.triggers.crons",
    );
  return crons;
}

type Dates = { declared: string; effective: string };

function validateDate(c: Collector, declared: Input, options: ValidateMetadataOptions): Dates | undefined {
  const path = "metadata.compatibility_date";
  if (!isString(declared) || !isCalendarDate(declared)) {
    bad(c, "compat-date-invalid", "metadata.compatibility_date is required, as YYYY-MM-DD", path);
    return undefined;
  }
  if (options.now !== undefined && declared > options.now.toISOString().slice(0, 10))
    bad(c, "compat-date-invalid", `compatibility_date ${declared} is in the future`, path);
  if (options.maxCompatibilityDate !== undefined && declared > options.maxCompatibilityDate)
    bad(
      c,
      "compat-date-invalid",
      `compatibility_date ${declared} is newer than the newest date this builder knows, ${options.maxCompatibilityDate}`,
      path,
    );
  if (options.compatibilityFloor !== undefined && declared < options.compatibilityFloor) {
    // The build date must stay inside every bound the declared date had to meet.
    const floor = options.compatibilityFloor;
    if (options.maxCompatibilityDate !== undefined && floor > options.maxCompatibilityDate)
      bad(
        c,
        "compat-date-invalid",
        `compatibility_date ${declared} is Cloudflare's date and builds as ${floor}, which is newer than the newest date this builder knows, ${options.maxCompatibilityDate}`,
        path,
      );
    if (options.now !== undefined && floor > options.now.toISOString().slice(0, 10))
      bad(c, "compat-date-invalid", `compatibility_date ${declared} builds as ${floor}, which is in the future`, path);
    c.warnings.push(
      `compatibility_date ${declared} is Cloudflare's date: the build uses ${options.compatibilityFloor}`,
    );
    return { declared, effective: options.compatibilityFloor };
  }
  return { declared, effective: declared };
}

function validateFlags(c: Collector, raw: Input): string[] {
  if (raw === undefined) return [];
  if (!isStringArray(raw)) {
    bad(
      c,
      "metadata-invalid",
      "metadata.compatibility_flags must be an array of strings",
      "metadata.compatibility_flags",
    );
    return [];
  }
  const flags: string[] = [];
  for (const flag of new Set(raw)) {
    if (SUPPORTED_COMPATIBILITY_FLAGS.includes(flag)) flags.push(flag);
    else
      bad(
        c,
        "flag-unsupported",
        `compatibility flag "${flag}" is not supported (supported: ${SUPPORTED_COMPATIBILITY_FLAGS.join(", ")})`,
        "metadata.compatibility_flags",
      );
  }
  return flags;
}

function validateBindings(c: Collector, raw: Input): WorkerBinding[] {
  if (raw === undefined) return [];
  if (!isArray(raw)) {
    bad(c, "metadata-invalid", "metadata.bindings must be an array", "metadata.bindings");
    return [];
  }
  const bindings: WorkerBinding[] = [];
  const names = new Set<string>();
  raw.forEach((entry, index) => {
    const binding = validateBinding(c, entry, index);
    if (binding === undefined) return;
    if (names.has(binding.name))
      bad(c, "binding-invalid", `two bindings are named "${binding.name}"`, `metadata.bindings[${index}].name`);
    names.add(binding.name);
    bindings.push(binding);
  });
  // The wrapper takes one assets binding and one version metadata binding.
  for (const type of ["assets", "version_metadata"] as const)
    if (bindings.filter((b) => b.type === type).length > 1)
      bad(c, "binding-invalid", `an upload has at most one ${type} binding`, "metadata.bindings");
  // 64 counts record bindings and services; baked vars and version metadata are not bindings of the record.
  const counted = bindings.filter(
    (b) => b.type !== "plain_text" && b.type !== "json" && b.type !== "version_metadata",
  ).length;
  if (counted > MAX_BINDINGS)
    bad(
      c,
      "limit-exceeded",
      `${counted} bindings (secrets, services and assets count); the Cloud takes at most ${MAX_BINDINGS} per app`,
      "metadata.bindings",
    );
  return bindings;
}

function validateKeep(c: Collector, raw: Input): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!isStringArray(raw)) {
    bad(c, "metadata-invalid", "metadata.keep_bindings must be an array of strings", "metadata.keep_bindings");
    return undefined;
  }
  const kept = [...new Set(raw)];
  for (const type of kept)
    if (type !== "secret_text" && type !== "secret_key")
      bad(
        c,
        "binding-type-unsupported",
        `keep_bindings "${type}" is not supported; only secret_text is kept`,
        "metadata.keep_bindings",
      );
  return kept;
}

/**
 * Check a script-upload metadata object and return it normalised: every refusal and every accepted field is decided here,
 * so the API, the emit unit and the CLI agree. Values of `secret_text` pass through untouched (the API takes them out
 * at its edge with `secretValues`); nothing here logs or copies them elsewhere.
 */
export function validateMetadata(input: Input, options: ValidateMetadataOptions = {}): MetadataResult {
  const c: Collector = { errors: [], warnings: [] };
  if (!isRecord(input))
    return { ok: false, errors: [issue("metadata-invalid", "metadata must be an object", "metadata")] };
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  } catch {
    // A cycle, a BigInt, or nesting past the serializer's stack: a JavaScript caller can hand any of them in.
    return { ok: false, errors: [issue("metadata-invalid", "metadata cannot be serialized to JSON", "metadata")] };
  }
  if (size > MAX_METADATA_BYTES)
    return {
      ok: false,
      errors: [issue("limit-exceeded", `metadata is ${size} bytes; the limit is ${MAX_METADATA_BYTES}`, "metadata")],
    };

  if (input.body_part !== undefined)
    bad(
      c,
      "service-worker-unsupported",
      "service-worker format is not supported; upload an ES module",
      "metadata.body_part",
    );

  const mainModule = input.main_module;
  if (!isString(mainModule) || moduleNameProblem(mainModule) !== null)
    bad(c, "metadata-invalid", "metadata.main_module must name an uploaded module", "metadata.main_module");
  else if (options.bundleMainModule !== undefined && options.bundleMainModule !== mainModule)
    bad(
      c,
      "metadata-invalid",
      `main_module "${mainModule}" does not match the bundle's main_module "${options.bundleMainModule}"`,
      "metadata.main_module",
    );

  const dates = validateDate(c, input.compatibility_date, options);
  const date = dates?.effective;
  const flags = validateFlags(c, input.compatibility_flags);
  let node: NodeFlags | undefined;
  if (dates !== undefined && c.errors.length === 0) {
    const resolved = resolveNodeFlags(flags, dates.declared);
    if (resolved.ok) node = resolved.value;
    else bad(c, "flag-unsupported", resolved.message, "metadata.compatibility_flags");
  }
  const bindings = validateBindings(c, input.bindings);
  const keepBindings = validateKeep(c, input.keep_bindings);
  if (input.keep_assets !== undefined && !isBoolean(input.keep_assets))
    bad(c, "metadata-invalid", "metadata.keep_assets must be a boolean", "metadata.keep_assets");
  const migrations = validateMigrations(c, input.migrations);
  const assets = validateAssets(c, input.assets);
  const crons = validateCrons(c, input.triggers);
  const consumers = validateConsumers(c, input.queue_consumers);

  const consumed = new Set<string>();
  for (const consumer of consumers ?? []) {
    const name = consumer.queue.toLowerCase();
    if (consumed.has(name))
      bad(
        c,
        "metadata-invalid",
        `queue_consumers names the queue "${consumer.queue}" twice`,
        "metadata.queue_consumers",
      );
    consumed.add(name);
  }
  const boundQueues = new Set(bindings.flatMap((b) => (b.type === "queue" ? [b.queue_name.toLowerCase()] : [])));
  for (const consumer of consumers ?? [])
    if (!boundQueues.has(consumer.queue.toLowerCase()))
      bad(
        c,
        "metadata-invalid",
        `queue_consumers names the queue "${consumer.queue}", which this app does not bind (queues are per app)`,
        "metadata.queue_consumers",
      );

  if (date !== undefined && options.assetStoreMinDate !== undefined && date < options.assetStoreMinDate) {
    const first = assets?.config?.run_worker_first;
    const reads = bindings.some((b) => b.type === "assets") || (first !== undefined && first !== false);
    if (reads)
      bad(
        c,
        "assets-date-unsupported",
        `a worker that reads its assets needs compatibility_date ${options.assetStoreMinDate} or later (it reads them from the asset store); this one has ${date}`,
        "metadata.compatibility_date",
      );
  }

  const ignored = IGNORED_METADATA_FIELDS.filter((field) => input[field] !== undefined);
  if (ignored.length > 0) c.warnings.push(`ignored: ${ignored.join(", ")} (no effect on Sproutboat Cloud)`);
  const unknown = Object.keys(input).filter((key) => !KNOWN_FIELDS.has(key));
  if (unknown.length > 0)
    bad(
      c,
      "metadata-invalid",
      `unknown metadata field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
      "metadata",
    );

  if (c.errors.length > 0 || dates === undefined || node === undefined || !isString(mainModule))
    return { ok: false, errors: c.errors };
  const value: WorkerMetadata = {
    main_module: mainModule,
    compatibility_date: dates.effective,
    declared_compatibility_date: dates.declared,
    compatibility_flags: flags,
    node,
    bindings,
  };
  if (keepBindings !== undefined) value.keep_bindings = keepBindings;
  if (isBoolean(input.keep_assets)) value.keep_assets = input.keep_assets;
  if (migrations !== undefined) value.migrations = migrations;
  if (assets !== undefined) value.assets = assets;
  if (crons !== undefined) value.triggers = { crons };
  if (consumers !== undefined) value.queue_consumers = consumers;
  const annotations = input.annotations;
  const message = isRecord(annotations) ? annotations["workers/message"] : undefined;
  if (isString(message)) value.message = message;
  return { ok: true, value, warnings: c.warnings };
}

/** `validateMetadata` with every safety check on, for an upload that reaches the Cloud. The options are required, not optional. */
export function validateMetadataForCloud(input: Input, validation: CloudValidation): MetadataResult {
  const missing = (field: string) =>
    new TypeError(`validateMetadataForCloud needs ${field}: a Cloud upload is always checked against it`);
  if (!(validation.now instanceof Date) || Number.isNaN(validation.now.getTime())) throw missing("now");
  for (const field of ["maxCompatibilityDate", "compatibilityFloor", "assetStoreMinDate"] as const)
    if (!isString(validation[field]) || !isCalendarDate(validation[field])) throw missing(field);
  return validateMetadata(input, validation);
}

/** The values of every `secret_text` binding that carries one, by name. For the API edge, which seals them. */
export function secretValues(metadata: Pick<WorkerMetadata, "bindings">): Map<string, string> {
  const out = new Map<string, string>();
  for (const binding of metadata.bindings)
    if (binding.type === "secret_text" && binding.text !== undefined) out.set(binding.name, binding.text);
  return out;
}

/** The metadata with every secret value removed: what may be stored, hashed and passed to the builder. */
export function stripSecretValues<T extends Pick<WorkerMetadata, "bindings">>(metadata: T): T {
  return {
    ...metadata,
    bindings: metadata.bindings.map((binding): WorkerBinding =>
      binding.type === "secret_text" ? { type: "secret_text", name: binding.name } : binding,
    ),
  };
}

/**
 * UTF-8 bytes of `text` once it is a JSON string literal (what JSON.stringify prints): a control character grows to 6, a
 * quote or backslash to 2, a lone surrogate to 6 (`\\udXXX`), and every other character stays as its UTF-8 bytes.
 */
function jsonLiteralBytes(text: string): number {
  let bytes = 2;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code < 32) bytes += 6;
    else if (code === 34 || code === 92) bytes += 2;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      text.charCodeAt(at + 1) >= 0xdc00 &&
      text.charCodeAt(at + 1) <= 0xdfff
    ) {
      bytes += 4;
      at += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

/** One module of a bundle: contents (the emit unit) or a digest (the API, before queueing). Type and name are unchecked input. */
export type ModuleCandidate = { name: Input; type: Input; content?: string | Uint8Array; sha256?: Input };

export type ValidateModulesOptions = { mainModule?: string };

/** Check the module list of a bundle: names, types, counts and sizes. Sizes are checked when contents are present. */
export function validateModules(
  modules: readonly ModuleCandidate[],
  options: ValidateModulesOptions = {},
): EmitIssue[] {
  const errors: EmitIssue[] = [];
  if (modules.length === 0) return [issue("module-missing", "the bundle has no modules", "modules")];
  if (modules.length > MAX_MODULES)
    errors.push(issue("limit-exceeded", `${modules.length} modules; at most ${MAX_MODULES}`, "modules"));
  const names = new Set<string>();
  let codeBytes = 0;
  let dataBytes = 0;
  let sourcemapBytes = 0;
  let totalBytes = 0;
  /** What the bundler is handed: code as written, text and data as the string literals they become. */
  let bundledBytes = 0;
  const encoder = new TextEncoder();
  modules.forEach((module, at) => {
    const path = `modules[${at}]`;
    const problem = moduleNameProblem(module.name);
    if (problem !== null || !isString(module.name)) {
      errors.push(issue("module-invalid", `${problem ?? "bad name"}: ${JSON.stringify(module.name)}`, `${path}.name`));
      return;
    }
    const name = module.name;
    if (names.has(name)) errors.push(issue("module-invalid", `two modules are named "${name}"`, `${path}.name`));
    names.add(name);
    const type = module.type;
    if (type === "wasm")
      errors.push(
        issue("module-type-unsupported", `WebAssembly modules are not supported ("${name}")`, `${path}.type`),
      );
    else if (type === "python")
      errors.push(issue("module-type-unsupported", `Python modules are not supported ("${name}")`, `${path}.type`));
    else if (!isString(type) || !MODULE_TYPES.some((known) => known === type))
      errors.push(
        issue(
          "module-type-unsupported",
          `module type ${JSON.stringify(type)} of "${name}" is not supported`,
          `${path}.type`,
        ),
      );
    if (module.sha256 !== undefined && !(isString(module.sha256) && /^[0-9a-f]{64}$/.test(module.sha256)))
      errors.push(
        issue("module-invalid", `module "${name}" needs a sha256 of 64 lowercase hex characters`, `${path}.sha256`),
      );
    const content = module.content;
    if (content === undefined) return;
    const bytes = content instanceof Uint8Array ? content.byteLength : encoder.encode(content).byteLength;
    totalBytes += bytes;
    if (type === "data") {
      dataBytes += bytes;
      if (dataBytes <= MAX_DATA_TOTAL_BYTES)
        for (const byte of content instanceof Uint8Array ? content : encoder.encode(content))
          bundledBytes += byte < 32 ? 6 : byte === 34 || byte === 92 || byte > 127 ? 2 : 1;
      else bundledBytes += bytes;
      if (bytes > MAX_DATA_MODULE_BYTES)
        errors.push(
          issue(
            "limit-exceeded",
            `data module "${name}" is ${bytes} bytes; at most ${MAX_DATA_MODULE_BYTES}`,
            `${path}.content`,
          ),
        );
    } else if (type === "sourcemap") sourcemapBytes += bytes;
    else if (type === "esm" || type === "cjs") {
      codeBytes += bytes;
      bundledBytes += bytes;
    } else if (type === "text") {
      codeBytes += bytes;
      bundledBytes += content instanceof Uint8Array ? bytes : jsonLiteralBytes(content);
    }
  });
  if (dataBytes > MAX_DATA_TOTAL_BYTES)
    errors.push(
      issue(
        "limit-exceeded",
        `the data modules total ${dataBytes} bytes; at most ${MAX_DATA_TOTAL_BYTES} (the module static-data region)`,
        "modules",
      ),
    );
  if (sourcemapBytes > MAX_SOURCEMAP_BYTES)
    errors.push(
      issue(
        "limit-exceeded",
        `the sourcemap modules total ${sourcemapBytes} bytes; at most ${MAX_SOURCEMAP_BYTES}`,
        "modules",
      ),
    );
  if (totalBytes > MAX_TOTAL_BYTES)
    errors.push(
      issue("limit-exceeded", `the modules total ${totalBytes} bytes; at most ${MAX_TOTAL_BYTES}`, "modules"),
    );
  if (bundledBytes > MAX_BUNDLED_BYTES && codeBytes <= MAX_CODE_BYTES)
    errors.push(
      issue(
        "limit-exceeded",
        `the modules grow to ${bundledBytes} bytes once text and data modules become string literals; at most ${MAX_BUNDLED_BYTES}`,
        "modules",
      ),
    );
  if (codeBytes > MAX_CODE_BYTES)
    errors.push(
      issue("limit-exceeded", `the code modules total ${codeBytes} bytes; at most ${MAX_CODE_BYTES}`, "modules"),
    );
  if (options.mainModule !== undefined) {
    const main = modules.find((module) => module.name === options.mainModule);
    if (main === undefined)
      errors.push(
        issue(
          "module-missing",
          `main_module "${options.mainModule}" is not one of the uploaded modules`,
          "metadata.main_module",
        ),
      );
    else if (main.type !== "esm")
      errors.push(
        issue(
          "module-type-unsupported",
          `main_module "${options.mainModule}" must be an ES module (type esm)`,
          "metadata.main_module",
        ),
      );
  }
  return errors;
}
