import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bearsslEnv } from "./bearssl";
import { compileNative } from "./native-compile";
import { EMPTY_BINDINGS, preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// env.ASSETS served from a directory (the host's per-deployment view of the Cloud asset store, SB_ASSETS_DIR=DIR with
// DIR/manifest.json and DIR/blobs/<sha256>), on COMPILED standalone binaries so the real inline C and the real prelude run:
//   1. the C helpers (sb_assets_op) on their own: hash validation, O_NOFOLLOW, regular files only, the stat key, limits;
//   2. a dir-mode app: found / index.html / extensionless / SPA / 404 page / redirects / headers / bytes (whole and streamed,
//      byte-exact) / a manifest swapped under a running worker / missing and malformed files / hashes that try to leave the view;
//   3. conditional requests (If-None-Match against "<hash>": list, W/, *, no match) from a Request, init and a bare path, with
//      a compatibility date before 2026-11-22 left as it was, and the same on baked assets.
const work = mkdtempSync(join(tmpdir(), "sb-native-assets-dir-"));
const procs: ReturnType<typeof Bun.spawn>[] = [];
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const MiB = 1024 * 1024;

// ---------------------------------------------------------------- 1. the C helpers
{
  const transport = readFileSync(new URL("../src/transport-embedded.js", import.meta.url), "utf8");
  const start = transport.indexOf("static int sb_assets_hex(");
  const end = transport.indexOf("// Best-effort: a metadata row deleted with no blob file");
  assert(start > 0 && end > start, "the assets C block moved in the transport");
  const c = join(work, "c");
  mkdirSync(c);
  writeFileSync(join(c, "block.c"), transport.slice(start, end));
  writeFileSync(
    join(c, "driver.c"),
    `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#ifdef __APPLE__
#define SB_LTX_MTIME_NS(st) ((uint64_t)(st).st_mtimespec.tv_sec * 1000000000ull + (uint64_t)(st).st_mtimespec.tv_nsec)
#else
#define SB_LTX_MTIME_NS(st) ((uint64_t)(st).st_mtim.tv_sec * 1000000000ull + (uint64_t)(st).st_mtim.tv_nsec)
#endif
#include "block.c"
// One call per line: OP DIR NAME OFF CAP (NAME "-" is the empty name). Prints the result and, for a read, its bytes in hex.
int main(void) {
  char line[4096];
  while (fgets(line, sizeof(line), stdin)) {
    int op; char dir[2048], name[512]; unsigned long off, cap;
    if (sscanf(line, "%d %2047s %511s %lu %lu", &op, dir, name, &off, &cap) != 5) return 2;
    if (!strcmp(name, "-")) name[0] = 0;
    char* out = malloc(cap + 1);
    long n = sb_assets_op(op, dir, name, off, out, cap);
    printf("%ld", n);
    if ((op == 1 || op == 3) && n > 0) { printf(" "); for (long i = 0; i < n && i < 64; i++) printf("%02x", (unsigned char)out[i]); }
    printf("\\n"); fflush(stdout);
    free(out);
  }
  return 0;
}
`,
  );
  const driver = join(c, "driver");
  const built = Bun.spawnSync(["cc", "-O1", "-w", "-I", c, join(c, "driver.c"), "-o", driver]);
  assert.equal(built.exitCode, 0, built.stderr.toString());
  const run = (calls: (string | number)[][]) => {
    const p = Bun.spawnSync([driver], { stdin: Buffer.from(calls.map((x) => x.join(" ")).join("\n") + "\n") });
    assert.equal(p.exitCode, 0, p.stderr.toString());
    return p.stdout.toString().trim().split("\n");
  };
  // One driver process kept open, so its remembered manifest key survives the files changing under it.
  const session = Bun.spawn([driver], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  procs.push(session);
  const reader = session.stdout.getReader();
  let pending = "";
  const call = async (...args: (string | number)[]) => {
    session.stdin.write(args.join(" ") + "\n");
    session.stdin.flush();
    while (!pending.includes("\n")) {
      const { value, done } = await reader.read();
      assert(!done, "the C driver exited");
      pending += new TextDecoder().decode(value);
    }
    const at = pending.indexOf("\n");
    const line = pending.slice(0, at);
    pending = pending.slice(at + 1);
    return line.split(" ")[0]!;
  };

  const view = join(c, "view");
  mkdirSync(join(view, "blobs"), { recursive: true });
  const body = Buffer.from("hello assets");
  const good = sha(body);
  writeFileSync(join(view, "blobs", good), body);
  writeFileSync(join(view, "manifest.json"), "{}");
  // Things a view must not let through: symlinks (to a real file outside the view), a directory, a fifo.
  writeFileSync(join(c, "secret"), "outside the view");
  symlinkSync(join(c, "secret"), join(view, "blobs", "a".repeat(64)));
  mkdirSync(join(view, "blobs", "b".repeat(64)));
  assert.equal(Bun.spawnSync(["mkfifo", join(view, "blobs", "c".repeat(64))]).exitCode, 0);
  // An oversize manifest.
  const big = join(c, "bigview");
  mkdirSync(join(big, "blobs"), { recursive: true });
  writeFileSync(join(big, "manifest.json"), Buffer.alloc(4 * MiB + 1, 0x20));
  // A view whose `blobs` is a symlink to a directory that has the blob, and one whose manifest.json is a symlink.
  const linked = join(c, "linked");
  mkdirSync(linked);
  symlinkSync(join(view, "blobs"), join(linked, "blobs"));
  symlinkSync(join(c, "secret"), join(linked, "manifest.json"));

  const upper = good.toUpperCase();
  const r = run([
    [2, view, good, 0, 0], // the size of a blob
    [3, view, good, 0, 100], // read it whole
    [3, view, good, 6, 100], // read from an offset
    [3, view, good, 0, 5], // a short window
    [3, view, good, 99, 10], // past the end
    [2, view, upper, 0, 0], // uppercase hex
    [2, view, good.slice(1), 0, 0], // 63 chars
    [2, view, good + "0", 0, 0], // 65 chars
    [2, view, "../manifest.json", 0, 0],
    [2, view, "..%2fmanifest.json", 0, 0],
    [2, view, "blobs/" + good, 0, 0],
    [2, view, "-", 0, 0], // an empty blob name must not fall through to the manifest
    [2, view, "a".repeat(64), 0, 0], // a symlink to a file outside
    [2, view, "b".repeat(64), 0, 0], // a directory
    [2, view, "c".repeat(64), 0, 0], // a fifo
    [2, view, "d".repeat(64), 0, 0], // not there
    [2, join(c, "missing"), good, 0, 0], // no view
    [0, linked, "-", 0, 0], // manifest.json is a symlink
    [2, linked, good, 0, 0], // blobs is a symlink
    [0, big, "-", 0, 0], // manifest over 4 MiB
  ]);
  assert.deepEqual(r.slice(0, 5), ["12", "12 68656c6c6f20617373657473", "6 617373657473", "5 68656c6c6f", "0"]);
  assert.deepEqual(
    r.slice(5),
    Array(15)
      .fill("-1")
      .map((x, i) => (i === 14 ? "-2" : x)),
  );

  // The stat key: a manifest not read yet is "changed"; read it, and it is not until the file is replaced.
  const m = (text: string) => {
    const t = join(view, "manifest.tmp");
    writeFileSync(t, text);
    renameSync(t, join(view, "manifest.json"));
  };
  const text1 = '{"files":{}}';
  m(text1);
  const size = text1.length;
  assert.equal(await call(0, view, "-", 0, 0), String(size * 2 + 1), "not read yet");
  assert.equal(await call(1, view, "-", 0, size + 1), "-3", "size differs from the stat");
  assert.equal(await call(0, view, "-", 0, 0), String(size * 2 + 1), "a failed read remembers nothing");
  assert.equal(await call(1, view, "-", 0, size), String(size));
  assert.equal(await call(0, view, "-", 0, 0), String(size * 2), "unchanged");
  m(text1); // the same bytes in another file (another inode, another mtime)
  assert.equal(await call(0, view, "-", 0, 0), String(size * 2 + 1), "replaced by rename");
  assert.equal(await call(1, view, "-", 0, size), String(size));
  assert.equal(await call(0, view, "-", 0, 0), String(size * 2));
  await Bun.sleep(20);
  writeFileSync(join(view, "manifest.json"), text1.replace("{}", "{ }")); // in place, one byte longer
  assert.equal(await call(0, view, "-", 0, 0), String((size + 1) * 2 + 1), "rewritten in place");
  session.stdin.end();
  console.log("assets C helpers: ok");
}

// ---------------------------------------------------------------- 2 and 3. compiled apps
const handler = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return new Response("pong");
    const p = url.searchParams.get("p");
    const inm = url.searchParams.get("inm");
    const via = url.searchParams.get("via") || "request";
    const h = inm == null ? {} : { "if-none-match": inm };
    try {
      // meta=1: what the ASSETS response itself carries (the server sends streamed bodies chunked and drops content-length).
      if (url.searchParams.get("meta")) {
        const res = await env.ASSETS.fetch(new Request("http://x" + p));
        return Response.json({ status: res.status, length: res.headers.get("content-length"), etag: res.headers.get("etag") });
      }
      if (via === "string") return await env.ASSETS.fetch(p, inm == null ? undefined : { headers: h });
      if (via === "init") return await env.ASSETS.fetch("http://x" + p, { headers: h });
      return await env.ASSETS.fetch(new Request("http://x" + p, { headers: h }));
    } catch (e) {
      return new Response("ERR " + e.message, { status: 500 });
    }
  },
};
`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

type Entry = { hash: string | number; size: number; type: string };
const view = join(work, "view");
mkdirSync(join(view, "blobs"), { recursive: true });
const files: Record<string, Entry> = {};
const content = new Map<string, Buffer>();
const put = (path: string, data: Buffer | string, type: string) => {
  const b = Buffer.from(data);
  const hash = sha(b);
  writeFileSync(join(view, "blobs", hash), b);
  files[path] = { hash, size: b.length, type };
  content.set(path, b);
  return b;
};
put("/index.html", "<h1>home</h1>", "text/html; charset=utf-8");
put("/about.html", "<h1>about</h1>", "text/html; charset=utf-8");
put("/docs/index.html", "<h1>docs</h1>", "text/html; charset=utf-8");
put("/app.css", "body{color:red}", "text/css; charset=utf-8");
put("/404.html", "<h1>nothing here</h1>", "text/html; charset=utf-8");
put("/empty.txt", "", "text/plain; charset=utf-8");
// Every byte value, so a text decode anywhere would show.
put("/small.bin", Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)), "application/octet-stream");
put("/whole.bin", randomBytes(300 * 1024), "application/octet-stream");
put("/exact.bin", randomBytes(MiB), "application/octet-stream");
put("/over.bin", randomBytes(MiB + 1), "application/octet-stream");
put("/big.bin", randomBytes(3 * MiB + 17), "application/octet-stream");
const bytesOf = (path: string) => content.get(path) ?? Buffer.alloc(0);
// Entries a view must never serve: a blob that is not there, and hashes that try to leave it.
files["/ghost.txt"] = { hash: sha("a blob nobody uploaded"), size: 3, type: "text/plain" };
files["/evil-dots"] = { hash: "../manifest.json", size: 3, type: "text/plain" };
files["/evil-up"] = { hash: sha("<h1>home</h1>").toUpperCase(), size: 3, type: "text/plain" };
files["/evil-short"] = { hash: sha("<h1>home</h1>").slice(1), size: 3, type: "text/plain" };
files["/evil-slash"] = { hash: "x/../../" + "0".repeat(56), size: 3, type: "text/plain" };
files["/evil-num"] = { hash: 7, size: 3, type: "text/plain" };
const rules = {
  redirects: [{ from: "/old", to: "/about", status: 301 }],
  headers: [{ pattern: "/docs/*", set: [["x-docs", "yes"]], unset: [] }],
};
const manifestOf = (notFound: string) => ({ notFound, runSproutFirst: false, files, ...rules });
const writeManifest = (notFound: string, text?: string) => {
  const t = join(view, "manifest.tmp");
  writeFileSync(t, text ?? JSON.stringify(manifestOf(notFound)));
  renameSync(t, join(view, "manifest.json"));
};
writeManifest("404-page");

// Baked assets: a few small files, one binary.
const bakedFiles = new Map<string, Buffer>([
  ["/index.html", Buffer.from("<h1>baked home</h1>")],
  ["/about.html", Buffer.from("<h1>baked about</h1>")],
  ["/pic.bin", Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 7) % 256))],
]);
const bakedManifest = {
  notFound: "single-page-application",
  runSproutFirst: false,
  files: Object.fromEntries(
    [...bakedFiles].map(([p, b]) => [
      p,
      {
        hash: sha(b),
        size: b.length,
        type: p.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream",
      },
    ]),
  ),
  redirects: rules.redirects,
};

// The embedded transport links BearSSL and names the host's trust anchors; an empty set stands in for them here.
const bear = await bearsslEnv();
writeFileSync(
  join(work, "anchors.c"),
  "#include <stddef.h>\n#include <bearssl.h>\nconst br_x509_trust_anchor sb_trust_anchors[1];\nconst size_t sb_trust_anchor_count = 0;\n",
);
const anchors = Bun.spawnSync([
  "cc",
  "-c",
  ...bear.SB_EXTRA_CFLAGS.split(" "),
  join(work, "anchors.c"),
  "-o",
  join(work, "anchors.o"),
]);
assert.equal(anchors.exitCode, 0, anchors.stderr.toString());

// baked: the files in the module, "settings" the bundle a Cloud deploy of assets that did not fit carries (notFound and runSproutFirst, no files).
async function start(label: string, date: string, baked: boolean | "settings", env: Record<string, string>) {
  const core = readFileSync(preludePath, "utf8");
  const transport = readFileSync(transportPath("embedded"), "utf8");
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(work, `${label}.generated.js`);
  const binary = join(work, `${label}-native`);
  writeFileSync(
    generated,
    wrapNativeFetchHandler(
      handler,
      core.replace(TRANSPORT_MARKER, transport),
      {},
      { ...EMPTY_BINDINGS, assets: "ASSETS" },
      undefined,
      date,
      label,
      baked === "settings"
        ? { manifest: { notFound: "404-page", runSproutFirst: true, files: {} }, files: {} }
        : baked
          ? {
              manifest: bakedManifest,
              files: Object.fromEntries([...bakedFiles].map(([p, b]) => [p, b.toString("latin1")])),
            }
          : undefined,
      "embedded",
    ),
  );
  await compileNative({
    generated,
    binary,
    dir: work,
    cacheRoot: work,
    bearssl: true,
    extraLink: [join(work, "anchors.o"), "-lsqlite3"],
  });
  const port = freePort();
  const data = join(work, `${label}-data`);
  mkdirSync(data, { recursive: true });
  const proc = Bun.spawn([binary], {
    cwd: work,
    env: { ...process.env, PORT: String(port), SB_DATA_DIR: data, ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
  procs.push(proc);
  let up = false;
  for (let attempt = 0; attempt < 100 && !up; attempt++) {
    try {
      up =
        (await (await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(5000) })).text()) === "pong";
    } catch {
      if (proc.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(up, `${label} did not start`);
  return async (path: string, query: Record<string, string> = {}) => {
    const url = new URL(`http://127.0.0.1:${port}/`);
    url.searchParams.set("p", path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  };
}

