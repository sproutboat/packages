var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);

// sb-module:lib/legacy.cjs
var require_legacy = __commonJS(function(exports, module) {
  var answer = 42;
  module.exports = { answer, twice: (n) => n * 2 };
});

// sb-module:index.js
var import_legacy = __toESM(require_legacy());

// sb-module:lib/shout.js
var shout = function parseInt_sb(text) {
  return text.toUpperCase() + "!";
};

// sb-module:index.js
var quote = function escape_sb(text) {
  return `"${text}"`;
};
var index_default = {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/legacy")
      return Response.json({ answer: import_legacy.default.answer, twice: import_legacy.default.twice(21) });
    if (url.pathname === "/shout")
      return new Response(shout("hi"));
    if (url.pathname === "/quote")
      return new Response(quote("x"));
    return new Response("not found", { status: 404 });
  }
};
export {
  index_default as default,
  quote
};
