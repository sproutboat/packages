/**
 * Bundle uploaded modules into the one ESM module the compiler takes, without touching a disk. The resolver answers
 * every specifier itself: an uploaded module, a `cloudflare:*` external, a Node built-in under `nodejs_compat`
 * (a Sproutboat shim, else the bundler's own polyfill), and otherwise Cloudflare's "No such module".
 */
import { builtinModules } from "node:module";
import { SOCKETS_DATE, maskNonCode } from "@sproutboat/runtime";
import { EmitError, issue, type EmitIssue } from "./errors";
import type { NodeFlags } from "./flags";
import { MAX_BUNDLED_BYTES } from "./limits";
import { MODULE_TYPES, type ModuleInput } from "./metadata";
import { NODE_SHIMS, SOCKET_NODE_SHIMS } from "./node-shims";
import { bundlerIssues, checkCodeModule, noSuchModule, scanImports } from "./source-check";

/** The date a CLI project (which has no flags) gets `process` and `Buffer` for its own code. Cloudflare derives them from flags. */
export const PROCESS_GLOBAL_DATE = "2026-11-23";

const ENTRY = "sb-entry:";
const NS_MODULE = "sb-module";
const NS_SHIM = "sb-shim";
const NS_GLOBAL = "sb-global";
const PROCESS_SPECIFIER = "sb-node-process";
const EXTERNAL = new Set(["cloudflare:workers", "cloudflare:sockets"]);

/**
 * Porffor lists the global builtin functions on the global object of every unit, and a function named like one of them
 * drops the entry from that unit alone, so such an app is rejected at admission. The name is only visible inside the
 * function, so renaming it is safe unless the body calls itself by that name.
 */
const SHADOWED_BUILTIN_FUNCTIONS =
  /([=(:,?&|]\s*|\breturn\s+)function\s+(escape|unescape|eval|isNaN|isFinite|parseInt|parseFloat|encodeURI|encodeURIComponent|decodeURI|decodeURIComponent)\s*\(/g;

/** Rename in code only: text inside a string, template or comment stays as written. */
function renameShadowing(source: string): string {
  const masked = maskNonCode(source);
  let out = "";
  let copied = 0;
  for (const match of masked.matchAll(SHADOWED_BUILTIN_FUNCTIONS)) {
    const name = match[2]!;
    const nameAt = masked.indexOf(name, match.index + match[1]!.length);
    out += `${source.slice(copied, nameAt)}${name}_sb`;
    copied = nameAt + name.length;
  }
  return out + source.slice(copied);
}

/**
 * Cloudflare fills process.env with the bindings that carry text or JSON: vars, secrets and version metadata. The names
 * are known when the stub is written, so no other binding (a KV namespace, a Durable Object) can be mistaken for one.
 */
const populateProcessEnv = (names: readonly string[]) => `
const source = globalThis.env;
if (source !== undefined && source !== null) {
  const names = ${JSON.stringify(names)};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined) {
      Object.defineProperty(env, name, {
        enumerable: true,
        configurable: true,
        get() { try { return source[name]; } catch (e) { return undefined; } },
        set(value) { Object.defineProperty(env, name, { value, writable: true, enumerable: true, configurable: true }); },
      });
    } else {
      env[name] = descriptor.value;
    }
  }
}`;

const processStub = (envNames: readonly string[] | undefined) => `
const env = {};
${envNames === undefined ? "" : populateProcessEnv(envNames)}
function nextTick(fn, ...args) { Promise.resolve().then(() => fn(...args)); }
const process = { env, platform: "linux", arch: "wasm32", version: "v20.0.0", versions: {}, argv: [], browser: true, nextTick, emitWarning() {}, cwd() { return "/"; }, stderr: { write() {} }, stdout: { write() {} }, on() {}, off() {}, once() {}, emit() {} };
export default process;
export { env, nextTick };
`;

export type BundleInput = {
  modules: readonly ModuleInput[];
  mainModule: string;
  /** The date the build runs as (the declared date, raised to the floor). Not what decides Node support. */
  compatibilityDate: string;
  /** Node support, decided from the flags and the DECLARED date (see flags.ts). */
  node: NodeFlags;
  /** The bindings `process.env` holds when `node.populateProcessEnv` is on: text, JSON and secret names. */
  processEnvNames?: readonly string[];
};

const text = (module: ModuleInput): string => {
  if (module.content instanceof Uint8Array) return new TextDecoder().decode(module.content);
  return module.content;
};

/** The uploaded name a specifier means: `./x` and `../x` from the importer's directory, anything else from the root. */
function resolveName(specifier: string, importer: string): string | null {
  const parts = specifier.startsWith("./") || specifier.startsWith("../") ? importer.split("/").slice(0, -1) : [];
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (parts.pop() === undefined) return null;
    } else parts.push(segment);
  }
  return parts.join("/");
}

