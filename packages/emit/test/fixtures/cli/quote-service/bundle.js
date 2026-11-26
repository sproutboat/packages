// src/index.ts
import { WorkerEntrypoint } from "cloudflare:workers";
var QUOTES = [
  { content: "Simplicity is prerequisite for reliability.", author: "Edsger Dijkstra" },
  { content: "Make it work, make it right, make it fast.", author: "Kent Beck" },
  { content: "Programs must be written for people to read.", author: "Harold Abelson" }
];
var pick = () => QUOTES[Math.floor(Math.random() * QUOTES.length)];

class QuoteService extends WorkerEntrypoint {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/random")
      return Response.json(pick());
    if (pathname === "/") {
      return Response.json({
        service: "quote-service",
        about: "A small sproutboat app that kitchen-sink calls through a service binding.",
        routes: { "/random": "a quote as JSON: { content, author }" },
        rpc: "env.PEER.random() from a service binding",
        try: "/random"
      });
    }
    return Response.json({ error: "not found", path: pathname }, { status: 404 });
  }
  async random() {
    return pick();
  }
}
export {
  QuoteService as default
};
