globalThis.__sbCompat = "2026-11-23";
__sbSetCompat("2026-11-23");
globalThis.__sbAppName = "hello";
const env = {"GREETING":"Hello"};
globalThis.env = env;
__sbSetEnv(env);
env["VERSION"] = {"id":"ffa89cbf6c9db45f5","tag":"hello","timestamp":"2026-11-27T18:33:13.029Z"};
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
