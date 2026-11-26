globalThis.__sbCompat = "2026-11-18";
__sbSetCompat("2026-11-18");
globalThis.__sbAppName = "d1-example";
const env = {};
globalThis.env = env;
__sbSetEnv(env);
__sbInstallFetch();
__sbInstallBindings(env, {"kv":[],"secrets":[],"d1":["DB"],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
const __sbUserHandlers = (() => {
// src/index.ts
var SCHEMA = "CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)";
var schema;
async function ensureSchema(env) {
  schema ??= env.DB.exec(SCHEMA);
  try {
    await schema;
  } catch (error) {
    schema = undefined;
    throw error;
  }
}
var src_default = {
  async fetch(request, env) {
    await ensureSchema(env);
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { meta } = await env.DB.prepare("INSERT INTO todos (title) VALUES (?)").bind(body.title || "untitled").run();
      return Response.json({ id: meta.last_row_id }, { status: 201 });
    }
    const { results } = await env.DB.prepare("SELECT id, title, done FROM todos ORDER BY id").all();
    return Response.json(results);
  }
};
const __sbHandlers = src_default;

__sbStartLocalTriggers(__sbHandlers, {"kv":[],"secrets":[],"d1":["DB"],"r2":[],"queues":[],"queueConfig":[],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
return __sbHandlers;
})();
export default {
  port: 8080,
  fetch(request) { return __sbEntry(__sbUserHandlers, request); }
};
