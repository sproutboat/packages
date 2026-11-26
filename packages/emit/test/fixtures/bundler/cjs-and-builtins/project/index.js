import legacy from "./lib/legacy.cjs";
import transpiled from "./lib/transpiled.cjs";
import { shout } from "./lib/shout.js";

export const quote = function escape(text) {
  return `"${text}"`;
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/legacy") return Response.json({ answer: legacy.answer, twice: legacy.twice(21) });
    // On Cloudflare and in the CLI the default import is module.exports, even when it sets __esModule.
    if (url.pathname === "/transpiled")
      return Response.json({ kind: typeof transpiled, keys: Object.keys(transpiled).sort(), named: transpiled.named });
    if (url.pathname === "/shout") return new Response(shout("hi"));
    if (url.pathname === "/quote") return new Response(quote("x"));
    return new Response("not found", { status: 404 });
  },
};
