// Before/after of crypto.subtle.digest on a native build (design 040): the h2h /cpu route (20 SHA-256 rounds over 64 KiB), baseline
// prelude against this one, one request at a time; prints one JSON line. BASE_PRELUDE is the old prelude from origin/main.
//   bun packages/runtime/test/native-digest-bench.ts BASE_PRELUDE.js [requests=300] [optimize=2]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileNative } from "./native-compile";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

const [basePath, requestsArg, optArg] = process.argv.slice(2);
if (!basePath) throw new Error("usage: bun native-digest-bench.ts BASE_PRELUDE.js [requests] [optimize]");
const requests = Number(requestsArg ?? 300);
const optimize = Number(optArg ?? 2);

const handler = `
const BUF = (() => { const b = new Uint8Array(65536); let x = 0x9e3779b9 | 0; for (let i = 0; i < b.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 255; } return b; })();
const hex = (buf) => { const a = new Uint8Array(buf); let s = ""; for (let i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16); return s; };
async function cpu() {
  const data = BUF.slice();
  let digest = "";
  for (let round = 0; round < 20; round++) {
    const out = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    for (let i = 0; i < 32; i++) data[i] ^= out[i];
    digest = hex(out.buffer);
  }
  return digest;
}
export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/cpu") return Response.json({ sha256x20: await cpu() });
    return Response.json({ ok: true });
  },
};
`;

// The answer from node:crypto, not from the runtime under test.
function expected(): string {
  const data = new Uint8Array(65536);
  let x = 0x9e3779b9 | 0;
  for (let i = 0; i < data.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    data[i] = x & 255;
  }
  let digest = "";
  for (let round = 0; round < 20; round++) {
    const out = createHash("sha256").update(data).digest();
    for (let i = 0; i < 32; i++) data[i] ^= out[i]!;
    digest = out.toString("hex");
  }
  return digest;
}

function freePort(): number {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = l.port;
  l.stop(true);
  return port;
}

async function measure(label: string, prelude: string, workdir: string) {
  const dir = join(workdir, label);
  await Bun.$`mkdir -p ${dir}`.quiet();
  const generated = join(dir, "digest.generated.js");
  const binary = join(dir, "digest-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, prelude));
  await rm(binary, { force: true });
  await compileNative({ generated, binary, dir, cacheRoot: workdir, bearssl: true, optimize });
  const port = freePort();
  const server = Bun.spawn([binary], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try {
        up = (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).ok;
      } catch {
        await Bun.sleep(100);
      }
    }
    assert(up, `${label}: the binary did not start`);
    const url = `http://127.0.0.1:${port}/cpu`;
    for (let i = 0; i < 20; i++) await (await fetch(url)).text();
    const times: number[] = [];
    let answer = "";
    for (let i = 0; i < requests; i++) {
      const t = performance.now();
      const body: { sha256x20: string } = await (await fetch(url)).json();
      answer = body.sha256x20;
      times.push(performance.now() - t);
    }
    assert.equal(answer, expected(), `${label}: wrong digest`);
    times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    return {
      p50: +times[Math.floor(times.length / 2)]!.toFixed(2),
      p99: +times[Math.floor(times.length * 0.99)]!.toFixed(2),
      mean: +mean.toFixed(2),
    };
  } finally {
    server.kill(9);
    await server.exited;
  }
}

const workdir = await mkdtemp(join(tmpdir(), "sb-digest-bench-"));
try {
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  const base = (await readFile(basePath, "utf8")).replace(TRANSPORT_MARKER, broker);
  assert(core.includes(TRANSPORT_MARKER) && base.includes(broker.slice(0, 40)), "prelude markers");
  const before = await measure("before", base, workdir);
  const after = await measure("after", core.replace(TRANSPORT_MARKER, broker), workdir);
  console.log(
    JSON.stringify({
      arch: process.arch,
      optimize,
      requests,
      before,
      after,
      speedupP50: +(before.p50 / after.p50).toFixed(2),
      speedupMean: +(before.mean / after.mean).toFixed(2),
    }),
  );
} finally {
  await rm(workdir, { recursive: true, force: true });
}
