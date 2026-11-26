globalThis.__sbCompat = "2026-11-18";
__sbSetCompat("2026-11-18");
globalThis.__sbAppName = "assets";
globalThis.__sbAssets = {"manifest":{"notFound":"none","runSproutFirst":["/api/*"],"files":{"/index.html":{"hash":"2d99ce58cef623463d9d361b79c65d45bc4a8d29be9d84ed2c8a979bd2febddb","size":310,"type":"text/html; charset=utf-8"}}},"files":{"/index.html":"<!doctype html>\n<meta charset=\"utf-8\" />\n<title>assets</title>\n<h1>Served from public/</h1>\n<p>The clock below comes from the handler, not a file.</p>\n<pre id=\"t\">â¦</pre>\n<script>\n  fetch(\"/api/time\")\n    .then((r) => r.json())\n    .then((d) => (document.getElementById(\"t\").textContent = d.now));\n</script>\n"}};
const env = {};
globalThis.env = env;
__sbSetEnv(env);
__sbInstallFetch();
__sbInstallBindings(env, {"kv":[],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"ASSETS","vars":{},"resources":{}});
const __sbUserHandlers = (() => {
// src/index.ts
var src_default = {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api/time") {
      return Response.json({ now: new Date().toISOString() });
    }
    return env.ASSETS.fetch(request);
  }
};
const __sbHandlers = src_default;

__sbStartLocalTriggers(__sbHandlers, {"kv":[],"secrets":[],"d1":[],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"ASSETS","vars":{},"resources":{}});
return __sbHandlers;
})();
export default {
  port: 8080,
  fetch(request) { return __sbEntry(__sbUserHandlers, request); }
};
