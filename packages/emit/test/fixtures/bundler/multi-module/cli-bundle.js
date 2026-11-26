// data/config.js
var config_default = { greeting: "hello", factor: 3, tags: ["a", "b"] };

// lib/greet.js
var greet = (name) => `${config_default.greeting}, ${name}!`;

// lib/math.js
function sum(...values) {
  return values.reduce((total, value) => total + value, 0);
}
var scale = (value) => value * config_default.factor;
var PI2 = Math.PI * 2;

// lib/counter.js
class Counter {
  value = 0;
  next() {
    this.value += 1;
    return this;
  }
}

// index.js
var project_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/greet")
      return new Response(greet(env.NAME ?? "world"));
    if (url.pathname === "/math")
      return Response.json({ sum: sum(1, 2, 3), scaled: scale(4), pi2: PI2 });
    if (url.pathname === "/config")
      return Response.json(config_default);
    if (url.pathname === "/counter")
      return new Response(String(new Counter().next().next().value));
    return new Response("not found", { status: 404 });
  }
};
export {
  Counter,
  project_default as default
};
