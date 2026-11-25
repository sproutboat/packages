/**
 * The build-independent half of sprout compilation: the wrapper that turns `export default { fetch }` into a
 * native-fetch module, plus `Bindings` and the env readers. No imports on purpose: the monorepo consumes it via the
 * `@sproutboat/runtime/wrap` export for its host-native (non-musl) compile path, without the toolchain.
 */

/** Read as text and string-prepended before Porffor sees it, never imported. */
export const preludePath = new URL("./native-fetch-prelude.js", import.meta.url);

/**
 * #15 - the two transports the prelude can be built with. Both define `__sbCall(reqJson) -> replyJson` and nothing
 * else, so one conformance suite holds both honest: `broker` talks to the per-deployment broker over loopback,
 * `embedded` compiles SQLite into the sprout.
 */
export type Transport = "broker" | "embedded";
export const transportPath = (transport: Transport): URL =>
  new URL(transport === "embedded" ? "./transport-embedded.js" : "./transport-broker.js", import.meta.url);

export const TRANSPORT_MARKER =
  "// TRANSPORT: wrap.ts splices one of transport-broker.js / transport-embedded.js here.";

// The server honours $PORT at runtime (patches/porffor-render.patch); this is only the fallback.
const DEFAULT_PORT = 8080;

/**
 * What an artifact with no `compatibilityDate` means. Binaries are immutable and `rollback` can reactivate one at
 * any time, so a behaviour change that could break a deployed handler is gated in the prelude on
 * `__sbCompat >= "YYYY-MM-DD"`; a project opts in by moving `compatibility_date` and rebuilding.
 */
export const BASELINE_COMPATIBILITY_DATE = "2026-08-26";

/** Binding names a project declares. `do` maps a binding name to a Durable Object class name. */
export type Bindings = {
  kv: string[];
  secrets: string[];
  d1: string[];
  r2: string[];
  queues: string[];
  /** Queue name and consumer settings per binding (`queueSettings` in @sproutboat/config). Absent from older artifacts: each queue is then named by its binding, default settings. */
  queueConfig?: QueueSettings[];
  analytics: string[];
  do: Array<{ binding: string; className: string }>;
  /** #48 - worker-to-worker: binding -> project. The hostname is a runtime input, not part of the artifact. */
  services: Array<{ binding: string; service: string }>;
  crons: string[];
  ratelimiters: Array<{ binding: string; limit: number; period: number }>;
  /** Static-asset binding name for `env.<NAME>.fetch(request)`; `""` when assets are edge-only. */
  assets: string;
};

export type QueueSettings = {
  binding: string;
  queue: string;
  maxBatchSize?: number;
  maxBatchTimeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  deadLetterQueue?: string;
};

export const EMPTY_BINDINGS: Bindings = {
  kv: [],
  secrets: [],
  d1: [],
  r2: [],
  queues: [],
  analytics: [],
  do: [],
  services: [],
  crons: [],
  ratelimiters: [],
  assets: "",
};

