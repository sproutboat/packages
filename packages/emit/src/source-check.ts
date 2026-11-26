/**
 * Source checks that keep a Bun macro (an import attribute Bun runs while parsing) from running. Three layers, described
 * in the README under "Macros": a full ECMAScript parser (meriyah) that refuses every attribute, Bun's own list of imports
 * that must equal the parser's, and `macros: false` on the build (virtual-bundle.ts), which holds on its own.
 */
import { isParseError, parseModule, parseScript, type ESTree } from "meriyah";
import { EmitError, issue, type EmitIssue } from "./errors";

const transpiler = new Bun.Transpiler({ loader: "js" });

/** Cloudflare's wording for an import that names nothing uploaded. */
export const noSuchModule = (specifier: string, importer: string) =>
  new EmitError([
    issue("no-such-module", `No such module "${specifier}"${importer === "" ? "" : `. Imported from "${importer}"`}`),
  ]);

/** 1-based line and column of a character offset. A line ends at LF, CR, U+2028 or U+2029; CR LF counts once. */
export function positionOf(source: string, offset: number) {
  let line = 1;
  let lineStart = 0;
  for (let at = 0; at < offset && at < source.length; at += 1) {
    const code = source.charCodeAt(at);
    if (code === 13 && source.charCodeAt(at + 1) === 10) continue;
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) {
      line += 1;
      lineStart = at + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

const syntaxIssue = (name: string, line: number, column: number, message: string): EmitIssue =>
  issue("syntax-error", `syntax error in "${name}" at line ${line}, column ${column}: ${message}`, `modules.${name}`);

const bundleIssue = (name: string, line: number, column: number, message: string): EmitIssue =>
  issue("bundle-failed", `could not bundle "${name}" at line ${line}, column ${column}: ${message}`, `modules.${name}`);

/**
 * The refusals for what a bundler or transpiler threw, each naming its file, line and column. From the transpiler it is a
 * syntax error; from the bundler, which only sees modules that already parse, it is a failed bundle (a missing export).
 */
export function bundlerIssues(
  causes: readonly unknown[],
  fallbackName: string,
  nameOf: (file: string) => string,
  from: "transpiler" | "bundler" = "transpiler",
  /** Rewrites what a message says about a file (the bundler names its own namespaced paths). */
  tidy: (message: string) => string = (message) => message,
): EmitIssue[] {
  const out: EmitIssue[] = [];
  for (const cause of causes) {
    if (cause instanceof EmitError) out.push(...cause.issues);
    else if (cause instanceof BuildMessage) {
      const at = cause.position;
      if (at === null) out.push(issue("bundle-failed", `could not bundle ${fallbackName}: ${tidy(cause.message)}`));
      else
        out.push(
          (from === "transpiler" ? syntaxIssue : bundleIssue)(nameOf(at.file), at.line, at.column, tidy(cause.message)),
        );
    } else
      out.push(
        issue(
          "bundle-failed",
          `could not bundle ${fallbackName}: ${tidy(cause instanceof Error ? cause.message : String(cause))}`,
        ),
      );
  }
  return out;
}

const attributeRefusal = (name: string, source: string, offset: number) => {
  const { line, column } = positionOf(source, offset);
  return new EmitError([
    issue(
      "import-attribute-refused",
      `module "${name}" uses an import attribute (with { ... }) at line ${line}, column ${column}; uploads accept none`,
      `modules.${name}`,
    ),
  ]);
};

/** Bun's own list of what a module imports; it parses the module, so a syntax error throws, and it runs no macro. */
export function scanImports(name: string, source: string) {
  try {
    return transpiler.scanImports(source);
  } catch (cause) {
    throw new EmitError(bundlerIssues(cause instanceof AggregateError ? cause.errors : [cause], name, () => name));
  }
}

/** How a module is read: `esm` is a module (strict, imports and top-level await), `cjs` a CommonJS script (a top-level `return`, no `import`). */
export type SourceKind = "esm" | "cjs";

/** Only the offset where a node starts is kept: `range` arrays cost 6 s and 1.2 GB on 8 MiB of `1+1+...`, `start` alone 1 s and 0.6 GB. */
const POSITIONS = { start: true, end: false, range: false } as const;

const parseSource = (source: string, kind: SourceKind): ESTree.Program =>
  kind === "esm"
    ? parseModule(source, { ranges: POSITIONS })
    : parseScript(source, { ranges: POSITIONS, globalReturn: true, webcompat: true });

/** The local names the top-level imports of an ES module bind, or null when it does not parse. */
export function importedNames(source: string): Set<string> | null {
  try {
    const names = new Set<string>();
    for (const node of parseModule(source, { ranges: POSITIONS }).body)
      if (node.type === "ImportDeclaration") for (const specifier of node.specifiers) names.add(specifier.local.name);
    return names;
  } catch {
    return null;
  }
}

/** Whether `source` is a valid ES module (what a CommonJS module cannot be if it uses `import`, `export` or top-level `await`). */
function parsesAsModule(source: string): boolean {
  try {
    parseModule(source, { ranges: POSITIONS });
    return true;
  } catch {
    return false;
  }
}

/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-reflect-get -- a generic walk over the parser's own tree: node shapes are the ESTree union, and the walk must not recurse */
/** The offset of the options argument of an `import(specifier, options)` node (where a `with` clause goes), else null. */
function importOptionsStart(node: object): number | null {
  if (!("type" in node) || node.type !== "ImportExpression" || !("options" in node)) return null;
  const options = node.options;
  if (!(options instanceof Object)) return null;
  return "start" in options ? Number(options.start) : 0;
}

/**
 * The offset of a dynamic `import(specifier, options)` that has an options argument, or null. A walk with its own stack,
 * so a deep tree cannot overflow the call stack; each node is visited once.
 */
function dynamicImportOptions(program: ESTree.Program): number | null {
  const pending: object[] = [program];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const options = importOptionsStart(node);
    if (options !== null) return options;
    for (const key in node) {
      const child: unknown = Reflect.get(node, key);
      if (child instanceof Object) pending.push(child);
    }
  }
  return null;
}

/* oxlint-enable anti-slop/no-object-parameters, anti-slop/no-reflect-get */

/** The specifiers of the static imports and `export ... from` statements, in source order; refuses any attribute. */
function staticSpecifiers(name: string, source: string, program: ESTree.Program): string[] {
  const out: string[] = [];
  for (const node of program.body) {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportNamedDeclaration"
    ) {
      if (node.source === null) continue;
      const clause = node.attributes[0];
      if (clause !== undefined) throw attributeRefusal(name, source, clause.start ?? 0);
      out.push(String(node.source.value));
    }
  }
  return out;
}

