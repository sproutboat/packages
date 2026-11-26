import { greet } from "./lib/greet.js";
import * as math from "./lib/math.js";
import config from "./data/config.js";
import { Counter } from "./lib/counter.js";

export { Counter };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/greet") return new Response(greet(env.NAME ?? "world"));
    if (url.pathname === "/math") return Response.json({ sum: math.sum(1, 2, 3), scaled: math.scale(4), pi2: math.PI2 });
    if (url.pathname === "/config") return Response.json(config);
    if (url.pathname === "/counter") return new Response(String(new Counter().next().next().value));
    return new Response("not found", { status: 404 });
  },
};
