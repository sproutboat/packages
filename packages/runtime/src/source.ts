import { hasEntryHandler, inlineWorkersImports, neutraliseExports } from "./wrap";

export type SourceValidation = { ok: true } | { ok: false; errors: string[] };

// Checked against the *bundled* module (#89): after bundling no imports are left to reject, and a dependency reaching for a Node API must fail as hand-written code
// would. A bare specifier that resolves to nothing never gets this far: the bundler fails first.
const NODE_GLOBAL_USE = /\b(process|Bun|Deno|Buffer)\.[a-zA-Z_$]|\bnew\s+Buffer\s*\(/;

/**
 * A `node:` specifier in import position: `from "node:fs"`, `import "node:fs"`, `import("node:fs")`,
 * `require("node:fs")`. The string `node:async_hooks` alone is not one: Effect looks it up behind
 * `globalThis.process?.getBuiltinModule?.(...)` and a doc link or log message can carry any prefix.
 */
const NODE_SPECIFIER = /\b(?:from|import|require)\s*\(?\s*['"`]node:/;

const alwaysForbidden: Array<[RegExp, string]> = [
  [/^\s*import\s/m, "an import survived bundling — only static imports can be resolved at build time"],
  [/\bimport\s*\(/, "dynamic import() is not supported: nothing can resolve it at build time"],
  [/\brequire\s*\(/, "CommonJS require is not supported"],
  [/\bXMLHttpRequest\s*\(/, "XMLHttpRequest is not supported"],
  // baronunread/sproutboat#132 - a bare identifier match flags a *local* `function process()` as readily as the global (zod v4 declares one). A Node/Bun/Deno API is
  // always reached through a member access or `new`; requiring that shape lets a local binding through. No whitespace around the `.`: real member access is contiguous,
  // prose mentioning the word is not ("...unique to this process. The id...").
  [NODE_GLOBAL_USE, "Node, Bun, and Deno APIs are not supported"],
  // `node:` only means something as an import specifier, so only one in import
  // position counts (NODE_SPECIFIER); a bare substring match flagged Effect, whose bundle
  // mentions "node:async_hooks" in a guarded runtime lookup.
  [NODE_SPECIFIER, "Node, Bun, and Deno APIs are not supported"],
];

/**
 * From this date the Node/Bun/Deno global check skips a use behind a `typeof X` feature test (supabase-js, @neondatabase/serverless), a global the bundle declares
 * itself and one inside a string or comment; earlier dates keep the plain pattern match. Proposed value, to be chosen by a maintainer.
 */
export const GUARDED_GLOBALS_DATE = "2026-11-15";

const STRINGS_AND_COMMENTS = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * True when the module reaches for a Node/Bun/Deno global that it neither declares itself nor
 * feature-tests first. A bundled polyfill declares its own `Buffer` (`function Buffer(){}`), and a
 * Node branch sits behind `typeof X !== "undefined"` or `typeof atob === "undefined"`.
 */
function usesNodeGlobalUnguarded(module: string): boolean {
  const code = module.replace(STRINGS_AND_COMMENTS, (m) => (m[0] === "/" ? " " : m[0] + m[0]));
  const declared = (name: string) => new RegExp("(?:function|class|var|let|const)\\s+" + name + "\\b").test(code);
  const local = new Set(["process", "Bun", "Deno", "Buffer"].filter(declared));
  const re = new RegExp(NODE_GLOBAL_USE.source, "g");
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const name = m[1] ?? "Buffer";
    if (local.has(name)) continue;
    const before = code.slice(Math.max(0, m.index - 600), m.index);
    // `typeof globalThis.Buffer.from`: the use is the feature test itself.
    if (/typeof\s+(?:(?:globalThis|self|global|window)\.)?$/.test(before)) continue;
    if (new RegExp("typeof\\s+(?:(?:globalThis|self|global|window)\\.)?" + name + "\\b").test(before)) continue;
    // `if (typeof atob === "undefined") { ... Buffer.from(...) }`: a test for something else, just before.
    if (/typeof\s+[\w$.]+\s*[!=]==?\s*""/.test(before.slice(-200))) continue;
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
const driverAllowed = (message: string) => message === "Node, Bun, and Deno APIs are not supported";

export function validateHttpSyncSource(module: string, compatibilityDate?: string): SourceValidation {
  // `cloudflare:workers` is the one import allowed past bundling: the compiler turns it
  // into globals the same way (see inlineWorkersImports).
  const source = inlineWorkersImports(module);
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
  for (const [pattern, message] of alwaysForbidden) {
    if (sockets && driverAllowed(message) && !NODE_SPECIFIER.test(source)) continue;
    if (pattern === NODE_GLOBAL_USE && guardedGlobals ? !usesNodeGlobalUnguarded(source) : !pattern.test(source))
      continue;
    errors.push(message);
  }
  if (
    /\bWebSocket\s*\(/.test(source) &&
    !(compatibilityDate !== undefined && compatibilityDate >= OUTBOUND_WEBSOCKET_DATE)
  )
    errors.push(
      `WebSocket() needs compatibility_date ${OUTBOUND_WEBSOCKET_DATE} or later (earlier dates have WebSocketPair only)`,
    );
  return errors.length ? { ok: false, errors } : { ok: true };
}