const builtinName = (specifier: string): string | null => {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return builtinModules.includes(bare) ? bare : null;
};

/**
 * Whether a statement names `import` or `require` and, later on the same line or before the next `;`, the word `name`.
 * Segments are split at `;` and newlines and each is read once, so the cost is linear in the source.
 */
function importsName(source: string, name: string): boolean {
  const word = new RegExp(`\\b${name}\\b`, "g");
  const importish = /\b(?:import|require)\b/;
  const breaks = /[;\n]/g;
  let segmentEnd = -1;
  let importEnd = -1;
  for (const match of source.matchAll(word)) {
    if (match.index >= segmentEnd) {
      // The search back stops at the end of the previous segment, so each stretch of the source is read once.
      const gap = source.slice(segmentEnd + 1, match.index);
      const lastBreak = Math.max(gap.lastIndexOf(";"), gap.lastIndexOf("\n"));
      const segmentStart = segmentEnd + 1 + lastBreak + 1;
      breaks.lastIndex = match.index;
      segmentEnd = breaks.exec(source)?.index ?? source.length;
      const found = importish.exec(source.slice(segmentStart, segmentEnd));
      importEnd = found === null ? -1 : segmentStart + found.index + found[0].length;
    }
    if (importEnd !== -1 && match.index >= importEnd) return true;
  }
  return false;
}

