// src/index.ts
var src_default = {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("name") ?? "world";
    return new Response(`${env.GREETING}, ${name}!
`);
  }
};
export {
  src_default as default
};
