import { expect, test } from "bun:test";
import { validateHttpSyncSource } from "./source";
import { EMPTY_BINDINGS, wrapNativeFetchHandler } from "./wrap";

// B22: a Worker may export only scheduled() or queue(), as on workerd (Cloudflare's
// cron-trigger example), and a Worker with crons but no other binding gets its triggers.
const cronOnly = `export default { async scheduled(controller, env, ctx) { console.log("cron"); } };`;
const queueOnly = `export default { async queue(batch, env) { batch.ackAll(); } };`;

test("scheduled() or queue() alone is a valid entry", () => {
  expect(validateHttpSyncSource(cronOnly)).toEqual({ ok: true });
  expect(validateHttpSyncSource(queueOnly)).toEqual({ ok: true });
  expect(validateHttpSyncSource(`export default { hello() { return 1; } };`).ok).toBe(false);
});

test("crons alone start the local triggers", () => {
  const out = wrapNativeFetchHandler(cronOnly, "/*prelude*/", {}, { ...EMPTY_BINDINGS, crons: ["* * * * *"] });
  expect(out).toContain("__sbStartLocalTriggers(__sbHandlers, {");
  expect(out).toContain('"crons":["* * * * *"]');
});

test("a Worker with no bindings and no crons starts none", () => {
  const out = wrapNativeFetchHandler(`export default { fetch() { return new Response("x"); } };`, "/*prelude*/");
  expect(out).not.toContain("__sbStartLocalTriggers(");
});

// Cloudflare accepts any function-valued `fetch`, not only the method form.
test("the arrow, function and reference forms of a handler are valid entries, as on Cloudflare", () => {
  const valid = [
    `export default { fetch: (req, env, ctx) => new Response("a") };`,
    `export default { fetch: async (req, env, ctx) => new Response("a") };`,
    `export default { fetch: async req => new Response("a") };`,
    `export default { fetch: req => new Response("a") };`,
    `export default { fetch: function (req) { return new Response("a"); } };`,
    `export default { fetch: async function (req) { return new Response("a"); } };`,
    `const fetch = async () => new Response("a"); export default { fetch };`,
    `const handle = async () => new Response("a"); export default { fetch: handle };`,
    `export default { scheduled: async (controller, env, ctx) => {} };`,
    `export default { queue: async (batch, env) => batch.ackAll() };`,
    // the minified shapes a bundler leaves
    `var s={fetch:async(e,t,r)=>new Response("a")};export{s as default};`,
    `var s={fetch:async e=>new Response("a")};export{s as default};`,
    `var s={fetch:(e)=>new Response("a")};export{s as default};`,
  ];
  for (const source of valid) {
    expect(validateHttpSyncSource(source), source).toEqual({ ok: true });
    expect(() => wrapNativeFetchHandler(source, "/*prelude*/"), source).not.toThrow();
  }
});

test("a module with no entry handler is still refused, arrow-looking properties included", () => {
  const invalid = [
    `export default { hello: (req) => 1 };`,
    `export default { handler: async (req) => new Response("a") };`,
    `export default { fetcher: (req) => 1, requeue: () => 2 };`,
    `export default { name: "fetch" };`,
    `export default {};`,
  ];
  for (const source of invalid) {
    expect(validateHttpSyncSource(source).ok, source).toBe(false);
    expect(() => wrapNativeFetchHandler(source, "/*prelude*/"), source).toThrow(/default-export an object/);
  }
});
