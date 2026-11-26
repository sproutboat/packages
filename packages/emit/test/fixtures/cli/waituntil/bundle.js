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
export {
  src_default as default
};