export function hasEntryHandler(source: string): boolean {
  return /\b(fetch|scheduled|queue)\s*\(/.test(source) || /\bextends\s+WorkerEntrypoint\b/.test(source);
}

function hasBindings(b: Bindings): boolean {
  return (
    b.kv.length > 0 ||
    b.secrets.length > 0 ||
    b.d1.length > 0 ||
    b.r2.length > 0 ||
    b.queues.length > 0 ||
    b.analytics.length > 0 ||
    b.do.length > 0 ||
    b.services.length > 0 ||
    b.ratelimiters.length > 0 ||
    b.assets !== ""
  );
}

/**
 * Turn the module's exports into plain top-level declarations so the handler is reachable as `__sbHandlers` and
 * Durable Object classes stay addressable. Two forms reach us: inline (`export default { fetch }`) and a bundle's
 * trailing `export { src_default as default, Counter }` (the normal case since #89). Returns null when neither matches.
 */
/**
 * `cloudflare:workers` is not a module here: its names are prelude globals, so each import becomes a
 * destructuring of globalThis (`as` renames included). The CLI leaves the specifier external for this.
 */
export function inlineWorkersImports(source: string): string {
  // `cloudflare:sockets` (compat 2026-11-17): connect() is a prelude global; postgres/cf loads it lazily.
  source = source.replace(/\bimport\(\s*["'`]cloudflare:sockets["'`]\s*\)/g, "Promise.resolve(globalThis.__sbSockets)");
  // The dynamic form of cloudflare:workers (Alchemy) resolves to a namespace of the same four names. Read when the
  // import runs, so a handler importing at module top level sees the env the tail already set.
  source = source.replace(
    /\bimport\(\s*["'`]cloudflare:workers["'`]\s*\)/g,
    "Promise.resolve({ env: globalThis.env, WorkerEntrypoint: globalThis.WorkerEntrypoint, DurableObject: globalThis.DurableObject, RpcTarget: globalThis.RpcTarget })",
  );
  source = source.replace(
    /^import\s*\{([^}]*)\}\s*from\s*["']cloudflare:sockets["'];?[ \t]*$/gm,
    (_match, names: string) => {
      const pairs = names
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.replace(/^(\S+)\s+as\s+(\S+)$/, "$1: $2"));
      return `const { ${pairs.join(", ")} } = globalThis.__sbSockets;`;
    },
  );
  return source.replace(
    /^import\s*\{([^}]*)\}\s*from\s*["']cloudflare:workers["'];?[ \t]*$/gm,
    (_match, names: string) => {
      const pairs = names
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.replace(/^(\S+)\s+as\s+(\S+)$/, "$1: $2"));
      return `const { ${pairs.join(", ")} } = globalThis;`;
    },
  );
}

const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
const STRING_BODY = { '"': /[^"\\\n]*(?:\\[\s\S][^"\\\n]*)*"/y, "'": /[^'\\\n]*(?:\\[\s\S][^'\\\n]*)*'/y } as const;
const TEMPLATE_BODY = /[^`\\$]*(?:(?:\\[\s\S]|\$(?!\{))[^`\\$]*)*/y;
const REGEX_BODY = /(?:[^/\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*/y;
const SPECIAL = /["'`/{}]/g;

/**
 * The module with strings, template text, regex bodies and comments blanked: same length and line breaks, so offsets match the source. Quote and
 * slash delimiters stay. A tokenizer, not a parser: `/` after `)` or `]` is division, a regex that does not close on its line is left as code.
 */
export function maskNonCode(source: string): string {
  let out = "";
  let copied = 0;
  const blank = (from: number, to: number) => {
    out += source.slice(copied, from) + source.slice(from, to).replace(/[^\n]/g, " ");
    copied = to;
  };
  const templateStack: number[] = [];
  let depth = 0;
  // Template text from `i` (just after a backtick or a closing `}`) up to the next `${` or closing backtick.
  const template = (i: number): number => {
    TEMPLATE_BODY.lastIndex = i;
    const m = TEMPLATE_BODY.exec(source);
    const end = i + (m === null ? 0 : m[0].length);
    if (source.startsWith("${", end)) {
      blank(i, end);
      templateStack.push(depth);
      return end + 2;
    }
    // The closing backtick (or the end of an unterminated template).
    blank(i, end);
    return end + 1;
  };
  let i = 0;
  while (i < source.length) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(source);
    if (m === null) break;
    const at = m.index;
    const c = source[at];
    i = at + 1;
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === depth) {
        templateStack.pop();
        i = template(i);
      } else if (depth > 0) depth--;
    } else if (c === '"' || c === "'") {
      const body = STRING_BODY[c];
      body.lastIndex = i;
      const s = body.exec(source);
      if (s !== null) {
        blank(i, i + s[0].length - 1);
        i += s[0].length;
      }
    } else if (c === "`") {
      i = template(i);
    } else {
      const next = source[i];
      if (next === "/") {
        const nl = source.indexOf("\n", i);
        const end = nl < 0 ? source.length : nl;
        blank(at, end);
        i = end;
      } else if (next === "*") {
        const close = source.indexOf("*/", i + 1);
        const end = close < 0 ? source.length : close + 2;
        blank(at, end);
        i = end;
      } else {
        let p = at - 1;
        while (p >= 0 && /\s/.test(source[p]!)) p--;
        const prev = p >= 0 ? source[p]! : "";
        let regex = true;
        if (prev === ")" || prev === "]") regex = false;
        else if (/[\w$]/.test(prev)) {
          let w = p;
          while (w > 0 && /[\w$]/.test(source[w - 1]!)) w--;
          regex = REGEX_AFTER_WORD.has(source.slice(w, p + 1)) && source[w - 1] !== ".";
        }
        if (regex) {
          REGEX_BODY.lastIndex = i;
          const r = REGEX_BODY.exec(source);
          if (r !== null) {
            // The body is everything before the closing slash (the last one: flags have none); flags stay as code.
            blank(i, i + r[0].lastIndexOf("/"));
            i += r[0].length;
          }
        }
      }
    }
  }
  return out + source.slice(copied);
}

/** A literal-specifier `import("...")` in code: where it is (`start` to `end`), the specifier, and whether a failure is handled. */
export type DynamicImport = { start: number; end: number; specifier: string | null; handled: boolean };

/**
 * Every `import(` call in code. `specifier` is the text of a plain string or interpolation-free template argument
 * (`import(/* hint *\/ `node:sqlite`)` too), else null. `handled`: the call sits in a `try {` block or is followed by
 * `.catch(`, so a missing module is a caught error, the way a library probes for an optional Node API.
 */
export function dynamicImports(source: string, masked: string = maskNonCode(source)): DynamicImport[] {
  const sites: DynamicImport[] = [];
  const re = /(?<![.$\w])import\s*\(\s*/g;
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    const start = m.index;
    const open = re.lastIndex;
    let specifier: string | null = null;
    let end = open;
    const quote = masked[open];
    if (quote === '"' || quote === "'" || quote === "`") {
      const close = masked.indexOf(quote, open + 1);
      if (close > 0) {
        const text = source.slice(open + 1, close);
        const after = /^\s*\)/.exec(masked.slice(close + 1, close + 40));
        if (after !== null && !(quote === "`" && text.includes("${"))) {
          specifier = text;
          end = close + 1 + after[0].length;
        }
      }
    }
    if (specifier === null) {
      sites.push({ start, end: open, specifier, handled: false });
      continue;
    }
    let handled = /^\s*\.\s*catch\s*\(/.test(masked.slice(end, end + 40));
    // Walk the enclosing blocks outwards looking for a `try {`.
    for (let j = start - 1, level = 0; !handled && j >= 0; j--) {
      const ch = masked[j];
      if (ch === "}") level++;
      else if (ch === "{") {
        if (level > 0) level--;
        else if (/\btry\s*$/.test(masked.slice(Math.max(0, j - 12), j))) handled = true;
      }
    }
    sites.push({ start, end, specifier, handled });
  }
  return sites;
}

/**
 * `import("node:sqlite")` in a handled position becomes a rejected promise: there is no such module here, and the library
 * that probes for it (better-auth, Effect) already catches. Strings that merely contain the text are not touched.
 */
export function inlineNodeDynamicImports(source: string): string {
  if (!/\bimport\s*\(/.test(source)) return source;
  const sites = dynamicImports(source).filter((s) => s.specifier?.startsWith("node:") && s.handled);
  let out = source;
  for (const site of sites.reverse()) {
    const reject = `Promise.reject(new Error(${JSON.stringify(`${site.specifier} is not available`)}))`;
    out = out.slice(0, site.start) + reject + out.slice(site.end);
  }
  return out;
}

/** A stable name, as in workerd, never the build machine's path. */
export const IMPORT_META_URL = "file:///bundle/index.js";

const HAS_IMPORT_META = /(?<![$\w])(?<![^.]\.)import\.meta\b/;
const IMPORT_META = new RegExp(HAS_IMPORT_META.source, "g");
// One pass over strings, comments and the use itself, so the text "import.meta.env" in a message stays as written.
const IMPORT_META_SCAN =
  /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?<![$\w])(?<![^.]\.)import\.meta\b/g;

/**
 * `import.meta` as workerd has it: `url`, `main` and `resolve()` only (`env` is Vite's, `dirname`/`filename` Node's: they
 * read `undefined`). Porffor would turn any other use into a load of `node:module` (its C needs the ada URL header the
 * host build lacks) and bakes the build directory into `url`. The bundle is one module, so one object serves every use.
 */
export function inlineImportMeta(body: string): string {
  if (!HAS_IMPORT_META.test(body)) return body;
  let used = false;
  const use = () => {
    used = true;
    return "__sbImportMeta";
  };
  const out = body.replace(IMPORT_META_SCAN, (match) => {
    if (match.startsWith("import")) return use();
    // `...${import.meta.url}...`: only the interpolations are code.
    if (match[0] === "`") return match.replace(/\$\{[^}]*\}/g, (part) => part.replace(IMPORT_META, use));
    return match;
  });
  if (!used) return body;
  const url = JSON.stringify(IMPORT_META_URL);
  return `const __sbImportMeta = { url: ${url}, main: true, resolve(specifier) { return new URL(String(specifier), ${url}).href; } };\n${out}`;
}

export function neutraliseExports(source: string): string | null {
  return neutraliseExportsDetailed(source)?.code ?? null;
}

/**
 * `neutraliseExports` plus the renamed exports of a bundle's trailing block (`export { Rn as Counter }`), as exported
 * name -> local name. They are read from `__sbExports`, never declared as top-level names: a bundler exports its
 * helpers under short names (`__name as D`), and `const D = __name` collided with the bundle's own `var D`.
 */
export function neutraliseExportsDetailed(source: string): { code: string; aliases: Record<string, string> } | null {
  const aliases: Record<string, string> = {};
  const code = neutraliseExportsText(source, aliases);
  return code === null ? null : { code, aliases };
}

function neutraliseExportsText(source: string, aliasOut: Record<string, string>): string | null {
  // `export default class Name extends WorkerEntrypoint {`: the class is the handler.
  if (/^\s*export\s+default\s+class\b/m.test(source)) {
    return source
      .replace(/^(\s*)export\s+default\s+class\b/m, "$1const __sbHandlers = class")
      .replace(/^export\s+(async\s+function|function|class|const|let|var)\b/gm, "$1");
  }
  if (/\bexport\s+default\s*\{/.test(source)) {
    return source
      .replace(/^(\s*)export\s+default\s*/m, "$1const __sbHandlers = ")
      .replace(/^export\s+(async\s+function|function|class|const|let|var)\b/gm, "$1");
  }
  // Not anchored to a line: a minified bundle is one line. Bundlers emit exactly one such block, at the end.
  const blocks = [...source.matchAll(/export\s*\{([^}]*)\}\s*;?/g)];
  const block = blocks[blocks.length - 1];
  if (block === undefined) return null;
  let handler: string | null = null;
  for (const entry of block[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const parts = entry.match(/^(\S+)(?:\s+as\s+(\S+))?$/);
    if (parts === null) continue;
    const local = parts[1];
    const exported = parts[2] ?? local;
    if (exported === "default") handler = local;
    // `export { Counter as Counter }` needs no alias; a renamed one is kept so `durable_objects` can name the expected class.
    else if (exported !== local) aliasOut[exported] = local;
  }
  if (handler === null) return null;
  const names = Object.keys(aliasOut);
  const table = names.length
    ? `\nconst __sbExports = { ${names.map((n) => `${JSON.stringify(n)}: ${aliasOut[n]}`).join(", ")} };`
    : "";
  return source.replace(block[0], () => `const __sbHandlers = ${handler};${table}`);
}

/**
 * Build the final native-fetch module: prelude, `const env = {…}` with the baked `vars`, one `__sbInstallBindings`
 * line if any binding is declared, the user's source with `export` neutralised, then our single `export default { fetch }`
 * routing every request through `__sbEntry`. `port` is only the baked fallback; the runtime reads `$PORT` first.
 */
/**
 * What a handler needs of crypto.subtle: `"always"` leaves the prelude as it is (a shared template needs it). `"auto"` drops it
 * (about 330 KB of a 5.3 MB binary, 2 s of build) from a handler that never mentions `subtle`, `DigestStream` or
 * `CryptoKey`; one reaching it through a computed name gets only the digest/HMAC/PBKDF2 subset of earlier dates.
 */
export type SubtleMode = "always" | "auto";

const SUBTLE_BLOCKS: Array<[string, string]> = [
  ["// SUBTLE-JS:BEGIN", "// SUBTLE-JS:END"],
  ["// SUBTLE:BEGIN", "// SUBTLE:END"],
];
export function pruneSubtle(prelude: string): string {
  let out = prelude;
  for (const [begin, end] of SUBTLE_BLOCKS) {
    const start = out.indexOf(begin);
    const stop = out.indexOf(end, start);
    if (start < 0 || stop < 0) {
      throw new Error(`the prelude has no ${begin} ... ${end} block to prune`);
    }
    out = out.slice(0, start) + out.slice(out.indexOf("\n", stop) + 1);
  }
  return out;
}
export const reachesSubtle = (source: string) => /\b(?:subtle|DigestStream|CryptoKey)\b/.test(source);

export function wrapNativeFetchHandler(
  source: string,
  prelude: string,
  vars: Record<string, string> = {},
  bindings: Bindings = EMPTY_BINDINGS,
  port: number = DEFAULT_PORT,
  compatibilityDate: string = BASELINE_COMPATIBILITY_DATE,
  appName: string = "app",
  assets?: { manifest: unknown; files: Record<string, string> },
  transport: Transport = "broker",
  /** #126 - `env.<binding> = { id, tag, timestamp }`, baked from the artifact digest (the control plane's deployment id is minted later, at upload). */
  versionMetadata?: { binding: string; id: string; tag: string; timestamp: string },
  subtle?: SubtleMode,
): string {
  // The shared template (sproutd) is the embedded transport and needs it all; a broker build links BearSSL only for
  // a handler that uses crypto.subtle (the CLI does that), so it defaults to pruning.
  // A prelude without the block (a test stub) is left alone; prune.test.ts holds the real one to it.
  if (
    (subtle ?? (transport === "embedded" ? "always" : "auto")) === "auto" &&
    !reachesSubtle(source) &&
    prelude.includes("// SUBTLE-JS:BEGIN")
  )
    prelude = pruneSubtle(prelude);
  const exported = neutraliseExportsDetailed(inlineNodeDynamicImports(inlineWorkersImports(source)));
  const neutralised = exported === null ? null : exported.code;
  // A WorkerEntrypoint may serve only RPC, and a Worker only scheduled() or queue(), as in workerd.
  if (exported === null || neutralised === null || !hasEntryHandler(source)) {
    throw new Error(
      "handler must default-export an object with a fetch(request), scheduled() or queue() method, or a WorkerEntrypoint class",
    );
  }

  const env = `const env = ${JSON.stringify(vars)};\nglobalThis.env = env;\n__sbSetEnv(env);\n`;
  const versionMetadataLine = versionMetadata
    ? `env[${JSON.stringify(versionMetadata.binding)}] = ${JSON.stringify({
        id: versionMetadata.id,
        tag: versionMetadata.tag,
        timestamp: versionMetadata.timestamp,
      })};\n`
    : "";
  // Baked, not a binding: a handler must not be able to change the semantics it was compiled against.
  const compat =
    `globalThis.__sbCompat = ${JSON.stringify(compatibilityDate)};\n` +
    `__sbSetCompat(${JSON.stringify(compatibilityDate)});\n` +
    `globalThis.__sbAppName = ${JSON.stringify(appName)};\n` +
    (assets ? `globalThis.__sbAssets = ${JSON.stringify(assets)};\n` : "");
  // The native transfer hook runs before JavaScript receives its Request. Only embedded builds implement it; the broker
  // transport supplies ABI-compatible stubs because its own listener owns these URLs and the uWebSockets patch is global.
  const nativeTransferAbi =
    transport === "embedded"
      ? `Porffor.c\`const char* sb_standalone_app_name(void) { return ${JSON.stringify(appName)}; }\`;\n`
      : 'Porffor.c`typedef struct sb_r2_transfer_ctx { int unused; } sb_r2_transfer_ctx; int sb_r2_transfer_open(const char* a, const char* b, size_t c, sb_r2_transfer_ctx** d) { if (d) *d = 0; return 404; } int sb_r2_transfer_write(sb_r2_transfer_ctx* a, const char* b, size_t c) { return 404; } int sb_r2_transfer_finish(sb_r2_transfer_ctx* a) { return 404; } void sb_r2_transfer_abort(sb_r2_transfer_ctx* a) {} int sb_r2_transfer_download_open(const char* a, const char* b, sb_r2_transfer_ctx** c) { if (c) *c = 0; return 404; } size_t sb_r2_transfer_download_size(sb_r2_transfer_ctx* a) { return 0; } const char* sb_r2_transfer_download_etag(sb_r2_transfer_ctx* a) { return ""; } size_t sb_r2_transfer_download_read(sb_r2_transfer_ctx* a, size_t b, char* c, size_t d) { return 0; } void sb_r2_transfer_download_close(sb_r2_transfer_ctx* a) {}`;\n';
  const wire =
    "__sbInstallFetch();\n" + (hasBindings(bindings) ? `__sbInstallBindings(env, ${JSON.stringify(bindings)});\n` : "");
  const registerDO = bindings.do.length
    ? `__sbRegisterDO({ ${bindings.do
        .map((d) =>
          Object.hasOwn(exported.aliases, d.className)
            ? `${JSON.stringify(d.className)}: __sbExports[${JSON.stringify(d.className)}]`
            : `${d.className}: ${d.className}`,
        )
        .join(", ")} });\n`
    : "";
  // Cron / queue / alarm timers for a transport with no broker; the broker transport defines this as a no-op so the
  // emitted module is the same either way. A Worker with only crons needs them too (B22).
  const triggers =
    hasBindings(bindings) || bindings.crons.length > 0
      ? `__sbStartLocalTriggers(__sbHandlers, ${JSON.stringify(bindings)});\n`
      : "";

  // baronunread/sproutboat#238: the handler runs in its own function scope. Spliced at the prelude's top level, a
  // bundle's own `const URL = ...` (uuid exports one) replaced the URL class module-wide and the binary died at
  // startup; Porffor resolves top-level names module-wide, so a block is not enough. Static imports stay outside.
  const importPattern = /^import\s(?:[\s\S]*?\sfrom\s*)?["'][^"'\n]+["'];?[ \t]*$/gm;
  const imports = (neutralised.match(importPattern) ?? []).join("\n");
  const body = inlineImportMeta(neutralised.replace(importPattern, ""));
  return (
    `${prelude}\n${nativeTransferAbi}${compat}${env}${versionMetadataLine}${wire}` +
    `${imports ? `${imports}\n` : ""}const __sbUserHandlers = (() => {\n${body}\n` +
    `${registerDO}${triggers}return __sbHandlers;\n})();\n` +
    `export default {\n  port: ${port},\n  fetch(request) { return __sbEntry(__sbUserHandlers, request); }\n};\n`
  );
}

type VarsJson = string | number | boolean | null | { readonly [key: string]: VarsJson } | VarsJson[];
function isVarsObject(value: VarsJson): value is { readonly [key: string]: VarsJson } {
  return value !== null && Object(value) === value && !Array.isArray(value);
}
function isVarsString(value: VarsJson): value is string {
  return Object(value) !== value && value === String(value);
}

export function readVarsFromEnv(): Record<string, string> {
  const raw = process.env.SPROUTBOAT_VARS_JSON;
  if (!raw) return {};
  const parsed: VarsJson = JSON.parse(raw);
  if (!isVarsObject(parsed)) throw new Error("SPROUTBOAT_VARS_JSON must be a JSON object");
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]): [string, string] => {
      if (!/^(?!__proto__$)[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !isVarsString(value))
        throw new Error(`SPROUTBOAT_VARS_JSON.${key} must map a name that is a JavaScript identifier to a string`);
      return [key, value];
    }),
  );
}

