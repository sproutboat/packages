/**
 * Bundle uploaded modules into the one ESM module the compiler takes, without touching a disk. The resolver answers
 * every specifier itself: an uploaded module, a `cloudflare:*` external, a Node built-in under `nodejs_compat`
 * (a Sproutboat shim, else the bundler's own polyfill), and otherwise Cloudflare's "No such module".
 */
import { builtinModules } from "node:module";
import { SOCKETS_DATE, maskNonCode } from "@sproutboat/runtime";
import { EmitError, issue } from "./errors";
import { nodejsCompatEnabled } from "./flags";
import { MODULE_TYPES, type ModuleInput } from "./metadata";
import { NODE_SHIMS, SOCKET_NODE_SHIMS } from "./node-shims";

/** From this date the handler's own code gets `process` and `Buffer`, and `process.env` holds its text bindings. */
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

const POPULATE_PROCESS_ENV = `
const source = globalThis.env;
if (source !== undefined && source !== null) {
  const names = Object.getOwnPropertyNames(source);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (descriptor !== undefined && descriptor.get !== undefined) {
      Object.defineProperty(env, name, {
        enumerable: true,
        configurable: true,
        get() { try { const value = source[name]; return typeof value === "string" ? value : undefined; } catch (e) { return undefined; } },
        set(value) { Object.defineProperty(env, name, { value, writable: true, enumerable: true, configurable: true }); },
      });
    } else if (typeof source[name] === "string") {
      env[name] = source[name];
    }
  }
}`;

const processStub = (populateEnv: boolean) => `
const env = {};
${populateEnv ? POPULATE_PROCESS_ENV : ""}
function nextTick(fn, ...args) { Promise.resolve().then(() => fn(...args)); }
const process = { env, platform: "linux", arch: "wasm32", version: "v20.0.0", versions: {}, argv: [], browser: true, nextTick, emitWarning() {}, cwd() { return "/"; }, stderr: { write() {} }, stdout: { write() {} }, on() {}, off() {}, once() {}, emit() {} };
export default process;
`;

export type BundleInput = {
  modules: readonly ModuleInput[];
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
};

