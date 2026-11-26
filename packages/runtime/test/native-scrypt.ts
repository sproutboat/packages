import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileNative } from "./native-compile";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// __sbScrypt holds its table V to a memory budget by storing every k-th block and recomputing the rest. Every k must give the
// bytes of node:crypto's scryptSync (and the RFC 7914 vectors); parameters past the ceiling must throw, not allocate.
type Case = { pw: string; salt: string; N: number; r: number; p: number; len: number };
const cases: Case[] = [
  { pw: "", salt: "", N: 16, r: 1, p: 1, len: 64 }, // RFC 7914 vector 1, k 1
  { pw: "password", salt: "NaCl", N: 1024, r: 8, p: 16, len: 64 }, // vector 2, k 1
  { pw: "pleaseletmein", salt: "SodiumChloride", N: 16384, r: 8, p: 1, len: 64 }, // vector 3: 16 MiB, k 2
  { pw: "better-auth password", salt: "0123456789abcdef", N: 16384, r: 16, p: 1, len: 64 }, // Better Auth: 32 MiB, k 4
  { pw: "café", salt: "salt", N: 16384, r: 12, p: 1, len: 32 }, // 24 MiB, k 3 (does not divide N)
  { pw: "k7", salt: "s", N: 4096, r: 33, p: 2, len: 17 }, // 17 MiB, k 3, p 2
  { pw: "k8", salt: "s", N: 65536, r: 8, p: 1, len: 64 }, // 64 MiB, k 8: the ceiling at the default limit
  { pw: "k16", salt: "s", N: 65536, r: 16, p: 1, len: 64 }, // 128 MiB, k 16: refused
  { pw: "bad", salt: "s", N: 1000, r: 8, p: 1, len: 64 }, // not a power of two: refused
];
const refused = new Set([7, 8]);

const handler = `
const hex = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] + 0x100).toString(16).slice(1);
  return out;
};
const cases = JSON.parse(${JSON.stringify(JSON.stringify(cases))});
export default {
  async fetch() {
    const out = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      try {
        out.push(hex(globalThis.__sbScrypt(c.pw, c.salt, c.N, c.r, c.p, c.len)));
      } catch (e) {
        out.push("ERR:" + e.name + ":" + e.message);
      }
    }
    return Response.json(out);
  },
};
`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-scrypt-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "scrypt.generated.js");
  const binary = join(workdir, "scrypt-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, broker)));
  await compileNative({ generated, binary, dir: workdir, cacheRoot: workdir, bearssl: true, optimize: 2 });

  // The worker's memory limit is what sets the budget: 32 MiB (the default app) holds V to 8 MiB.
  const memoryLimit = 32 * 1024 * 1024;
  const port = freePort();
  server = Bun.spawn([binary], {
    cwd: workdir,
    env: { ...process.env, PORT: String(port), SB_MEMORY_LIMIT: String(memoryLimit) },
    stdout: "ignore",
    stderr: "inherit",
  });
  let response: Response | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(60000) });
      break;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(response, "compiled scrypt handler did not start");
  assert.equal(response.status, 200);
  // SAFETY: the handler above answers a JSON array of strings, one per case.
  const got = (await response.json()) as string[];
  assert.equal(got.length, cases.length);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    if (refused.has(i)) {
      assert.match(got[i]!, /^ERR:(RangeError):Invalid scrypt params/, `case ${i} must be refused, got ${got[i]}`);
      continue;
    }
    const want = scryptSync(c.pw, c.salt, c.len, { N: c.N, r: c.r, p: c.p, maxmem: 1 << 30 }).toString("hex");
    assert.equal(got[i], want, `case ${i} (N ${c.N}, r ${c.r}, p ${c.p}) differs from node:crypto`);
  }
  assert.equal(got[0]!.slice(0, 16), "77d6576238657b20");
  assert.equal(got[2]!.slice(0, 16), "7023bdcb3afd7348");
  console.log("scrypt with the time-memory trade-off matches node:crypto and the RFC 7914 vectors; the ceiling throws");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
