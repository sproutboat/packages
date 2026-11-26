globalThis.__sbCompat = "2026-11-23";
__sbSetCompat("2026-11-23");
globalThis.__sbAppName = "hello";
const env = {"GREETING":"Hello"};
globalThis.env = env;
__sbSetEnv(env);
env["VERSION"] = {"id":"04bfdc275fc620755","tag":"hello","timestamp":"2026-11-26T09:16:37.659Z"};
__sbInstallFetch();
const __sbUserHandlers = (() => {
// src/index.ts
var src_default = {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("name") ?? "world";
    return new Response(`${env.GREETING}, ${name}!
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
