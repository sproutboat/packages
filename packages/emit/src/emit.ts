/**
 * `emitFromBundle`: modules plus Cloudflare metadata in, the module Sproutboat compiles out. The same function runs in the
 * Cloud builder and on a developer's machine; a host that has the prelude passes it, the builder passes none.
 */
import {
  neutraliseExportsDetailed,
  wrapNativeFetchHandler,
  type SubtleMode,
  type Transport,
} from "@sproutboat/runtime";
import { checkCapabilities } from "./capability";
import { deriveBindings, type DerivedBindings } from "./bindings";
import { EmitError, issue } from "./errors";
import type { Input } from "./json";
import {
  validateMetadata,
  validateModules,
  type ModuleInput,
  type ValidateMetadataOptions,
  stripSecretValues,
  type WorkerMetadata,
} from "./metadata";
import { bundleModules, exportedNames } from "./virtual-bundle";

/** Where the Cloud's own region starts: sproutd cuts a generated file here and at the last `export default {`. */
export const REGION_MARKER = "globalThis.__sbCompat = ";

export type BakedAssets = { manifest: unknown; files: { [path: string]: string } };

export type EmitInput = {
  modules: readonly ModuleInput[];
  /** Cloudflare script-upload metadata, as parsed JSON. Validated here, so a caller cannot skip it. */
  metadata: Input;
};

export type EmitOptions = {
  /** The app's name, baked as `__sbAppName`. */
  name: string;
  /**
   * The prelude to put in front (a host that compiles locally). Left out, the output starts at REGION_MARKER, which is
   * all the Cloud's scan keeps of a generated file.
   */
  prelude?: string;
  /** `embedded` is what the Cloud compiles and what a standalone binary uses. */
  transport?: Transport;
  subtle?: SubtleMode;
  port?: number;
  /** Secret names the app already holds: bound as well, as Cloudflare binds every secret of a Worker. */
  extraSecretNames?: readonly string[];
  /** Needed when the upload has a `version_metadata` binding. The caller owns the id (the API derives it from the input hash). */
  versionMetadata?: { id: string; tag: string; timestamp: string };
  /** Files baked into the module (a standalone build). Without it a Cloud emit carries the assets settings only. */
  bakedAssets?: BakedAssets;
  validation?: ValidateMetadataOptions;
};

export type EmitResult = {
  /** Prelude, if one was given, then the region. */
  source: string;
  /** From REGION_MARKER to the end: the contract with the Cloud. */
  region: string;
  /** The single module the compiler sees, before the wrap. */
  bundled: string;
  metadata: WorkerMetadata;
  bindings: DerivedBindings;
  warnings: string[];
};

function assetsSettings(metadata: WorkerMetadata): BakedAssets | undefined {
  const has = metadata.assets !== undefined || metadata.bindings.some((binding) => binding.type === "assets");
  if (!has) return undefined;
  const config = metadata.assets?.config;
  return {
    manifest: {
      notFound: config?.not_found_handling ?? "none",
      runSproutFirst: config?.run_worker_first ?? false,
      files: {},
    },
    files: {},
  };
}

export async function emitFromBundle(input: EmitInput, options: EmitOptions): Promise<EmitResult> {
  const checked = validateMetadata(input.metadata, options.validation);
  if (!checked.ok) throw new EmitError(checked.errors);
  const metadata = checked.value;
  const moduleIssues = validateModules(input.modules, { mainModule: metadata.main_module });
  if (moduleIssues.length > 0) throw new EmitError(moduleIssues);

  const transport = options.transport ?? "embedded";
  const bindings = deriveBindings(metadata, { extraSecretNames: options.extraSecretNames });
  if (bindings.versionMetadata !== undefined && options.versionMetadata === undefined)
    throw new EmitError([
      issue(
        "binding-invalid",
        `the upload binds version_metadata (${bindings.versionMetadata}), so the caller must give versionMetadata`,
      ),
    ]);

  const bundled = await bundleModules({
    modules: input.modules,
    mainModule: metadata.main_module,
    compatibilityDate: metadata.compatibility_date,
    compatibilityFlags: metadata.compatibility_flags,
  });
  checkCapabilities(bundled, metadata.compatibility_date);

  const exported = neutraliseExportsDetailed(bundled);
  const names = exportedNames(bundled);
  for (const entry of bindings.runtime.do)
    if (!names.has(entry.className) && exported?.aliases[entry.className] === undefined)
      throw new EmitError([
        issue(
          "do-class-not-exported",
          `durable_object_namespace ${entry.binding} names the class "${entry.className}", which ${metadata.main_module} does not export; export the class so the Cloud can run it`,
        ),
      ]);

  let assets = options.bakedAssets ?? assetsSettings(metadata);
  if (transport !== "embedded") assets = undefined;
  let wrapped: string;
  try {
    wrapped = wrapNativeFetchHandler(
      bundled,
      options.prelude ?? "",
      // SAFETY: the wrapper only JSON.stringifies vars into `const env = ...`, so a JSON value is as good as a string here.
      bindings.runtime.vars as { [name: string]: string },
      bindings.runtime,
      options.port,
      metadata.compatibility_date,
      options.name,
      assets,
      transport,
      bindings.versionMetadata === undefined || options.versionMetadata === undefined
        ? undefined
        : { binding: bindings.versionMetadata, ...options.versionMetadata },
      options.subtle ?? "auto",
    );
  } catch (cause) {
    throw new EmitError([issue("handler-missing", cause instanceof Error ? cause.message : String(cause))]);
  }
  const at = wrapped.indexOf(REGION_MARKER);
  if (at < 0) throw new EmitError([issue("bundle-failed", "the wrapper's output has no region marker")]);
  const region = wrapped.slice(at);
  return {
    source: options.prelude === undefined ? region : wrapped,
    region,
    bundled,
    metadata: stripSecretValues(metadata),
    bindings,
    warnings: [...checked.warnings, ...bindings.warnings],
  };
}
