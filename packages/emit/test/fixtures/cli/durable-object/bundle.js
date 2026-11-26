// src/index.ts
import { DurableObject } from "cloudflare:workers";

class Counter extends DurableObject {
  async increment() {
    const n = (await this.ctx.storage.get("n") ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    return n;
  }
  async alarm() {
    console.log("counter settled at", await this.ctx.storage.get("n"));
  }
}
var src_default = {
  async fetch(request, env) {
    const name = new URL(request.url).pathname.slice(1) || "default";
    const counter = env.COUNTERS.getByName(name);
    return new Response(`${name}: ${await counter.increment()}
`);
  }
};
export {
  Counter,
  src_default as default
};
