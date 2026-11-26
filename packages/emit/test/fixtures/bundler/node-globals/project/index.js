import { Buffer } from "node:buffer";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe } from "./lib/helper.js";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/buffer") return new Response(Buffer.from("héllo").toString("hex"));
    if (url.pathname === "/path") return new Response(path.join("a", "..", "b", "c.txt"));
    if (url.pathname === "/events") {
      const emitter = new EventEmitter();
      let seen = "";
      emitter.on("x", (value) => (seen += value));
      emitter.emit("x", "1");
      emitter.emit("x", "2");
      return new Response(seen);
    }
    if (url.pathname === "/free") return new Response(describe());
    return new Response("not found", { status: 404 });
  },
};
