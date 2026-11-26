import { describe, expect, test } from "bun:test";
import { emitLocal, type Json } from "./index";
import { runBundle } from "../test/run-bundle";

const metadata = { main_module: "index.js", compatibility_date: "2026-11-23", compatibility_flags: ["nodejs_compat"] };

async function answer(source: string): Promise<Json> {
  const result = await emitLocal(
    { modules: [{ name: "index.js", type: "esm", content: source }], metadata },
    { name: "app" },
  );
  return JSON.parse((await runBundle(result.bundled, {})).body);
}

describe("node:net isIP follows Node's rules", () => {
  const cases: [string, 0 | 4 | 6][] = [
    ["1.2.3.4", 4],
    ["256.1.1.1", 0],
    ["::1", 6],
    ["::", 6],
    ["1::", 6],
    ["1:2:3:4:5:6:7:8", 6],
    ["1:2:3:4:5:6:7", 0],
    ["1:2:3:4:5:6:7:8:9", 0],
    ["::ffff:1.2.3.4", 6],
    ["1:2:3:4:5:6:1.2.3.4", 6],
    ["::1.2.3", 0],
    ["fe80::1%eth0", 6],
    ["fe80::1%", 0],
    [":", 0],
    [":::", 0],
    ["1::2::3", 0],
    ["12345::", 0],
    ["g::", 0],
    ["1:2:3:4:5:6:7::", 6],
    ["1:2:3:4:5:6:7:8::", 0],
    ["", 0],
    ["example.com", 0],
  ];
  test("a table of valid and invalid addresses", async () => {
    const source = `import { isIP } from "node:net"; const cases = ${JSON.stringify(cases.map(([text]) => text))}; export default { fetch() { return Response.json(cases.map((text) => isIP(text))); } };`;
    expect(await answer(source)).toEqual(cases.map(([, kind]) => kind));
  });
});

describe("node:querystring parse follows Node's rules", () => {
  test("empty segments are skipped; an empty key with a value is kept", async () => {
    const source = `import qs from "node:querystring"; export default { fetch() { return Response.json([qs.parse("a=1&&b=2"), qs.parse("=v"), qs.parse("&"), qs.parse("a"), qs.parse("a=1&a=2&")]); } };`;
    expect(await answer(source)).toEqual([{ a: "1", b: "2" }, { "": "v" }, {}, { a: "" }, { a: ["1", "2"] }]);
  });
});
