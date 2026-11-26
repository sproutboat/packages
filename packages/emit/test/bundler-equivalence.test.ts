/**
 * The bundler path every Alchemy or wrangler upload takes, held to the CLI's bundler on the same projects. Fixtures come from
 * capture-bundler-fixtures.ts; the README lists why the two are byte-identical only after `normalise`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { deriveBindings, emitLocal, type JsonObject } from "../src/index";
import { projectModules } from "./project-modules";
import { runBundle } from "./run-bundle";

type Fixture = {
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: JsonObject[];
  env: { [name: string]: string };
  requests: string[];
};

const root = resolve(import.meta.dir, "fixtures/bundler");
const names = readdirSync(root).sort();

/**
 * The three known differences, and why, are in the README under "Bundler differences". Nothing here rewrites code that
 * runs: the default-import rule for CommonJS (`__toESM(x, 1)`) is deliberately NOT normalised, so a difference in it fails.
 */
function normalise(code: string): string {
  return (
    code
      .replace(/^\/\/ (?:sb-module|sb-file|sb-node-shim|sb-shim|sb-global|sb-node-global):(.*)$/gm, "// $1")
      // An ES module's path ends in .mjs for the emitter and .js on the CLI's disk.
      .replace(/^\/\/ (.*?)\.m?js$/gm, "// $1")
      .replace(/\bproject_default\b/g, "index_default")
      .replace(/^\/\/ (?:node:)?sb-node-process\n[\s\S]*?(?=^\/\/ )/m, "// sb-node-process stub\n")
  );
}

describe("the emitter's bundler against the CLI's, on the same project", () => {
  for (const name of names) {
    const dir = join(root, name);
    const fixture: Fixture = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
    const cli = readFileSync(join(dir, "cli-bundle.js"), "utf8");
    const modules = projectModules(join(dir, "project"));
    const metadata = {
      main_module: "index.js",
      compatibility_date: fixture.compatibility_date,
      compatibility_flags: fixture.compatibility_flags,
      bindings: fixture.bindings,
    };

    test(`${name}: byte-identical once the three known differences are normalised`, async () => {
      const result = await emitLocal({ modules, metadata }, { name });
      expect(normalise(result.bundled)).toBe(normalise(cli));
    });

    test(`${name}: every request is answered the same way`, async () => {
      const result = await emitLocal({ modules, metadata }, { name });
      for (const path of fixture.requests) {
        const fromCli = await runBundle(cli, fixture.env, path);
        const fromEmit = await runBundle(result.bundled, fixture.env, path);
        expect({ path, ...fromEmit }).toEqual({ path, ...fromCli });
      }
    });

    test(`${name}: through the whole emit, the bindings are those of the CLI's bundle as a single module`, async () => {
      const single = await emitLocal(
        { modules: [{ name: "index.js", type: "esm", content: cli }], metadata },
        { name },
      );
      const uploaded = await emitLocal({ modules, metadata }, { name });
      expect(uploaded.bindings).toEqual(single.bindings);
      expect(uploaded.region.split("\n")[0]).toBe(single.region.split("\n")[0]);
      expect(deriveBindings(uploaded.metadata).record).toEqual(single.bindings.record);
    });

    test(`${name}: the golden output has not moved (a Bun upgrade that changes the printing fails here)`, async () => {
      const recorded = readFileSync(join(dir, "bun-version.txt"), "utf8").trim();
      const result = await emitLocal({ modules, metadata }, { name });
      const golden = readFileSync(join(dir, "emit-bundled.js"), "utf8");
      const hint = `Bun is ${Bun.version}; the golden was captured with ${recorded}. If the change is expected, run \`bun packages/emit/test/capture-bundler-fixtures.ts <cli-dir>\`, read the diff, and commit it.`;
      if (result.bundled !== golden) throw new Error(`the emitted bundle changed. ${hint}`);
      expect(recorded).toBe(Bun.version);
    });
  }

  test("a tsc- or Babel-style CommonJS module (it sets __esModule) default-imports as module.exports, as in the CLI and on Cloudflare (R3)", async () => {
    const dir = join(root, "cjs-and-builtins");
    const fixture: Fixture = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
    const result = await emitLocal(
      {
        modules: projectModules(join(dir, "project")),
        metadata: {
          main_module: "index.js",
          compatibility_date: fixture.compatibility_date,
          compatibility_flags: fixture.compatibility_flags,
        },
      },
      { name: "cjs" },
    );
    expect(result.bundled).toContain("__toESM(require_transpiled(), 1)");
    const answer = await runBundle(result.bundled, {}, "/transpiled");
    // module.exports has the keys `default` and `named`: the default import is that object, not its `default` property.
    expect(JSON.parse(answer.body)).toEqual({ kind: "object", keys: ["default", "named"], named: "the named export" });
  });

  test("the fixtures cover a multi-module project, Node built-ins with free globals, and CommonJS", () => {
    expect(names).toEqual(["cjs-and-builtins", "multi-module", "node-globals"]);
    expect(projectModules(join(root, "multi-module", "project")).length).toBeGreaterThanOrEqual(5);
  });
});
