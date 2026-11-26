// src/index.ts
var src_default = {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api/time") {
      return Response.json({ now: new Date().toISOString() });
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  src_default as default
};
