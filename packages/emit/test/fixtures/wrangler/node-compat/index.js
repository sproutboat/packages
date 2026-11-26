var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
import { Buffer as Buffer2 } from "node:buffer";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { DurableObject } from "cloudflare:workers";
var Counter = class extends DurableObject {
  static {
    __name(this, "Counter");
  }
  async hit() {
    return 1;
  }
};
var index_default = {
  async fetch(request, env) {
    const digest = createHash("sha256").update("x").digest("hex");
    const em = new EventEmitter();
    return new Response(Buffer2.from(digest).length + em.listenerCount("x") + import.meta.url);
  }
};
export {
  Counter,
  index_default as default
};
//# sourceMappingURL=index.js.map
