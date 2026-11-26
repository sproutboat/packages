globalThis.__sbCompat = "2026-11-18";
__sbSetCompat("2026-11-18");
globalThis.__sbAppName = "cron";
const env = {};
globalThis.env = env;
__sbSetEnv(env);
__sbInstallFetch();
__sbInstallBindings(env, {"kv":["STATE"],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":["*/1 * * * *"],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
const __sbUserHandlers = (() => {
// src/index.ts
var src_default = {
  async fetch(request, env) {
    const [ticks, last] = await Promise.all([env.STATE.get("ticks"), env.STATE.get("last")]);
    return new Response(`${ticks ?? 0} ticks, last at ${last ?? "never"}
`);
  },
  async scheduled(controller, env) {
    const ticks = Number(await env.STATE.get("ticks")) + 1;
    await env.STATE.put("ticks", String(ticks));
    await env.STATE.put("last", new Date(controller.scheduledTime).toISOString());
  }
};
const __sbHandlers = src_default;

__sbStartLocalTriggers(__sbHandlers, {"kv":["STATE"],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":["*/1 * * * *"],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
return __sbHandlers;
})();
export default {
  port: 8080,
  fetch(request) { return __sbEntry(__sbUserHandlers, request); }
};
