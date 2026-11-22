// A Durable Object whose constructor returns a Proxy (the shape of Alchemy's Durable Object bridge): every name the class does not
// define is answered through the get trap. A stub call `stub.hit()` must reach it, as it does in workerd.
export class Counter {
  constructor(state) {
    this.state = state;
    const methods = { hit: async () => (this.n = (this.n ?? 0) + 1), echo: async (v) => v };
    return new Proxy(this, {
      get: (target, name) => (name in target || !(name in methods) ? target[name] : methods[name]),
    });
  }
  declared() {
    return "declared";
  }
}

export default {
  async fetch(request, env) {
    const stub = env.COUNTER.getByName("a");
    const path = new URL(request.url).pathname;
    try {
      if (path === "/hit") return Response.json({ n: await stub.hit() });
      if (path === "/echo") return Response.json({ v: await stub.echo("x") });
      if (path === "/declared") return Response.json({ v: await stub.declared() });
      if (path === "/pair") {
        const [client, server] = new WebSocketPair();
        return Response.json({
          same: client !== server,
          values: Object.values(new WebSocketPair()).length,
          spread: [...new WebSocketPair()].length,
        });
      }
      if (path === "/missing") return Response.json({ v: await stub.nope() });
    } catch (error) {
      return Response.json({ error: String(error && error.message) }, { status: 500 });
    }
    return new Response("ok");
  },
};
