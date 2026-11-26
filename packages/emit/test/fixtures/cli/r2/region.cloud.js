globalThis.__sbCompat = "2026-11-18";
__sbSetCompat("2026-11-18");
globalThis.__sbAppName = "r2-example";
const env = {};
globalThis.env = env;
__sbSetEnv(env);
__sbInstallFetch();
__sbInstallBindings(env, {"kv":[],"secrets":[],"d1":[],"r2":["FILES"],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
const __sbUserHandlers = (() => {
// src/index.ts
var src_default = {
  async fetch(request, env) {
    const key = new URL(request.url).pathname.slice(1);
    if (!key) {
      const { objects } = await env.FILES.list();
      return new Response(objects.map((object) => `${object.key}	${object.size}
`).join(""));
    }
    switch (request.method) {
      case "PUT":
        await env.FILES.put(key, request.body);
        return new Response(`stored
`, { status: 201 });
      case "DELETE":
        await env.FILES.delete(key);
        return new Response(null, { status: 204 });
      default: {
        const object = await env.FILES.get(key);
        if (!object)
          return new Response(`not found
`, { status: 404 });
        const headers = new Headers({ etag: object.httpEtag });
        object.writeHttpMetadata(headers);
        return new Response(object.body, { headers });
      }
    }
  }
};
const __sbHandlers = src_default;

__sbStartLocalTriggers(__sbHandlers, {"kv":[],"secrets":[],"d1":[],"r2":["FILES"],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
return __sbHandlers;
})();
export default {
  port: 8080,
  fetch(request) { return __sbEntry(__sbUserHandlers, request); }
};
