/** The files of a fixture project as the upload carries them: names relative to the project, `.cjs` as cjs, the rest ES modules. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ModuleInput } from "../src/index";

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

export function projectModules(project: string): ModuleInput[] {
  return walk(project)
    .sort()
    .map((file): ModuleInput => {
      const name = relative(project, file).split("\\").join("/");
      return { name, type: name.endsWith(".cjs") ? "cjs" : "esm", content: readFileSync(file, "utf8") };
    });
}
