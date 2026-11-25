/** Static-asset manifest: `sproutboat build` writes `assets.json`; the edge serves matching files first, and the broker's `assets.get` backs `env.<ASSETS>.fetch`. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

export type AssetEntry = { hash: string; size: number; type: string };
/** `/absolute/posix/path` -> entry. Serialised into `assets.json`. */
export type AssetFiles = { [path: string]: AssetEntry };
/** A `_headers` block: `set` applied in order, `unset` (`! Name`) removed. */
export type HeaderRule = { pattern: string; set: [string, string][]; unset: string[] };
/** A `_redirects` line: `from  to  [status]`, `:name` segments and a trailing `*` -> `:splat`. */
export type RedirectRule = { from: string; to: string; status: number };
export type AssetManifest = {
  /** Fallback for requests that match no file, applied by the broker. */
  notFound: "none" | "single-page-application" | "404-page";
  /** `true` = every path to the sprout first; string[] = selective (leading `!` negates). */
  runSproutFirst: boolean | string[];
  files: AssetFiles;
  /** Parsed from `_headers` at the assets root (#61). Omitted when there is none. */
  headers?: HeaderRule[];
  /** Parsed from `_redirects` at the assets root (#61). Omitted when there is none. */
  redirects?: RedirectRule[];
};

const TYPES = new Map<string, string>([
  ["html", "text/html; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["json", "application/json; charset=utf-8"],
  ["map", "application/json; charset=utf-8"],
  ["txt", "text/plain; charset=utf-8"],
  ["md", "text/markdown; charset=utf-8"],
  ["markdown", "text/markdown; charset=utf-8"],
  ["xml", "application/xml; charset=utf-8"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["ico", "image/x-icon"],
  ["woff2", "font/woff2"],
  ["woff", "font/woff"],
  ["ttf", "font/ttf"],
  ["wasm", "application/wasm"],
  ["webmanifest", "application/manifest+json"],
]);

export function contentType(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot >= 0 ? TYPES.get(name.slice(dot + 1).toLowerCase()) : undefined) ?? "application/octet-stream";
}

/**
 * Resolve a request path to a manifest key like a static host: an exact hit, a directory (`/docs/` -> `index.html`), an extensionless path
 * (`/docs.html`, then `/docs/index.html`). Mirrors Cloudflare's `auto-trailing-slash` minus the 3xx responses.
 */
export function resolveAssetKey(path: string, has: (key: string) => boolean): string | null {
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.endsWith("/")) {
    const index = `${path}index.html`;
    return has(index) ? index : null;
  }
  if (has(path)) return path;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (!base.includes(".")) {
    if (has(`${path}.html`)) return `${path}.html`;
    if (has(`${path}/index.html`)) return `${path}/index.html`;
  }
  return null;
}

/**
 * `.assetsignore` at the asset root, gitignore style: `#` comments, `!` re-includes, a trailing `/` matches directories only, a pattern with a slash
 * is anchored to the root and one without matches a name at any depth. `*` stays in a segment, `**` crosses segments.
 */