/**
 * Refuse a code module that has an import attribute, does not parse, or that the two readers disagree about. Throws
 * EmitError; returns nothing. Time is linear in the size of the source (a 1000-deep nest of calls or brackets is read; deeper
 * than the parser's stack allows is refused).
 */
export function checkCodeModule(name: string, source: string, kind: SourceKind): void {
  let program: ESTree.Program;
  try {
    program = parseSource(source, kind);
  } catch (cause) {
    if (cause instanceof RangeError)
      throw new EmitError([
        issue("limit-exceeded", `module "${name}" is nested too deeply to be checked`, `modules.${name}`),
      ]);
    if (!isParseError(cause))
      throw new EmitError([
        issue(
          "source-unverifiable",
          `module "${name}" could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`,
          `modules.${name}`,
        ),
      ]);
    // Bun's own message names the cause better; if Bun reads the module, the two disagree and the parser's answer stands.
    scanImports(name, source);
    let offset = cause.start ?? 0;
    let detail = cause.description;
    if (kind === "cjs" && parsesAsModule(source)) {
      detail = "a CommonJS module cannot use import, export, import.meta or top-level await";
      // The script goal fails on the token after `await`; point at the `await` itself.
      const awaited = /\bawait\s*$/.exec(source.slice(Math.max(0, offset - 64), offset));
      if (awaited !== null) offset = Math.max(0, offset - 64) + awaited.index;
    }
    const { line, column } = positionOf(source, offset);
    throw new EmitError([syntaxIssue(name, line, column, detail)]);
  }
  const specifiers = staticSpecifiers(name, source, program);
  const options = dynamicImportOptions(program);
  if (options !== null) throw attributeRefusal(name, source, options);
  const scanned = scanImports(name, source);
  for (const entry of scanned) if (entry.path.startsWith("bun:")) throw noSuchModule(entry.path, name);
  const seen = scanned.filter((entry) => entry.kind === "import-statement").map((entry) => entry.path);
  if (specifiers.length !== seen.length || specifiers.some((specifier, at) => specifier !== seen[at]))
    throw new EmitError([
      issue(
        "source-unverifiable",
        `module "${name}" could not be checked for import attributes: the two parsers read different imports from it`,
        `modules.${name}`,
      ),
    ]);
}
