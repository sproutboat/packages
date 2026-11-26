globalThis.__sbCompat = "2026-11-18";
__sbSetCompat("2026-11-18");
globalThis.__sbAppName = "queue";
const env = {};
globalThis.env = env;
__sbSetEnv(env);
__sbInstallFetch();
__sbInstallBindings(env, {"kv":[],"secrets":[],"d1":["DB"],"r2":[],"queues":["JOBS"],"queueConfig":[{"binding":"JOBS","queue":"JOBS"}],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
const __sbUserHandlers = (() => {
// src/index.ts
var SCHEMA = "CREATE TABLE IF NOT EXISTS sent (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, at TEXT NOT NULL)";
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
      const job = await request.json();
      await env.JOBS.send(job);
      return new Response(`queued
`, { status: 202 });
    }
    const { results } = await env.DB.prepare("SELECT * FROM sent ORDER BY id").all();
    return Response.json(results);
  },
  async queue(batch, env) {
    await ensureSchema(env);
    for (const message of batch.messages) {
      await env.DB.prepare("INSERT INTO sent (email, at) VALUES (?, ?)").bind(message.body.email, new Date().toISOString()).run();
      message.ack();
    }
  }
};
const __sbHandlers = src_default;

__sbStartLocalTriggers(__sbHandlers, {"kv":[],"secrets":[],"d1":["DB"],"r2":[],"queues":["JOBS"],"queueConfig":[{"binding":"JOBS","queue":"JOBS"}],"analytics":[],"do":[],"services":[],"crons":[],"ratelimiters":[],"assets":"","vars":{},"resources":{}});
return __sbHandlers;
})();
export default {
  port: 8080,
  fetch(request) { return __sbEntry(__sbUserHandlers, request); }
};
