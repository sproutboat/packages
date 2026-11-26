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
export {
  src_default as default
};
