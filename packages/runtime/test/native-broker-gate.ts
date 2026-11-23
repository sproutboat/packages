import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileNative } from "./native-compile";
import { EMPTY_BINDINGS, preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// The broker transport (sproutboat dev, a deployed sprout) must start an app at every compatibility date. From 2026-11-20 the
// prelude's __sbSetCompat asks the host for the acknowledgement gate (__sbGateRaw); the broker has no commit counter, so the gate
// stays off there. Before the fix an app at 2026-11-20 or later died at startup with "ReferenceError: __sbGateRaw is not defined".
const DATES = ["2026-11-19", "2026-11-20", "2026-11-23"];
const handler = `export default { async fetch() { return new Response("hello"); } };`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-broker-gate-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  for (const date of DATES) {
    const generated = join(workdir, `app-${date}.generated.js`);
    const binary = join(workdir, `app-${date}`);
    await writeFile(
      generated,
      wrapNativeFetchHandler(handler, prelude, {}, EMPTY_BINDINGS, undefined, date, "app", undefined, "broker"),
    );
    await compileNative({ generated, binary, dir: workdir });
    const port = freePort();
    let stderr = "";
    server = Bun.spawn([binary], {
      cwd: workdir,
      env: { ...process.env, PORT: String(port) },
      stdout: "ignore",
      stderr: "pipe",
    });
    const proc = server;
    void (async () => {
      for await (const chunk of proc.stderr) stderr += new TextDecoder().decode(chunk);
    })();
    let body: string | undefined;
    for (let attempt = 0; attempt < 50 && body === undefined; attempt++) {
      try {
        body = await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).text();
      } catch {
        if (server.exitCode !== null) break;
        await Bun.sleep(100);
      }
    }
    assert.equal(
      body,
      "hello",
      `broker transport at compatibility date ${date} did not answer (stderr: ${stderr.trim() || "empty"})`,
    );
    server.kill(9);
    await server.exited;
    server = undefined;
    console.log(`PASS broker transport, compatibility date ${date}: the app starts and answers`);
  }
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
