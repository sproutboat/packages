// src/index.ts
var src_default = {
  async fetch(request, env) {
    const [ticks, last] = await Promise.all([env.STATE.get("ticks"), env.STATE.get("last")]);
    return new Response(`${ticks ?? 0} ticks, last at ${last ?? "never"}
`);
  },
  async scheduled(controller, env) {
    const ticks = Number(await env.STATE.get("ticks")) + 1;
    await env.STATE.put("ticks", String(ticks));
    await env.STATE.put("last", new Date(controller.scheduledTime).toISOString());
  }
};
export {
  src_default as default
};
