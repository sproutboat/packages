// sproutboat #181 - the prelude is prepended as text and cannot import, so this lifts __sbFromUtf8 out and runs it; if its markers change
// this fails loudly instead of testing nothing.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./native-fetch-prelude.js", import.meta.url)), "utf8");
const start = src.indexOf("function __sbFromUtf8(");
const end = src.indexOf("// sproutboat #181 — wrap a Response");
if (start === -1 || end === -1 || end < start) throw new Error("__sbFromUtf8 block not found in prelude");

// oxlint-disable-next-line no-function-constructor -- lifting a pure block out of the text-only prelude for test
const load = new Function(
  `// The C fast paths (Porffor.c) cannot run here: the stubs make the JS fallback run.\nfunction __sbFromUtf8Native() { return ""; }\nfunction __sbToBytesNative() { return ""; }\n${src.slice(start, end)}\nreturn { __sbFromUtf8 };`,
);
const { __sbFromUtf8 } = load();

/** Build a bytestring (one char per raw byte) the way __sbToBytes/porf_native_fetch_alloc_bytestring would, from real UTF-8 bytes. */
function toBytestring(text) {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

test("decodes real UTF-8 bytes back to the original text", () => {
  const text = "porffor · src/index.js → 1.25 MB · x86_64-musl ✓";
  expect(__sbFromUtf8(toBytestring(text))).toBe(text);
});

test("multi-byte and 4-byte (surrogate-pair) sequences round-trip", () => {
  expect(__sbFromUtf8(toBytestring("café"))).toBe("café");
  expect(__sbFromUtf8(toBytestring("🌱"))).toBe("🌱");
});

test("a genuine Latin-1-range string with no real UTF-8 sequences passes through unchanged", () => {
  // "héllo" here is a real JS string (one code point per character), not
  // re-encoded bytes -- exactly what a handler-built bytestring looks like.
  // This must NOT be decoded, or it corrupts ordinary accented text.
  expect(__sbFromUtf8("héllo")).toBe("héllo");
  expect(__sbFromUtf8("café")).toBe("café");
});

test("a lead byte with an invalid or missing continuation passes through raw", () => {
  expect(__sbFromUtf8(String.fromCharCode(0xe9))).toBe(String.fromCharCode(0xe9));
  expect(__sbFromUtf8(String.fromCharCode(0xc2))).toBe(String.fromCharCode(0xc2)); // truncated 2-byte lead
});

test("empty and pure-ASCII strings are untouched", () => {
  expect(__sbFromUtf8("")).toBe("");
  expect(__sbFromUtf8("hello world")).toBe("hello world");
});

// __sbFromUtf8 builds its result via an array + one join(): Porffor strings have no rope optimization, so `+=` in a loop is O(n^2) (a real 2.6 s
// stall decoding a 43KB page). A correctness check (long input round-trips), not a timing assertion: CI timing thresholds are flaky.
test("a long, multi-chunk body round-trips exactly", () => {
  const chunk = "porffor · src/index.js → 1.25 MB · x86_64-musl ✓ café 🌱 ";
  const text = chunk.repeat(800); // ~46KB, comparable to the real homepage
  expect(__sbFromUtf8(toBytestring(text))).toBe(text);
});

// __sbRawBodyResponse must decode lazily: eager decoding paid __sbFromUtf8 on every asset/proxied response, a real regression caught on sproutboat.com.
const rbrStart = src.indexOf("function __sbRawBodyResponse(");
const rbrEnd = src.indexOf("// Constant-time compare of two latin1 byte strings.");
if (rbrStart === -1 || rbrEnd === -1 || rbrEnd < rbrStart) {
  throw new Error("__sbRawBodyResponse block not found in prelude");
}
// oxlint-disable-next-line no-function-constructor -- lifting a pure block out of the text-only prelude for test
const loadRbr = new Function(
  "Response",
  `// The C fast paths (Porffor.c) cannot run here: the stubs make the JS fallback run.\nfunction __sbFromUtf8Native() { return ""; }\nfunction __sbToBytesNative() { return ""; }\n${src.slice(start, end)}\n${src.slice(rbrStart, rbrEnd)}\nreturn { __sbRawBodyResponse };`,
);
// A minimal Response stand-in: only what __sbRawBodyResponse touches (the
// constructor call and setting .text/.json on the instance), no Porffor
// bytestring typing involved.
class FakeResponse {
  constructor(body, init) {
    this.body = body;
    this.status = (init && init.status) || 200;
  }
}
const { __sbRawBodyResponse } = loadRbr(FakeResponse);

test("__sbRawBodyResponse's text()/json() decode correctly, callable more than once", () => {
  const bytes = toBytestring("café · 🌱");
  const resp = __sbRawBodyResponse(bytes, { status: 200 });
  expect(resp.text()).toBe("café · 🌱");
  expect(resp.text()).toBe("café · 🌱"); // memoized decode, not re-run per call
  expect(resp.json).toBeInstanceOf(Function);
});

test("__sbRawBodyResponse with a null body sets no text()/json() override", () => {
  const resp = __sbRawBodyResponse(null, { status: 404 });
  expect(resp.text).toBeUndefined();
  expect(resp.json).toBeUndefined();
});
