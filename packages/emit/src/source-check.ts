/**
 * Source checks that keep a Bun macro (an import attribute Bun runs while parsing) from running: three independent
 * layers, described in the README under "Macros". None of them trusts a heuristic.
 */
import { parse } from "es-module-lexer/js";
import { EmitError, issue, type EmitIssue } from "./errors";

const transpiler = new Bun.Transpiler({ loader: "js" });

/** Cloudflare's wording for an import that names nothing uploaded. */
export const noSuchModule = (specifier: string, importer: string) =>
  new EmitError([
    issue("no-such-module", `No such module "${specifier}"${importer === "" ? "" : `. Imported from "${importer}"`}`),
  ]);

/** 1-based line and column of a character offset. */
export function positionOf(source: string, offset: number) {
  let line = 1;
  let lineStart = 0;
  for (let at = source.indexOf("\n"); at !== -1 && at < offset; at = source.indexOf("\n", at + 1)) {
    line += 1;
    lineStart = at + 1;
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
): EmitIssue[] {
  const out: EmitIssue[] = [];
  for (const cause of causes) {
    if (cause instanceof EmitError) out.push(...cause.issues);
    else if (cause instanceof BuildMessage) {
      const at = cause.position;
      if (at === null) out.push(issue("bundle-failed", `could not bundle ${fallbackName}: ${cause.message}`));
      else
        out.push(
          (from === "transpiler" ? syntaxIssue : bundleIssue)(nameOf(at.file), at.line, at.column, cause.message),
        );
    } else
      out.push(
        issue(
          "bundle-failed",
          `could not bundle ${fallbackName}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
  }
  return out;
}

const LINE_BREAKS = new Set(["\n", "\r", String.fromCharCode(0x2028), String.fromCharCode(0x2029)]);
function hasLineBreak(text: string): boolean {
  for (const char of text) if (LINE_BREAKS.has(char)) return true;
  return false;
}

const NON_NEWLINE_SPACE = new Set([
  " ",
  "\t",
  "\v",
  "\f",
  ...[0xa0, 0xfeff, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x202f, 0x205f, 0x3000].map((code) =>
    String.fromCharCode(code),
  ),
]);

/**
 * Whether anything but the end of the statement follows an import specifier on its line. After
 * `import x from "m"`, a clause (`with {...}`, the legacy `assert {...}`, or whatever a parser might read as one) can only
 * start on the same line: a line terminator ends the statement. Comments are skipped; one that spans a line ends it.
 */
function clauseFollows(source: string, from: number): boolean {
  let at = from;
  while (at < source.length) {
    const char = source[at]!;
    if (char === ";" || LINE_BREAKS.has(char)) return false;
    if (NON_NEWLINE_SPACE.has(char)) at += 1;
    else if (source.startsWith("//", at)) return false;
    else if (source.startsWith("/*", at)) {
      const close = source.indexOf("*/", at + 2);
      if (close === -1 || hasLineBreak(source.slice(at, close))) return false;
      at = close + 2;
    } else return true;
  }
  return false;
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

/**
 * Refuse a code module that has an import attribute, does not parse, or that the two readers disagree about. Throws
 * EmitError; returns nothing. Runs in time linear in the size of the source.
 */
export function checkCodeModule(name: string, source: string): void {
  let imports: ReturnType<typeof parse>[0];
  try {
    [imports] = parse(source, name);
  } catch (cause) {
    const offset = cause instanceof Error && "idx" in cause && Number.isInteger(cause.idx) ? Number(cause.idx) : 0;
    // The lexer's message names no cause. Bun's does; if Bun reads the module, the two disagree and it is refused as such.
    scanImports(name, source);
    const { line, column } = positionOf(source, offset);
    throw new EmitError([syntaxIssue(name, line, column, "the module could not be read")]);
  }
  const statics: string[] = [];
  for (const entry of imports) {
    if (entry.type === "import-meta") continue;
    if (entry.attributesStart !== -1) throw attributeRefusal(name, source, entry.attributesStart);
    if (entry.type === "dynamic") continue;
    statics.push(entry.specifier);
    if (clauseFollows(source, entry.importEnd)) throw attributeRefusal(name, source, entry.importEnd);
  }
  const scanned = scanImports(name, source);
  for (const entry of scanned) if (entry.path.startsWith("bun:")) throw noSuchModule(entry.path, name);
  const seen = scanned.filter((entry) => entry.kind === "import-statement").map((entry) => entry.path);
  if (statics.length !== seen.length || [...statics].sort().join("\0") !== [...seen].sort().join("\0"))
    throw new EmitError([
      issue(
        "source-unverifiable",
        `module "${name}" could not be checked for import attributes: the two parsers read different imports from it`,
        `modules.${name}`,
      ),
    ]);
}
