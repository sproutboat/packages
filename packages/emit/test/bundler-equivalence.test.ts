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

/** The four known differences, and why, are in the README under "Bundler differences". */
function normalise(code: string): string {
  return code
    .replace(/^\/\/ (?:sb-module|sb-node-shim|sb-shim|sb-global|sb-node-global):(.*)$/gm, "// $1")
    .replace(/\bproject_default\b/g, "index_default")
    .replace(/__toESM\(([^()]*\([^()]*\)), 1\)/g, "__toESM($1)")
    .replace(/^\/\/ (?:node:)?sb-node-process\n[\s\S]*?(?=^\/\/ )/m, "// sb-node-process stub\n");
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

    test(`${name}: byte-identical once the four known differences are normalised`, async () => {
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

  test("the fixtures cover a multi-module project, Node built-ins with free globals, and CommonJS", () => {
    expect(names).toEqual(["cjs-and-builtins", "multi-module", "node-globals"]);
    expect(projectModules(join(root, "multi-module", "project")).length).toBeGreaterThanOrEqual(5);
  });
});
