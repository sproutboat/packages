globalThis.__sbCompat = "2026-11-18";
__sbSetCompat("2026-11-18");
globalThis.__sbAppName = "service-bindings-caller";
const env = {};
globalThis.env = env;
__sbSetEnv(env);
__sbInstallFetch();
__sbInstallBindings(env, {"kv":[],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[{"binding":"GREETER","service":"service-bindings-callee"}],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
const __sbUserHandlers = (() => {
// src/index.ts
var src_default = {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("name") ?? "there";
    return env.GREETER.fetch(new Request(`https://internal/?name=${encodeURIComponent(name)}`));
  }
};
const __sbHandlers = src_default;

__sbStartLocalTriggers(__sbHandlers, {"kv":[],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[{"binding":"GREETER","service":"service-bindings-callee"}],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
return __sbHandlers;
})();
export default {
  port: 8080,
  fetch(request) { return __sbEntry(__sbUserHandlers, request); }
};
