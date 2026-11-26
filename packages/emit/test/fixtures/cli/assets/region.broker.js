globalThis.__sbCompat = "2026-11-18";
__sbSetCompat("2026-11-18");
globalThis.__sbAppName = "assets";
const env = {};
globalThis.env = env;
__sbSetEnv(env);
__sbInstallFetch();
__sbInstallBindings(env, {"kv":[],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"ASSETS","vars":{},"resources":{}});
const __sbUserHandlers = (() => {
// src/index.ts
var src_default = {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api/time") {
      return Response.json({ now: new Date().toISOString() });
    }
    return env.ASSETS.fetch(request);
  }
};
const __sbHandlers = src_default;

__sbStartLocalTriggers(__sbHandlers, {"kv":[],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"ASSETS","vars":{},"resources":{}});
return __sbHandlers;
})();
export default {
  port: 8080,
  fetch(request) { return __sbEntry(__sbUserHandlers, request); }
};