/** `SPROUTBOAT_BINDINGS_JSON` → `Bindings`, every field re-validated; a missing payload is `EMPTY_BINDINGS`, so old builds still compile. */
export function readBindingsFromEnv(): Bindings {
  const raw = process.env.SPROUTBOAT_BINDINGS_JSON;
  if (!raw) return EMPTY_BINDINGS;
  const parsed: VarsJson = JSON.parse(raw);
  if (!isVarsObject(parsed)) throw new Error("SPROUTBOAT_BINDINGS_JSON must be a JSON object");
  const strings = (v: VarsJson): string[] => (Array.isArray(v) ? v.filter(isVarsString) : []);
  const services: Array<{ binding: string; service: string }> = [];
  if (Array.isArray(parsed.services)) {
    for (const entry of parsed.services) {
      if (isVarsObject(entry) && isVarsString(entry.binding) && isVarsString(entry.service)) {
        services.push({ binding: entry.binding, service: entry.service });
      }
    }
  }
  const dos: Array<{ binding: string; className: string }> = [];
  if (Array.isArray(parsed.do)) {
    for (const entry of parsed.do) {
      if (isVarsObject(entry) && isVarsString(entry.binding) && isVarsString(entry.className)) {
        dos.push({ binding: entry.binding, className: entry.className });
      }
    }
  }
  const isCount = (v: VarsJson): v is number => Number(v) === v && Number.isInteger(v) && v >= 1;
  const ratelimiters: Array<{ binding: string; limit: number; period: number }> = [];
  if (Array.isArray(parsed.ratelimiters)) {
    for (const entry of parsed.ratelimiters) {
      if (isVarsObject(entry) && isVarsString(entry.binding) && isCount(entry.limit) && isCount(entry.period)) {
        ratelimiters.push({ binding: entry.binding, limit: entry.limit, period: entry.period });
      }
    }
  }
  const queueConfig: QueueSettings[] = [];
  if (Array.isArray(parsed.queueConfig)) {
    const num = (v: VarsJson | undefined): v is number => Number(v) === v && Number.isFinite(v) && v >= 0;
    for (const entry of parsed.queueConfig) {
      if (!isVarsObject(entry) || !isVarsString(entry.binding) || !isVarsString(entry.queue)) continue;
      const q: QueueSettings = { binding: entry.binding, queue: entry.queue };
      if (num(entry.maxBatchSize)) q.maxBatchSize = entry.maxBatchSize;
      if (num(entry.maxBatchTimeout)) q.maxBatchTimeout = entry.maxBatchTimeout;
      if (num(entry.maxRetries)) q.maxRetries = entry.maxRetries;
      if (num(entry.retryDelay)) q.retryDelay = entry.retryDelay;
      if (isVarsString(entry.deadLetterQueue)) q.deadLetterQueue = entry.deadLetterQueue;
      queueConfig.push(q);
    }
  }
  const out: Bindings = {
    kv: strings(parsed.kv),
    secrets: strings(parsed.secrets),
    d1: strings(parsed.d1),
    r2: strings(parsed.r2),
    queues: strings(parsed.queues),
    analytics: strings(parsed.analytics),
    do: dos,
    services,
    crons: strings(parsed.crons),
    ratelimiters,
    assets: isVarsString(parsed.assets) ? parsed.assets : "",
  };
  if (queueConfig.length) out.queueConfig = queueConfig;
  return out;
}
