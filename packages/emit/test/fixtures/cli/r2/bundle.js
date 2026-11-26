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
export {
  src_default as default
};
