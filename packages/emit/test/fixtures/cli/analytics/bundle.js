// src/index.ts
var src_default = {
  async fetch(request, env) {
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      env.EVENTS.writeDataPoint({ blobs: [body.path || "/"], doubles: [1], indexes: ["pageview"] });
      return new Response(`recorded
`, { status: 202 });
    }
    const { rows } = await env.EVENTS.query({ limit: 20 });
    return Response.json(rows);
  }
};
export {
  src_default as default
};