/** Import attributes (`with { type: "macro" }`, the file or sqlite loaders) run bundler features on hostile input: refused. */
const IMPORT_ATTRIBUTE = /(["'`])\s*(?:with|assert)\s*\{|\bimport\s*\([^)]*\{\s*(?:with|assert)\b/;

const text = (module: ModuleInput): string => {
  if (module.content instanceof Uint8Array) return new TextDecoder().decode(module.content);
  return module.content;
};

/** Cloudflare's wording for an import that names nothing uploaded. */
const noSuchModule = (specifier: string, importer: string) =>
  new EmitError([
    issue("no-such-module", `No such module "${specifier}"${importer === "" ? "" : `. Imported from "${importer}"`}`),
  ]);

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

/** `Buffer`, `process` and `global` as free names: bound to bundled code, as Workers has them under `nodejs_compat`. */
function bindNodeGlobals(source: string): string {
  const usesBuffer =
    /(?:^|[^.\w$])Buffer\s*[.(]/m.test(source) &&
    !/\b(?:import|require)\b[^;\n]*\bBuffer\b/.test(source) &&
    !/(?:const|let|var)\s+\{?\s*Buffer\b/.test(source);
  const usesProcess =
    /(?:^|[^.\w$])process\s*\./m.test(source) &&
    !/\b(?:import|require)\b[^;\n]*\bprocess\b/.test(source) &&
    !/(?:const|let|var|function)\s+\{?\s*process\b/.test(source);
  const usesGlobal =
    /(?:^|[^.\w$])global\s*\./m.test(source) && !/(?:const|let|var|function)\s+\{?\s*global\b/.test(source);
  if (!usesBuffer && !usesProcess && !usesGlobal) return source;
  const esm = /^\s*(?:import|export)\s/m.test(source);
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
export function prepareModuleSource(
  source: string,
  input: Pick<BundleInput, "compatibilityDate" | "compatibilityFlags">,
): string {
  if (input.compatibilityDate < SOCKETS_DATE) return source;
  const renamed = source.replace(
    SHADOWED_BUILTIN_FUNCTIONS,
    (_m, lead: string, name: string) => `${lead}function ${name}_sb(`,
  );
  if (!nodejsCompatEnabled(input.compatibilityFlags, input.compatibilityDate)) return renamed;
  return bindNodeGlobals(renamed);
}

/** A syntax error is the bundler's to report, with its own message. */
function scanImports(source: string) {
  try {
    return new Bun.Transpiler({ loader: "js" }).scanImports(source);
  } catch {
    return [];
  }
}

/** Refuse what must never reach the bundler: import attributes and `bun:` specifiers in any code module. */
export function checkImportAttributes(modules: readonly ModuleInput[]): void {
  for (const module of modules) {
    if (module.type !== "esm" && module.type !== "cjs") continue;
    for (const entry of scanImports(text(module)))
      if (entry.path.startsWith("bun:")) throw noSuchModule(entry.path, module.name);
    if (IMPORT_ATTRIBUTE.test(maskNonCode(text(module))))
      throw new EmitError([
        issue(
          "import-attribute-refused",
          `module "${module.name}" uses an import attribute (with { ... }); uploads accept none`,
          `modules.${module.name}`,
        ),
      ]);
  }
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
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g))
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

/** Bundle the upload into one ESM module. A single self-contained module passes through, only prepared (no re-print). */
export async function bundleModules(input: BundleInput): Promise<string> {
  checkImportAttributes(input.modules);
  const byName = new Map(input.modules.map((module) => [module.name, module]));
  const main = byName.get(input.mainModule);
  if (main === undefined || main.type !== "esm")
    throw new EmitError([issue("module-missing", `main_module "${input.mainModule}" is not an uploaded ES module`)]);
  const compat = nodejsCompatEnabled(input.compatibilityFlags, input.compatibilityDate);
  const sockets = input.compatibilityDate >= SOCKETS_DATE;

  const mainText = text(main);
  const prepared = prepareModuleSource(mainText, input);
  const imports = new Bun.Transpiler({ loader: "js" }).scanImports(prepared);
  if (imports.every((entry) => EXTERNAL.has(entry.path))) return prepared;

  const shims: Map<string, string> = new Map(Object.entries(NODE_SHIMS));
  if (sockets) for (const [name, shim] of Object.entries(SOCKET_NODE_SHIMS)) shims.set(name, shim);
  const globalsUsed = compat && sockets;

  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({
      entrypoints: [`${ENTRY}${input.mainModule}`],
      target: "browser",
      format: "esm",
      minify: false,
      splitting: false,
      sourcemap: "none",
      external: [...EXTERNAL],
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
              if (specifier === PROCESS_SPECIFIER && globalsUsed) return { path: specifier, namespace: NS_GLOBAL };
              const name = resolveName(specifier, importer);
              const uploaded = name === null ? undefined : byName.get(name);
              if (uploaded !== undefined) {
                if (uploaded.type === "sourcemap") throw noSuchModule(specifier, importer);
                return { path: uploaded.name, namespace: NS_MODULE };
              }
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
              contents: processStub(input.compatibilityDate >= PROCESS_GLOBAL_DATE),
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
              return { contents: prepareModuleSource(text(module), input), loader: "js" };
            });
          },
        },
      ],
    });
  } catch (cause) {
    if (cause instanceof EmitError) throw cause;
    const errors = cause instanceof AggregateError ? cause.errors : [cause];
    const first = errors.find((error) => error instanceof EmitError);
    if (first instanceof EmitError) throw first;
    // The bundler hands a plugin's error on as a plain Error with the same message.
    const missing = errors.find((error) => error instanceof Error && error.message.startsWith("No such module"));
    if (missing instanceof Error) throw new EmitError([issue("no-such-module", missing.message)]);
    throw new EmitError([
      issue(
        "bundle-failed",
        `could not bundle ${input.mainModule}:\n${errors.map((e) => `  ${e instanceof Error ? e.message : String(e)}`).join("\n")}`,
      ),
    ]);
  }
  if (!built.success) {
    const message = built.logs.map((log) => log.message).find((line) => line.startsWith("No such module"));
    if (message !== undefined) throw new EmitError([issue("no-such-module", message)]);
    throw new EmitError([
      issue(
        "bundle-failed",
        `could not bundle ${input.mainModule}:\n${built.logs.map((log) => `  ${log.message}`).join("\n")}`,
      ),
    ]);
  }
  const [output] = built.outputs;
  if (output === undefined) throw new EmitError([issue("bundle-failed", "the bundler produced no output")]);
  return output.text();
}
