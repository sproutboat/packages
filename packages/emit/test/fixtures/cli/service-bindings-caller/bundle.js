// src/index.ts
var src_default = {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("name") ?? "there";
    return env.GREETER.fetch(new Request(`https://internal/?name=${encodeURIComponent(name)}`));
  }
};
export {
  src_default as default
};
