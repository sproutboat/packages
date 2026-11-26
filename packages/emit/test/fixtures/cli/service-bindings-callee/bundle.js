// src/index.ts
var src_default = {
  async fetch(request) {
    const name = new URL(request.url).searchParams.get("name") ?? "there";
    return new Response(`hello, ${name}, from the callee
`);
  }
};
export {
  src_default as default
};