export function parseAssetsIgnore(text: string): (path: string, isDir: boolean) => boolean {
  const rules = text
    .split(/\r?\n/)
    .map((raw) => raw.trimEnd())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const negate = line.startsWith("!");
      let pattern = negate ? line.slice(1) : line;
      const dirOnly = pattern.endsWith("/");
      if (dirOnly) pattern = pattern.slice(0, -1);
      const anchored = pattern.includes("/");
      pattern = pattern.replace(/^\//, "");
      const body = pattern
        .replace(/[.+^${}()|[\]\\]/g, (c) => `\\${c}`)
        .replace(/\*\*\//g, "\u0000")
        .replace(/\*\*/g, "\u0001")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000/g, "(?:.*/)?")
        .replace(/\u0001/g, ".*");
      return { negate, dirOnly, rx: new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}$`) };
    });
  return (path, isDir) => {
    let ignored = false;
    for (const rule of rules) if ((!rule.dirOnly || isDir) && rule.rx.test(path)) ignored = !rule.negate;
    return ignored;
  };
}

/** Walk `dir` recursively, returning `{ "/path": {hash,size,type} }`. `_headers`/`_redirects` at the root are config, not servable files (#61) — see `readAssetRules`. */
export function walkAssets(dir: string) {
  const out: AssetFiles = {};
  const ignorePath = join(dir, ".assetsignore");
  const ignored = existsSync(ignorePath) ? parseAssetsIgnore(readFileSync(ignorePath, "utf8")) : () => false;
  const recurse = (abs: string, rel: string): void => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      if (ignored(posix.join(rel, ent.name), ent.isDirectory())) continue;
      if (rel === "" && (ent.name === "_headers" || ent.name === "_redirects")) continue;
      const childAbs = join(abs, ent.name);
      const childRel = posix.join(rel, ent.name);
      if (ent.isDirectory()) {
        recurse(childAbs, childRel);
        continue;
      }
      if (!ent.isFile()) continue;
      const body = readFileSync(childAbs);
      out[`/${childRel}`] = {
        hash: createHash("sha256").update(body).digest("hex"),
        size: body.byteLength,
        type: contentType(ent.name),
      };
    }
  };
  recurse(dir, "");
  return out;
}

/** Does `pathname` hit the sprout before assets, given a `runSproutFirst` spec? */
export function isSproutFirst(spec: boolean | string[], pathname: string): boolean {
  if (!Array.isArray(spec)) return spec;
  let matched = false;
  for (const raw of spec) {
    const negate = raw.startsWith("!");
    const pattern = negate ? raw.slice(1) : raw;
    if (globMatch(pattern, pathname)) matched = !negate;
  }
  return matched;
}

/** `*` matches any characters, `/` included, as in Cloudflare's `run_worker_first` (`/api/*` covers `/api/a/b`); `**` is the same. Anchored both ends. */
function globMatch(pattern: string, path: string): boolean {
  const rx = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*");
  return new RegExp(`^${rx}$`).test(path);
}

const MAX_HEADER_RULES = 2000;
const MAX_REDIRECT_RULES = 2000;

/**
 * Parse a Pages/Netlify-style `_headers` file: a path pattern at column 0,
 * followed by indented `Name: value` lines (`! Name` strips a header
 * downstream). A blank line or a new pattern line ends the current block.
 */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const rawLine of text.split("\n")) {
    if (rawLine.trim() === "" || /^\s*#/.test(rawLine)) {
      current = null;
      continue;
    }
    if (!/^\s/.test(rawLine)) {
      if (rules.length >= MAX_HEADER_RULES) {
        current = null;
        continue;
      }
      current = { pattern: rawLine.trim(), set: [], unset: [] };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const line = rawLine.trim();
    if (line.startsWith("!")) {
      current.unset.push(line.slice(1).trim());
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    current.set.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

// `_headers` patterns follow Netlify/Pages semantics: a trailing `*` is greedy across `/` (`/assets/*` catches nested files), unlike globMatch's.
function headerPatternMatches(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  for (let i = 0; i < patternSegments.length; i++) {
    if (patternSegments[i] === "*") return true;
    if (pathSegments[i] !== patternSegments[i]) return false;
  }
  return patternSegments.length === pathSegments.length;
}

/** Every `_headers` rule whose pattern matches `pathname`, in file order (a later rule can override or unset an earlier one when applied). */
export function matchHeaders(rules: readonly HeaderRule[], pathname: string): HeaderRule[] {
  return rules.filter((rule) => headerPatternMatches(rule.pattern, pathname));
}

// `status` must be a 3xx (default 302); anything else is dropped as malformed rather than treated as a rewrite.
export function parseRedirects(text: string): RedirectRule[] {
  const rules: RedirectRule[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [from, to, statusText] = parts;
    const status = statusText ? Number(statusText) : 302;
    if (!Number.isInteger(status) || status < 300 || status > 399) continue;
    rules.push({ from, to, status });
    if (rules.length >= MAX_REDIRECT_RULES) break;
  }
  return rules;
}

/**
 * Cloudflare's `_redirects` matching (workers-sdk rules-engine): the whole pathname must match (`/compare` does not match `/compare/`); `:name` is one
 * or more characters up to `/`, `*` is anything and `:splat` in `to`; a rule breaking those limits never matches. A static rule beats a dynamic one, then first wins.
 */
type RedirectToken = { kind: "text"; text: string } | { kind: "name"; name: string } | { kind: "splat" };

function redirectTokens(from: string): RedirectToken[] | null {
  const tokens: RedirectToken[] = [];
  const names = new Set<string>();
  let text = "";
  const flush = () => {
    if (text !== "") tokens.push({ kind: "text", text });
    text = "";
  };
  for (let i = 0; i < from.length; i++) {
    const c = from[i]!;
    if (c === "*") {
      flush();
      if (names.has("splat")) return null;
      names.add("splat");
      tokens.push({ kind: "splat" });
    } else if (c === ":" && /[A-Za-z]/.test(from[i + 1] ?? "")) {
      let end = i + 2;
      while (end < from.length && /\w/.test(from[end]!)) end++;
      const name = from.slice(i + 1, end);
      if (names.has(name)) return null;
      names.add(name);
      flush();
      tokens.push({ kind: "name", name });
      i = end - 1;
    } else text += c;
  }
  flush();
  return tokens;
}

function matchTokens(tokens: RedirectToken[], t: number, path: string, p: number, groups: [string, string][]): boolean {
  const token = tokens[t];
  if (token === undefined) return p === path.length;
  if (token.kind === "text")
    return path.startsWith(token.text, p) && matchTokens(tokens, t + 1, path, p + token.text.length, groups);
  const slash = path.indexOf("/", p);
  const limit = token.kind === "splat" || slash === -1 ? path.length : slash;
  const name = token.kind === "splat" ? "splat" : token.name;
  // Longest first, as the regular expression `[^/]+` / `.*` is greedy; a name needs at least one character.
  for (let q = limit; q >= (token.kind === "splat" ? p : p + 1); q--) {
    groups.push([name, path.slice(p, q)]);
    if (matchTokens(tokens, t + 1, path, q, groups)) return true;
    groups.pop();
  }
  return false;
}

const isStaticRedirect = (from: string): boolean => !from.includes("*") && !/:[A-Za-z]/.test(from);

function redirectLocation(rule: RedirectRule, pathname: string): string | null {
  if (isStaticRedirect(rule.from)) return rule.from === pathname ? rule.to : null;
  const tokens = redirectTokens(rule.from);
  if (tokens === null) return null;
  const groups: [string, string][] = [];
  if (!matchTokens(tokens, 0, pathname, 0, groups)) return null;
  let to = rule.to;
  for (const [name, value] of groups) to = to.split(`:${name}`).join(value);
  return to;
}

/**
 * Where one `_redirects` rule sends `pathname`, with `:name` and `:splat` substituted into `to`; `null` if the rule does
 * not match. See the notes above for what matches.
 */
export function matchRedirect(rule: RedirectRule, pathname: string): string | null {
  return redirectLocation(rule, pathname);
}

/** The rule that redirects `pathname`, and where to: the first static rule that matches, else the first dynamic one. */
export function findRedirect(
  rules: readonly RedirectRule[],
  pathname: string,
): { rule: RedirectRule; location: string } | null {
  for (const rule of rules)
    if (isStaticRedirect(rule.from) && rule.from === pathname) return { rule, location: rule.to };
  for (const rule of rules) {
    if (isStaticRedirect(rule.from)) continue;
    const location = redirectLocation(rule, pathname);
    if (location !== null) return { rule, location };
  }
  return null;
}

export type AssetRules = { headers: HeaderRule[]; redirects: RedirectRule[] };

/** Read and parse `_headers`/`_redirects` from the assets root, if present. */
export function readAssetRules(dir: string): AssetRules {
  const headersPath = join(dir, "_headers");
  const redirectsPath = join(dir, "_redirects");
  return {
    headers: existsSync(headersPath) ? parseHeaders(readFileSync(headersPath, "utf8")) : [],
    redirects: existsSync(redirectsPath) ? parseRedirects(readFileSync(redirectsPath, "utf8")) : [],
  };
}