/** `Buffer`, `process` and `global` as free names: bound to bundled code, as Workers has them under `nodejs_compat`. */
function bindNodeGlobals(source: string): string {
  const usesBuffer =
    /(?:^|[^.\w$])Buffer\s*[.(]/m.test(source) &&
    !importsName(source, "Buffer") &&
    !/(?:const|let|var|function|class)\s+(?:\{\s*)?Buffer\b/.test(source);
  const usesProcess =
    /(?:^|[^.\w$])process\s*\./m.test(source) &&
    !importsName(source, "process") &&
    !/(?:const|let|var|function)\s+(?:\{\s*)?process\b/.test(source);
  const usesGlobal =
    /(?:^|[^.\w$])global\s*\./m.test(source) && !/(?:const|let|var|function)\s+(?:\{\s*)?global\b/.test(source);
  if (!usesBuffer && !usesProcess && !usesGlobal) return source;
  const esm = /^[^\S\n]*(?:import|export)\s/m.test(source);
  let prefix = "";
  if (usesBuffer)
    prefix += esm ? `import { Buffer } from "node:buffer";\n` : `var { Buffer } = require("node:buffer");\n`;
  if (usesProcess)
    prefix += esm
      ? `import process from "${PROCESS_SPECIFIER}";\n`
      : `var process = require("${PROCESS_SPECIFIER}").default;\n`;
  if (usesGlobal) prefix += "var global = globalThis;\n";
  return prefix + source;
}

/** What the CLI's plugin does to each file: rename shadowing function names, and (under `nodejs_compat`) bind free globals. */
export function prepareModuleSource(source: string, input: Pick<BundleInput, "compatibilityDate" | "node">): string {
  if (input.compatibilityDate < SOCKETS_DATE) return source;
  const renamed = renameShadowing(source);
  if (!input.node.compat) return renamed;
  return bindNodeGlobals(renamed);
}

/** Every code module is checked before the bundler (or anything else that parses) sees it: see source-check.ts. */
export function checkCodeModules(modules: readonly ModuleInput[]): void {
  for (const module of modules)
    if (module.type === "esm" || module.type === "cjs") checkCodeModule(module.name, text(module));
}

function latin1Module(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `const s = ${JSON.stringify(binary)};\nconst b = new Uint8Array(s.length);\nfor (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);\nexport default b.buffer;\n`;
}

/** The names a module exports to the outside (the entry's own exports, after bundling). */
export function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  const code = maskNonCode(source);
  for (const m of code.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  ))
    names.add(m[1]!);
  for (const m of code.matchAll(/\bexport\s*\{([^{}]*)\}/g))
    for (const part of m[1]!.split(",")) {
      const exported = part
        .trim()
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (exported) names.add(exported);
    }
  return names;
}

/** What Bun.build's own options say beyond its typings: `macros: false` makes a macro import fail with "Macros are disabled". */
type BuildConfig = Parameters<typeof Bun.build>[0] & { macros: false };

function bundleIssuesOf(causes: readonly unknown[], mainModule: string): EmitIssue[] {
  return causes.flatMap((cause): EmitIssue[] => {
    if (cause instanceof EmitError) return cause.issues;
    const message = cause instanceof Error || cause instanceof BuildMessage ? cause.message : String(cause);
    // The bundler hands a plugin's error on as a plain Error with the same message.
    if (message.startsWith("No such module")) return [issue("no-such-module", message)];
    if (message === "Macros are disabled")
      return [
        issue(
          "import-attribute-refused",
          "a module uses an import attribute that makes the bundler run code (type: macro); uploads accept none",
        ),
      ];
    return bundlerIssues([cause], mainModule, (file) => file, "bundler");
  });
}

/** Bundle the upload into one ESM module. A single self-contained module passes through, only prepared (no re-print). */
export async function bundleModules(input: BundleInput): Promise<string> {
  checkCodeModules(input.modules);
  const byName = new Map(input.modules.map((module) => [module.name, module]));
  const main = byName.get(input.mainModule);
  if (main === undefined || main.type !== "esm")
    throw new EmitError([issue("module-missing", `main_module "${input.mainModule}" is not an uploaded ES module`)]);
  const compat = input.node.compat;
  // `nodejs_als` alone brings AsyncLocalStorage and nothing else of Node.
  const alsOnly = input.node.als;
  const sockets = input.compatibilityDate >= SOCKETS_DATE;

  const mainText = text(main);
  const prepared = prepareModuleSource(mainText, input);
  if (scanImports(main.name, prepared).every((entry) => EXTERNAL.has(entry.path))) return prepared;

  const shims: Map<string, string> = new Map(Object.entries(NODE_SHIMS));
  if (sockets) for (const [name, shim] of Object.entries(SOCKET_NODE_SHIMS)) shims.set(name, shim);
  const globalsUsed = compat && sockets;

  const config: BuildConfig = {
    entrypoints: [`${ENTRY}${input.mainModule}`],
    target: "browser",
    format: "esm",
    minify: false,
    splitting: false,
    sourcemap: "none",
    external: [...EXTERNAL],
    macros: false,
    plugins: [
      {
        name: "sproutboat-virtual-modules",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            const specifier = args.path;
            if (args.importer === "" && specifier.startsWith(ENTRY))
              return { path: specifier.slice(ENTRY.length), namespace: NS_MODULE };
            const importer = args.importer;
            if (EXTERNAL.has(specifier)) return { path: specifier, external: true };
            // The free `process` and `import process from "node:process"` are one object, as they are on Workers.
            if (globalsUsed && (specifier === PROCESS_SPECIFIER || builtinName(specifier) === "process"))
              return { path: PROCESS_SPECIFIER, namespace: NS_GLOBAL };
            const name = resolveName(specifier, importer);
            const uploaded = name === null ? undefined : byName.get(name);
            if (uploaded !== undefined) {
              if (uploaded.type === "sourcemap") throw noSuchModule(specifier, importer);
              return { path: uploaded.name, namespace: NS_MODULE };
            }
            if (alsOnly && (specifier === "node:async_hooks" || specifier === "async_hooks"))
              return { path: "node:async_hooks", namespace: NS_SHIM };
            if (compat && builtinName(specifier) !== null) {
              const shim = shims.get(specifier);
              if (shim !== undefined) return { path: specifier, namespace: NS_SHIM };
              // Bun's own polyfill of the built-in; nothing on a disk is read.
              return undefined;
            }
            throw noSuchModule(specifier, importer);
          });
          build.onLoad({ filter: /.*/, namespace: NS_SHIM }, (args) => ({
            contents: shims.get(args.path) ?? "",
            loader: "js",
          }));
          build.onLoad({ filter: /.*/, namespace: NS_GLOBAL }, () => ({
            contents: processStub(input.node.populateProcessEnv ? (input.processEnvNames ?? []) : undefined),
            loader: "js",
          }));
          build.onLoad({ filter: /.*/, namespace: NS_MODULE }, (args) => {
            const module = byName.get(args.path);
            if (module === undefined || !MODULE_TYPES.some((type) => type === module.type))
              throw noSuchModule(args.path, "");
            if (module.type === "text")
              return { contents: `export default ${JSON.stringify(text(module))};\n`, loader: "js" };
            if (module.type === "data") {
              const bytes =
                module.content instanceof Uint8Array ? module.content : new TextEncoder().encode(module.content);
              return { contents: latin1Module(bytes), loader: "js" };
            }
            const original = text(module);
            const contents = prepareModuleSource(original, input);
            // The checks ran on the upload; what the bundler is handed is checked again where it differs.
            if (contents !== original) checkCodeModule(module.name, contents);
            return { contents, loader: "js" };
          });
        },
      },
    ],
  };
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build(config);
  } catch (cause) {
    throw new EmitError(bundleIssuesOf(cause instanceof AggregateError ? cause.errors : [cause], input.mainModule));
  }
  if (!built.success) throw new EmitError(bundleIssuesOf(built.logs, input.mainModule));
  const [output] = built.outputs;
  if (output === undefined) throw new EmitError([issue("bundle-failed", "the bundler produced no output")]);
  const bundled = await output.text();
  if (bundled.length > MAX_BUNDLED_BYTES)
    throw new EmitError([
      issue("limit-exceeded", `the bundle is ${bundled.length} bytes; at most ${MAX_BUNDLED_BYTES}`, "modules"),
    ]);
  return bundled;
}
