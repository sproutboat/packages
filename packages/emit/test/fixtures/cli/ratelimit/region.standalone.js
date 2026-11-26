globalThis.__sbCompat = "2026-11-18";
__sbSetCompat("2026-11-18");
globalThis.__sbAppName = "ratelimit";
const env = {};
globalThis.env = env;
__sbSetEnv(env);
__sbInstallFetch();
__sbInstallBindings(env, {"kv":[],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[{"binding":"API","limit":3,"period":60}],"assets":"","vars":{},"resources":{}});
const __sbUserHandlers = (() => {
// src/index.ts
var PERIOD_SECONDS = 60;
var src_default = {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/limited")
      return new Response(`ratelimit demo: hit /limited
`);
    const { success } = await env.API.limit({ key: "demo" });
    if (!success) {
      return new Response(`slow down
`, { status: 429, headers: { "retry-after": String(PERIOD_SECONDS) } });
    }
    return new Response(`ok
`);
  }
};
const __sbHandlers = src_default;

__sbStartLocalTriggers(__sbHandlers, {"kv":[],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[{"binding":"API","limit":3,"period":60}],"assets":"","vars":{},"resources":{}});
return __sbHandlers;
})();
export default {
  port: 8080,
  fetch(request) { return __sbEntry(__sbUserHandlers, request); }
};
