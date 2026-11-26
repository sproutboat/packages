/** Run a bundled module the way a request would: import it, give it `env`, call its default export's fetch. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "../src/index";

export type Answer = { status: number; body: string };

export async function runBundle(bundled: string, env: JsonObject, path = "/", init: RequestInit = {}): Promise<Answer> {
  const dir = mkdtempSync(join(tmpdir(), "sb-emit-run-"));
  try {
    const file = join(dir, "bundle.mjs");
    writeFileSync(file, bundled);
    Reflect.set(globalThis, "env", env);
    const loaded = await import(file);
    const response: Response = await loaded.default.fetch(new Request(`http://example.test${path}`, init), env);
    return { status: response.status, body: await response.text() };
  } finally {
    Reflect.deleteProperty(globalThis, "env");
    rmSync(dir, { recursive: true, force: true });
  }
}