try {
  const dirs = { SB_ASSETS_DIR: view };
  const [dir, old, baked, bakedOld, settings] = await Promise.all([
    start("dir", "2026-11-22", false, dirs),
    start("old", "2026-11-21", false, dirs),
    start("baked", "2026-11-22", true, {}),
    start("bakedold", "2026-11-21", true, {}),
    start("settings", "2026-11-22", "settings", dirs),
  ]);
  const text = (r: { bytes: Buffer }) => r.bytes.toString("utf8");

  // -- found, index.html, extensionless, 404 page, redirects, headers
  let r = await dir("/index.html");
  assert.equal(r.status, 200);
  assert.equal(text(r), "<h1>home</h1>");
  assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(r.headers.get("etag"), `"${files["/index.html"]!.hash}"`);
  assert.equal(text(await dir("/")), "<h1>home</h1>");
  assert.equal(text(await dir("/docs/")), "<h1>docs</h1>");
  assert.equal(text(await dir("/docs")), "<h1>docs</h1>");
  assert.equal(text(await dir("/about")), "<h1>about</h1>");
  assert.equal(text(await dir("/app.css")), "body{color:red}");
  r = await dir("/docs/");
  assert.equal(r.headers.get("x-docs"), "yes");
  assert.equal((await dir("/about")).headers.get("x-docs"), null);
  r = await dir("/old");
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "/about");
  r = await dir("/nothing/here");
  assert.equal(r.status, 404);
  assert.equal(text(r), "<h1>nothing here</h1>");
  assert.equal(r.headers.get("etag"), null, "a 404 page has no etag");
  r = await dir("/empty.txt");
  assert.equal(r.status, 200);
  assert.equal(r.bytes.length, 0);

  // -- bytes: whole reads and streams, byte-exact
  for (const name of ["/small.bin", "/whole.bin", "/exact.bin"] as const) {
    assert.equal(JSON.parse((await dir(name, { meta: "1" })).bytes.toString()).length, null, `${name} is read whole`);
    r = await dir(name);
    assert.equal(r.status, 200, name);
    assert(r.bytes.equals(bytesOf(name)), `${name} is not byte-exact`);
  }
  for (const name of ["/over.bin", "/big.bin"] as const) {
    r = await dir(name);
    assert.equal(r.status, 200, name);
    const meta = JSON.parse((await dir(name, { meta: "1" })).bytes.toString());
    assert.equal(meta.status, 200, name);
    assert.equal(meta.length, String(bytesOf(name).length), `${name} content-length of the response`);
    assert.equal(meta.etag, `"${files[name]!.hash}"`);
    assert(r.bytes.equals(bytesOf(name)), `${name} (streamed) is not byte-exact`);
  }

  // -- hashes that try to leave the view, and files that are not there
  for (const name of ["/evil-dots", "/evil-up", "/evil-short", "/evil-slash", "/evil-num"]) {
    r = await dir(name);
    assert.equal(r.status, 500, `${name} must not be served`);
    assert(text(r).startsWith("ERR "), `${name}: ${text(r)}`);
    assert(!text(r).includes("home") && !text(r).includes("{"), `${name} leaked bytes`);
  }
  r = await dir("/ghost.txt");
  assert.equal(r.status, 500);
  assert(text(r).startsWith("ERR sproutboat assets"), text(r));

  // -- a manifest swapped under the running worker is picked up (SPA now), with no restart
  writeManifest("single-page-application");
  r = await dir("/nothing/here");
  assert.equal(r.status, 200);
  assert.equal(text(r), "<h1>home</h1>");
  assert.equal(r.headers.get("etag"), `"${files["/index.html"]!.hash}"`);
  // ... a new file appears
  put("/new.txt", "fresh", "text/plain; charset=utf-8");
  writeManifest("none");
  assert.equal(text(await dir("/new.txt")), "fresh");
  r = await dir("/nothing/here");
  assert.equal(r.status, 404);
  assert.equal(text(r), "Not Found");

  // -- no manifest at all (an empty view: no assets deployed) is a 404 for every path; a malformed one is an error each
  //    time; the worker recovers when the manifest is back
  const keep = readFileSync(join(view, "manifest.json"));
  rmSync(join(view, "manifest.json"));
  for (let i = 0; i < 2; i++) {
    r = await dir("/index.html");
    assert.equal(r.status, 404);
    assert.equal(text(r), "Not Found");
  }
  writeManifest("none", "{not json");
  for (let i = 0; i < 2; i++) assert.equal((await dir("/index.html")).status, 500, "a malformed manifest");
  writeManifest("none", "[1,2]");
  assert.equal((await dir("/index.html")).status, 500, "a manifest with no files");
  writeFileSync(join(view, "manifest.tmp"), keep);
  renameSync(join(view, "manifest.tmp"), join(view, "manifest.json"));
  assert.equal(text(await dir("/index.html")), "<h1>home</h1>");
  writeManifest("404-page");

  // -- conditional requests
  const tag = `"${files["/about.html"]!.hash}"`;
  const other = `"${"0".repeat(64)}"`;
  const via = ["request", "init", "string"];
  for (const how of via) {
    const cases: [string, boolean][] = [
      [tag, true],
      [`${other}, ${tag}`, true],
      [`${other},${tag}`, true],
      [`W/${tag}`, true],
      [`${other}, W/${tag}`, true],
      ["*", true],
      [other, false],
      ["", false],
      [`${tag.slice(0, -1)}x"`, false],
      [tag.slice(1, -1), false],
    ];
    for (const [inm, hit] of cases) {
      const label = `${how} If-None-Match: ${inm}`;
      r = await dir("/about", { inm, via: how });
      if (hit) {
        assert.equal(r.status, 304, label);
        assert.equal(r.bytes.length, 0, label);
        assert.equal(r.headers.get("etag"), tag, label);
      } else {
        assert.equal(r.status, 200, label);
        assert.equal(text(r), "<h1>about</h1>", label);
      }
    }
  }
  // a 304 reads no body: the ghost's blob is not there, and its tag still answers
  r = await dir("/ghost.txt", { inm: `"${files["/ghost.txt"]!.hash}"` });
  assert.equal(r.status, 304);
  assert.equal((await dir("/ghost.txt", { inm: other })).status, 500);
  // a big file answers 304 without being streamed; a 404 page and a redirect never do
  r = await dir("/big.bin", { inm: `"${files["/big.bin"]!.hash}"` });
  assert.equal(r.status, 304);
  assert.equal(r.bytes.length, 0);
  assert.equal((await dir("/nothing/here", { inm: "*" })).status, 404);
  assert.equal((await dir("/old", { inm: "*" })).status, 301);
  // the rules' headers ride the 304
  assert.equal((await dir("/docs/", { inm: "*" })).headers.get("x-docs"), "yes");
  // a compatibility date before 2026-11-22: no conditional handling at all
  for (const how of via) {
    r = await old("/about", { inm: "*", via: how });
    assert.equal(r.status, 200, `old date, ${how}`);
    assert.equal(text(r), "<h1>about</h1>");
  }
  assert.equal(text(await old("/docs")), "<h1>docs</h1>");
  assert.equal((await old("/big.bin")).bytes.length, bytesOf("/big.bin").length);

  // -- the Cloud's own shape: the module carries the settings and no files, the host gives the view; the files come from the view
  r = await settings("/index.html");
  assert.equal(r.status, 200, "settings-only bundle: the view is served");
  assert.equal(text(r), "<h1>home</h1>");
  assert.equal((await settings("/nope/never")).status, 404);
  assert.equal((await settings("/about")).status, 200);
  r = await settings("/big.bin");
  assert.equal(r.status, 200);

  // -- baked assets: the same reply as ever, now with 304 from the date on
  r = await baked("/about");
  assert.equal(r.status, 200);
  assert.equal(text(r), "<h1>baked about</h1>");
  assert.equal(text(await baked("/")), "<h1>baked home</h1>");
  assert.equal(text(await baked("/no/such/page")), "<h1>baked home</h1>");
  r = await baked("/pic.bin");
  assert(r.bytes.equals(bakedFiles.get("/pic.bin") ?? Buffer.alloc(0)), "baked binary is not byte-exact");
  assert.equal((await baked("/old")).status, 301);
  const bakedTag = `"${bakedManifest.files["/about.html"]!.hash}"`;
  assert.equal(r.headers.get("etag"), `"${bakedManifest.files["/pic.bin"]!.hash}"`);
  for (const how of via) {
    r = await baked("/about", { inm: `${other}, W/${bakedTag}`, via: how });
    assert.equal(r.status, 304, `baked ${how}`);
    assert.equal(r.bytes.length, 0);
    assert.equal(r.headers.get("etag"), bakedTag);
    assert.equal((await baked("/about", { inm: other, via: how })).status, 200);
    assert.equal((await bakedOld("/about", { inm: "*", via: how })).status, 200, `baked, old date, ${how}`);
  }
  assert.equal((await baked("/about", { inm: "*" })).status, 304);
  console.log("assets from a directory: ok");
} finally {
  for (const p of procs) {
    p.kill(9);
    await p.exited;
  }
  rmSync(work, { recursive: true, force: true });
}
