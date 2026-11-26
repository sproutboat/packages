globalThis.__sbCompat = "2026-11-18";
__sbSetCompat("2026-11-18");
globalThis.__sbAppName = "durable-object";
const env = {};
globalThis.env = env;
__sbSetEnv(env);
__sbInstallFetch();
__sbInstallBindings(env, {"kv":[],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[{"binding":"COUNTERS","className":"Counter"}],"services":[],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
const __sbUserHandlers = (() => {
// src/index.ts
const { DurableObject } = globalThis;

class Counter extends DurableObject {
  async increment() {
    const n = (await this.ctx.storage.get("n") ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    return n;
  }
  async alarm() {
    console.log("counter settled at", await this.ctx.storage.get("n"));
  }
}
var src_default = {
  async fetch(request, env) {
    const name = new URL(request.url).pathname.slice(1) || "default";
    const counter = env.COUNTERS.getByName(name);
    return new Response(`${name}: ${await counter.increment()}
`);
  }
};
const __sbHandlers = src_default;

__sbRegisterDO({ Counter: Counter });
__sbStartLocalTriggers(__sbHandlers, {"kv":[],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[{"binding":"COUNTERS","className":"Counter"}],"services":[],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
return __sbHandlers;
})();
export default {
  port: 8080,
  fetch(request) { return __sbEntry(__sbUserHandlers, request); }
};
