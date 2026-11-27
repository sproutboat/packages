// The prelude SHA-256 C (reference block and the x86-64 SHA-NI block) against node:crypto, compiled with the host cc, as shipped
// and with SB_SHA256_NO_NI. Fails loudly if the section markers move.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const prelude = readFileSync(new URL("./native-fetch-prelude.js", import.meta.url), "utf8");
const start = prelude.indexOf("#define SB_ROR32(x, n)");
const end = prelude.indexOf("typedef struct { uint64_t h[8]; uint64_t lenhi");
if (start === -1 || end === -1 || end < start) throw new Error("the SHA-256 section of the prelude was not found");
const sha256C = prelude.slice(start, end);

const driver = `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
${sha256C}
static void emit(const unsigned char* d) { for (int i = 0; i < 32; i++) printf("%02x", d[i]); printf("\\n"); }
int main(int argc, char** argv) {
  if (argc > 1 && strcmp(argv[1], "ni") == 0) {
#if defined(__x86_64__) && !defined(SB_SHA256_NO_NI)
    printf("%d\\n", sb_has_sha_ni());
#else
    printf("0\\n");
#endif
    return 0;
  }
  /* Each line of stdin: LENGTH CHUNK. The message is byte i = (i * 131 + 7) & 255; CHUNK 0 = one update. */
  unsigned long len, chunk;
  while (scanf("%lu %lu", &len, &chunk) == 2) {
    unsigned char* m = (unsigned char*)malloc(len ? len : 1);
    for (unsigned long i = 0; i < len; i++) m[i] = (unsigned char)((i * 131 + 7) & 255);
    sb_sha256_ctx c; sb_sha256_init(&c);
    if (chunk == 0) sb_sha256_update(&c, m, len);
    else for (unsigned long o = 0; o < len; o += chunk) sb_sha256_update(&c, m + o, len - o < chunk ? len - o : chunk);
    unsigned char out[32]; sb_sha256_final(&c, out); emit(out);
    free(m);
  }
  return 0;
}
`;

const dir = mkdtempSync(join(tmpdir(), "sb-sha256-"));
const source = join(dir, "sha256.c");
writeFileSync(source, driver);
// CC="zig cc" runs it with the compiler the Cloud builder uses (clang).
const ccArgv = process.env.CC
  ? process.env.CC.split(" ").filter(Boolean)
  : [Bun.which("cc") ?? Bun.which("gcc") ?? Bun.which("clang") ?? ""].filter(Boolean);
const cc = ccArgv.length > 0;
const build = (name: string, flags: string[]) => {
  const out = join(dir, name);
  const r = Bun.spawnSync([...ccArgv, "-O2", "-Wall", "-Wno-unused-function", ...flags, "-o", out, source], {
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`cc failed:\n${r.stderr.toString().slice(0, 2000)}`);
  return out;
};
const run = (bin: string, args: string[], stdin = "") =>
  Bun.spawnSync([bin, ...args], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .trim();

const message = (len: number) => {
  const m = new Uint8Array(len);
  for (let i = 0; i < len; i++) m[i] = (i * 131 + 7) & 255;
  return m;
};
const expected = (len: number) => createHash("sha256").update(message(len)).digest("hex");

// Every padding boundary, a few block counts, the h2h buffer (64 KiB) and a megabyte.
const lengths = [
  ...Array.from({ length: 200 }, (_, i) => i),
  255,
  256,
  257,
  511,
  512,
  513,
  1000,
  4095,
  4096,
  4097,
  65535,
  65536,
  65537,
  1 << 20,
];
const chunks = [0, 1, 7, 63, 64, 65, 1000];
const cases = lengths.flatMap((l) => chunks.map((c) => [l, c] as const));
const input = cases.map(([l, c]) => `${l} ${c}`).join("\n");

describe.skipIf(!cc)("sb_sha256 in the prelude", () => {
  const shipped = cc ? build("shipped", []) : "";
  const portable = cc ? build("portable", ["-DSB_SHA256_NO_NI"]) : "";
  const want = cases.map(([l]) => expected(l));

  test("the build as shipped matches node:crypto for every length and chunking", () => {
    expect(run(shipped, [], input).split("\n")).toEqual(want);
  });
  test("the reference block alone matches node:crypto for every length and chunking", () => {
    expect(run(portable, [], input).split("\n")).toEqual(want);
  });
  test("SHA-NI is used when the CPU has it", () => {
    const has = process.arch === "x64" && /\bsha_ni\b/.test(safeCpuinfo());
    if (process.arch === "x64" && safeCpuinfo() !== "") expect(run(shipped, ["ni"])).toBe(has ? "1" : "0");
    expect(run(portable, ["ni"])).toBe("0");
  });
  test("the test section really is the one the prelude ships", () => {
    expect(sha256C).toContain("sb_sha256_blocks");
    expect(sha256C).not.toContain("`");
    expect(sha256C).not.toContain("${");
  });
});

function safeCpuinfo(): string {
  try {
    return readFileSync("/proc/cpuinfo", "utf8");
  } catch {
    return "";
  }
}

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
