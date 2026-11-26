globalThis.__sbCompat = "2026-11-18";
__sbSetCompat("2026-11-18");
globalThis.__sbAppName = "service-bindings-callee";
const env = {};
globalThis.env = env;
__sbSetEnv(env);
__sbInstallFetch();
const __sbUserHandlers = (() => {
// src/index.ts
var src_default = {
  async fetch(request) {
    const name = new URL(request.url).searchParams.get("name") ?? "there";
    return new Response(`hello, ${name}, from the callee
`);
  }
};
const __sbHandlers = src_default;

return __sbHandlers;
})();
export default {
  port: 8080,
  fetch(request) { return __sbEntry(__sbUserHandlers, request); }
};
