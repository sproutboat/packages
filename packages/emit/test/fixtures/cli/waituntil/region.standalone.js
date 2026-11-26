globalThis.__sbCompat = "2026-11-18";
__sbSetCompat("2026-11-18");
globalThis.__sbAppName = "waituntil";
const env = {};
globalThis.env = env;
__sbSetEnv(env);
__sbInstallFetch();
__sbInstallBindings(env, {"kv":["LOG"],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
const __sbUserHandlers = (() => {
// src/index.ts
var src_default = {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/check") {
      return new Response(await env.LOG.get("last") ?? `unset
`);
    }
    ctx.waitUntil(env.LOG.put("last", String(Date.now())));
    return new Response(`ok
`);
  }
};
const __sbHandlers = src_default;

__sbStartLocalTriggers(__sbHandlers, {"kv":["LOG"],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
return __sbHandlers;
})();
export default {
  port: 8080,
  fetch(request) { return __sbEntry(__sbUserHandlers, request); }
};
