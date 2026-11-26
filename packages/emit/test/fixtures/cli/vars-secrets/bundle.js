// src/index.ts
var src_default = {
  async fetch(request, env) {
    return new Response(`${env.GREETING}, your key ends in ...${env.API_KEY.slice(-4)}
`);
  }
};
export {
  src_default as default
};
