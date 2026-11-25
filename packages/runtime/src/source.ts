import {
  dynamicImports,
  hasEntryHandler,
  inlineWorkersImports,
  maskNonCode,
  neutraliseExports,
  type DynamicImport,
} from "./wrap";

export type SourceValidation = { ok: true } | { ok: false; errors: string[] };

// Checked against the *bundled* module (#89): a dependency reaching for a Node API must fail as hand-written code would. Every rule reads the module
// with strings, templates, comments and regex bodies blanked (`maskNonCode`), so a word in a message is not a use; a specifier is read back from the source.
const NODE_GLOBAL_USE = /\b(process|Bun|Deno|Buffer)\.[a-zA-Z_$]|\bnew\s+Buffer\s*\(/;

/**
 * A `node:` specifier in import position: `from "node:fs"`, `import "node:fs"`, `require("node:fs")`. The string `node:async_hooks` alone is not one: Effect looks
 * it up behind `globalThis.process?.getBuiltinModule?.(...)` and a doc link or log message can carry any prefix. A dynamic `import("node:sqlite")` is judged by
 * `dynamicImports` (allowed where a failure is caught).
 */
const NODE_SPECIFIER_AT = /(?<![.$\w])(?:from|import|require)\s*\(?\s*(['"`])/g;

/** Message of the node specifier and node global rules (one text, so a source hitting both reports it twice, as it always did). */
const NODE_MESSAGE = "Node, Bun, and Deno APIs are not supported";

type Rule = { test: (code: Code) => boolean; message: string };

/** The module and its masked twin: same length, same offsets. */
type Code = { source: string; masked: string; imports: DynamicImport[] };

function nodeSpecifierUsed(code: Code): boolean {
  // A caught dynamic import of a node: module is the library's own probe and is rewritten to a rejection; it is not an import that survived.
  const ignored = new Set(
    code.imports.filter((i) => i.specifier?.startsWith("node:") && i.handled).map((i) => i.start),
  );
  const re = new RegExp(NODE_SPECIFIER_AT.source, "g");
  for (let m = re.exec(code.masked); m !== null; m = re.exec(code.masked)) {
    if (ignored.has(m.index)) continue;
    if (code.source.startsWith("node:", re.lastIndex)) return true;
  }
  return false;
}

const alwaysForbidden: Rule[] = [
  {
    test: ({ masked }) => /^\s*import\s/m.test(masked),
    message: "an import survived bundling — only static imports can be resolved at build time",
  },
  {
    // A literal specifier of a node: module whose failure is caught is a library probing for an optional API; every other import() cannot be resolved.
    test: ({ imports }) => imports.some((i) => !(i.specifier?.startsWith("node:") && i.handled)),
    message: "dynamic import() is not supported: nothing can resolve it at build time",
  },
  { test: ({ masked }) => /\brequire\s*\(/.test(masked), message: "CommonJS require is not supported" },
  { test: ({ masked }) => /\bXMLHttpRequest\s*\(/.test(masked), message: "XMLHttpRequest is not supported" },
  // baronunread/sproutboat#132 - a bare identifier match flags a *local* `function process()` as readily as the global (zod v4 declares one). A Node/Bun/Deno API is
  // always reached through a member access or `new`; requiring that shape lets a local binding through. No whitespace around the `.`: real member access is contiguous.
  // Before GUARDED_GLOBALS_DATE the plain pattern runs over the raw text, words in strings and comments included, as it always did.
  { test: ({ source }) => NODE_GLOBAL_USE.test(source), message: NODE_MESSAGE },
  // `node:` only means something as an import specifier, so only one in import position counts; a bare substring match flagged Effect, whose bundle
  // mentions "node:async_hooks" in a guarded runtime lookup.
  { test: nodeSpecifierUsed, message: NODE_MESSAGE },
];

/**
 * From this date the Node/Bun/Deno global check skips a use behind a `typeof X` or `"X" in globalThis` feature test (supabase-js, @neondatabase/serverless, a
 * polyfill probing for `Buffer`), a global the bundle declares itself and one inside a string or comment; earlier dates keep the plain pattern match. Proposed value, to be chosen by a maintainer.
 */
export const GUARDED_GLOBALS_DATE = "2026-11-15";

/**
 * True when the module reaches for a Node/Bun/Deno global that it neither declares itself nor
 * feature-tests first. A bundled polyfill declares its own `Buffer` (`function Buffer(){}`), and a
 * Node branch sits behind `typeof X !== "undefined"`, `typeof atob === "undefined"` or `"Buffer" in globalThis`.
 */
function usesNodeGlobalUnguarded({ source, masked }: Code): boolean {
  const declared = (name: string) => new RegExp("(?:function|class|var|let|const)\\s+" + name + "\\b").test(masked);
  const local = new Set(["process", "Bun", "Deno", "Buffer"].filter(declared));
  const re = new RegExp(NODE_GLOBAL_USE.source, "g");
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    const name = m[1] ?? "Buffer";
    if (local.has(name)) continue;
    const from = Math.max(0, m.index - 600);
    const before = masked.slice(from, m.index);
    // `typeof globalThis.Buffer.from`: the use is the feature test itself.
    if (/typeof\s+(?:(?:globalThis|self|global|window)\.)?$/.test(before)) continue;
    if (new RegExp("typeof\\s+(?:(?:globalThis|self|global|window)\\.)?" + name + "\\b").test(before)) continue;
    // `"Buffer" in globalThis && Buffer.prototype...`: the name is in a string, so read it from the source.
    if (
      new RegExp("[\"'`]" + name + "[\"'`]\\s*in\\s*(?:globalThis|self|global|window)\\b").test(
        source.slice(from, m.index),
      )
    )
      continue;
    // `if (typeof atob === "undefined") { ... Buffer.from(...) }`: a test for something else, just before.
    if (/typeof\s+[\w$.]+\s*[!=]==?\s*(["'`])\s*\1/.test(before.slice(-200))) continue;
    return true;
  }
  return false;
}

/** `new WebSocket(url)` connects out from this compatibility date (earlier, only WebSocketPair makes one). */
export const OUTBOUND_WEBSOCKET_DATE = "2026-11-01";

/**
 * From this date `cloudflare:sockets` connect() exists, and so does the bundled Buffer and process
 * stub a database driver brings: the bundler inlines both, so `Buffer.from` and `process.nextTick`
 * in the output are the bundle's own code, not a host API.
 */
export const SOCKETS_DATE = "2026-11-17";
const driverAllowed = (message: string) => message === NODE_MESSAGE;

export function validateHttpSyncSource(module: string, compatibilityDate?: string): SourceValidation {
  // `cloudflare:workers` is the one import allowed past bundling: the compiler turns it
  // into globals the same way (see inlineWorkersImports).
  const source = inlineWorkersImports(module);
  const masked = maskNonCode(source);
  const code: Code = { source, masked, imports: /\bimport\s*\(/.test(masked) ? dynamicImports(source, masked) : [] };
  const errors: string[] = [];
  // The default export must be an object literal with a `fetch` method, not anchored to the start (Durable Object classes and helpers may precede it).
  // `neutraliseExports` is the compiler's own reader, so `check` cannot accept a module the build would reject. A WorkerEntrypoint may serve only RPC, and a
  // Worker only scheduled() or queue(), with no fetch(), as in workerd.
  if (neutraliseExports(source) === null || !hasEntryHandler(source)) {
    errors.push(
      "handler must default-export an object with fetch(request), scheduled() or queue(), or a WorkerEntrypoint class",
    );
  }
  if (
    /["']cloudflare:sockets["']/.test(module) &&
    !(compatibilityDate !== undefined && compatibilityDate >= SOCKETS_DATE)
  )
    errors.push(`cloudflare:sockets needs compatibility_date ${SOCKETS_DATE} or later`);
  const guardedGlobals = compatibilityDate !== undefined && compatibilityDate >= GUARDED_GLOBALS_DATE;
  const sockets = compatibilityDate !== undefined && compatibilityDate >= SOCKETS_DATE;
  const specifierUsed = nodeSpecifierUsed(code);
  for (const rule of alwaysForbidden) {
    if (sockets && driverAllowed(rule.message) && !specifierUsed) continue;
    if (rule.test === alwaysForbidden[4]!.test && guardedGlobals ? !usesNodeGlobalUnguarded(code) : !rule.test(code))
      continue;
    errors.push(rule.message);
  }
  if (
    /\bWebSocket\s*\(/.test(masked) &&
    !(compatibilityDate !== undefined && compatibilityDate >= OUTBOUND_WEBSOCKET_DATE)
  )
    errors.push(
      `WebSocket() needs compatibility_date ${OUTBOUND_WEBSOCKET_DATE} or later (earlier dates have WebSocketPair only)`,
    );
  return errors.length ? { ok: false, errors } : { ok: true };
}
