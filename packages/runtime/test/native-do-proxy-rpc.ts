import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Durable Object RPC into a class whose constructor returns a Proxy (Alchemy's bridge): a stub call reaches the names the Proxy
// answers, not only the methods the class defines. Unknown names stay errors. Needs SB_CLI, a
// sproutboat-cli checkout linked to this one.
const cli = process.env.SB_CLI;
if (!cli) {
  console.log("skipped: set SB_CLI to a sproutboat-cli checkout linked to this checkout (it builds the sprout)");
  process.exit(0);
}
function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}
const workdir = mkdtempSync(join(tmpdir(), "sb-native-do-proxy-"));
const project = join(workdir, "app");
mkdirSync(join(project, "src"), { recursive: true });
copyFileSync(new URL("./fixtures/do-proxy-rpc-app.js", import.meta.url).pathname, join(project, "src/index.js"));
writeFileSync(
  join(project, "sproutboat.jsonc"),
  JSON.stringify({
    name: "proxy-rpc",
    main: "src/index.js",
    compatibility_date: "2026-11-21",
    durable_objects: { COUNTER: "Counter" },
  }),
);
const built = Bun.spawnSync(["bun", join(cli, "src/main.ts"), "build", "--standalone", "--target", "host"], {
  cwd: project,
  stdout: "ignore",
  stderr: "inherit",
});
assert.equal(built.exitCode, 0, "the CLI could not build the sprout");
const port = freePort();
const proc = Bun.spawn([join(project, "dist/proxy-rpc")], {
  cwd: workdir,
  env: { ...process.env, SB_DATA_DIR: join(workdir, "data"), PORT: String(port) },
  stdout: "ignore",
  stderr: "inherit",
});
try {
  let up = false;
  for (let attempt = 0; attempt < 100 && !up; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert(up, "the compiled handler did not start");
  const get = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();
  assert.deepEqual(await get("/declared"), { v: "declared" });
  assert.deepEqual(await get("/hit"), { n: 1 });
  assert.deepEqual(await get("/hit"), { n: 2 });
  assert.deepEqual(await get("/echo"), { v: "x" });
  assert.deepEqual(await get("/pair"), { same: true, values: 2, spread: 2 });
  assert.match((await get("/missing")).error, /does not implement the method "nope"/);
  console.log("native-do-proxy-rpc: ok");
} finally {
  proc.kill(9);
  rmSync(workdir, { recursive: true, force: true });
}
