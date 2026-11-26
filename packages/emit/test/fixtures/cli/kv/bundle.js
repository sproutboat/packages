// src/index.ts
var src_default = {
  async fetch(request, env) {
    const key = new URL(request.url).pathname.slice(1);
    if (!key) {
      const { keys } = await env.NOTES.list();
      return new Response(keys.map((entry) => entry.name).join(`
`) + `
`);
    }
    switch (request.method) {
      case "PUT":
        await env.NOTES.put(key, await request.text());
        return new Response(`saved
`, { status: 201 });
      case "DELETE":
        await env.NOTES.delete(key);
        return new Response(null, { status: 204 });
      default: {
        const value = await env.NOTES.get(key);
        return value === null ? new Response(`not found
`, { status: 404 }) : new Response(value + `
`);
      }
    }
  }
};
export {
  src_default as default
};
