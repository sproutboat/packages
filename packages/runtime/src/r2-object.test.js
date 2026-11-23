// sproutboat #177 - `new Response(obj.body)` UTF-8-re-encodes an R2 object's raw bytes (a bytestring is indistinguishable from Latin-1 text there);
// `obj.toResponse()` is the fix, using the x-sb-raw-body marker __sbRawBodyResponse already uses. The prelude cannot be imported, so this lifts the functions
// out; if their markers change this fails loudly instead of testing nothing.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./native-fetch-prelude.js", import.meta.url)), "utf8");
// From __sbBufFrom (raw-body arrayBuffer, #232) through __sbFromUtf8.
const utf8Start = src.indexOf("function __sbBufFrom(");
const rawStart = src.indexOf("function __sbRawBodyResponse(");
const utf8End = rawStart;
const rawEnd = src.indexOf("function __sbEqCt(");
const r2Start = src.indexOf("function __sbR2Object(");
const isStrStart = src.indexOf("function __sbIsStr(");
const isStrEnd = src.indexOf("function __sbIsFn(");
const bytesStart = src.indexOf("const __SB_BYTES_WINDOW");
const r2End = src.indexOf("// Installed only when the project declares bindings.");
if (utf8Start === -1 || utf8End === -1) throw new Error("__sbFromUtf8 block not found in prelude");
if (rawStart === -1 || rawEnd === -1) throw new Error("__sbRawBodyResponse block not found in prelude");
if (r2Start === -1 || r2End === -1 || r2End < r2Start) throw new Error("__sbR2Object block not found in prelude");

// oxlint-disable-next-line no-function-constructor -- lifting pure blocks out of the text-only prelude for test
const load = new Function(
  "__sbRpc",
  "__sbR2MultipartPut",
  // __sbIsStr and __sbToBytes (for uploadPart's values), with the C fast paths stubbed out.
  `function __sbFromUtf8Native() { return ""; }\nfunction __sbToBytesNative() { return ""; }\nfunction __sbFillBytes() { return false; }\n${src.slice(isStrStart, isStrEnd)}\n${src.slice(bytesStart, utf8Start)}\n${src.slice(utf8Start, utf8End)}\n${src.slice(rawStart, rawEnd)}\n${src.slice(r2Start, r2End)}\nreturn { __sbR2Object, __sbR2Multipart };`,
);
const calls = [];
const rpc = (op, value) => {
  calls.push({ op, value });
  if (op === "r2.multipart.complete") return { object: meta };
  return { ok: true };
};
const putPart = (bucket, key, uploadId, partNumber, body) => {
  calls.push({ op: "r2.multipart.put", value: { bucket, key, uploadId, partNumber, body } });
  return { part: { partNumber, etag: `part-${partNumber}` } };
};
const { __sbR2Object, __sbR2Multipart } = load(rpc, putPart);

const meta = { key: "f.bin", size: 3, etag: "abc123", uploaded: "2026-09-14T00:00:00.000Z" };

// The byte-for-byte round trip is the compiled runtime's write_response_value (#176); plain JS re-encodes a bytestring like Porffor, so this can only prove
// toResponse() sets the marker that steers it. Byte preservation was verified by hand on a compiled standalone binary (#177).
test("toResponse() tags the response with the runtime's raw-body marker", () => {
  const bytes = [0x80, 0x81, 0xff].map((b) => String.fromCharCode(b)).join("");
  const obj = __sbR2Object(meta, bytes);
  const fixed = obj.toResponse();
  expect(fixed.headers.get("x-sb-raw-body")).toBe("1");
});

test("toResponse() defaults content-type from httpMetadata and etag from httpEtag", () => {
  const obj = __sbR2Object({ ...meta, httpMetadata: { contentType: "image/png" } }, "x");
  const resp = obj.toResponse();
  expect(resp.headers.get("content-type")).toBe("image/png");
  expect(resp.headers.get("etag")).toBe(obj.httpEtag);
});

test("toResponse() lets caller-supplied headers/status override the defaults", () => {
  const obj = __sbR2Object({ ...meta, httpMetadata: { contentType: "image/png" } }, "x");
  const resp = obj.toResponse({ status: 206, headers: { "content-type": "application/octet-stream" } });
  expect(resp.status).toBe(206);
  expect(resp.headers.get("content-type")).toBe("application/octet-stream");
});

test('toResponse() on an empty body still returns bytes, not the string ""', async () => {
  const obj = __sbR2Object(meta, "");
  const resp = obj.toResponse();
  const buf = new Uint8Array(await resp.arrayBuffer());
  expect(buf.length).toBe(0);
});

test("multipart uploads expose the Cloudflare-shaped uploadPart, complete, and abort methods", () => {
  calls.length = 0;
  const upload = __sbR2Multipart("FILES", "archive.bin", "upload-1");
  expect(upload).toMatchObject({ key: "archive.bin", uploadId: "upload-1" });
  expect(upload.uploadPart(1, "first")).toEqual({ partNumber: 1, etag: "part-1" });
  expect(upload.complete([{ partNumber: 1, etag: "part-1" }])).toMatchObject(meta);
  upload.abort();
  expect(calls.map((call) => call.op)).toEqual(["r2.multipart.put", "r2.multipart.complete", "r2.multipart.abort"]);
});

test("uploadPart stores an ArrayBuffer or a view as its bytes, not as [object ArrayBuffer]", () => {
  calls.length = 0;
  const upload = __sbR2Multipart("FILES", "archive.bin", "upload-1");
  upload.uploadPart(1, new Uint8Array([0, 255, 65]).buffer);
  upload.uploadPart(2, new Uint8Array([9, 8, 7, 6]).subarray(1, 3));
  upload.uploadPart(3, "text");
  expect(calls.map((call) => call.value.body)).toEqual(["\u0000ÿA", "\u0008\u0007", "text"]);
});
