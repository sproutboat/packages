globalThis.__sbCompat = "2026-11-23";
__sbSetCompat("2026-11-23");
globalThis.__sbAppName = "kv-example";
const env = {};
globalThis.env = env;
__sbSetEnv(env);
__sbInstallFetch();
__sbInstallBindings(env, {"kv":["NOTES"],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
const __sbUserHandlers = (() => {
// src/index.ts
var src_default = {
  async fetch(request, env) {
    const key = new URL(request.url).pathname.slice(1);
    if (!key) {
      const { keys } = await env.NOTES.list();
      return new Response(keys.map((entry) => entry.name).join(`
`) + `
`);
    }
    switch (request.method) {
      case "PUT":
        await env.NOTES.put(key, await request.text());
        return new Response(`saved
`, { status: 201 });
      case "DELETE":
        await env.NOTES.delete(key);
        return new Response(null, { status: 204 });
      default: {
        const value = await env.NOTES.get(key);
        return value === null ? new Response(`not found
`, { status: 404 }) : new Response(value + `
`);
      }
    }
  }
};
const __sbHandlers = src_default;

__sbStartLocalTriggers(__sbHandlers, {"kv":["NOTES"],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
return __sbHandlers;
})();
export default {
  port: 8080,
  fetch(request) { return __sbEntry(__sbUserHandlers, request); }
};
