// src/index.js
import { DurableObject } from "cloudflare:workers";
var CHAT = {
  frame: 4096,
  text: 1000,
  name: 20,
  perSecond: 3,
  perTenSeconds: 12,
  perAddress: 5,
  room: 60,
  strikes: 8
};
var HISTORY = 30;
var HISTORY_BYTES = 96 * 1024;

class ChatRoom extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/reset" && request.method === "POST") {
      await this.ctx.storage.delete("history");
      this.broadcast({ type: "history", messages: [] });
      return new Response("cleared");
    }
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= CHAT.room)
      return refusal(503, "the room is full: " + CHAT.room + " connections");
    const who = clientIp(request);
    if (who.known) {
      let mine = 0;
      for (const ws of sockets) {
        const at = ws.deserializeAttachment();
        if (at && at.ip === who.ip)
          mine++;
      }
      if (mine >= CHAT.perAddress) {
        return refusal(429, "too many open connections from your address: " + CHAT.perAddress + " at most");
      }
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair;
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ name: "", ip: who.known ? who.ip : "", t1: 0, n1: 0, t10: 0, n10: 0, strikes: 0 });
    const history = await this.ctx.storage.get("history") || [];
    pair[1].send(JSON.stringify({ type: "history", messages: history }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  presence() {
    const names = [];
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const who = ws.deserializeAttachment();
      if (who && who.name && names.length < 20)
        names.push(who.name);
    }
    return { type: "presence", n: sockets.length, names };
  }
  broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {}
    }
  }
  throttle(ws, who, now) {
    if (now - who.t1 >= 1000) {
      who.t1 = now;
      who.n1 = 0;
    }
    if (now - who.t10 >= 1e4) {
      who.t10 = now;
      who.n10 = 0;
    }
    who.n1++;
    who.n10++;
    let wait = 0;
    if (who.n1 > CHAT.perSecond)
      wait = 1;
    if (who.n10 > CHAT.perTenSeconds)
      wait = Math.max(wait, Math.ceil((who.t10 + 1e4 - now) / 1000));
    if (wait)
      who.strikes++;
    ws.serializeAttachment(who);
    return wait;
  }
  async webSocketMessage(ws, message) {
    const started = clock();
    const who = ws.deserializeAttachment() || { name: "", ip: "", t1: 0, n1: 0, t10: 0, n10: 0, strikes: 0 };
    const wait = this.throttle(ws, who, started);
    if (wait) {
      if (who.strikes >= CHAT.strikes) {
        ws.close(4008, "slow down");
        return;
      }
      ws.send(JSON.stringify({
        type: "error",
        code: "rate_limited",
        error: "slow down: " + CHAT.perSecond + " messages a second, " + CHAT.perTenSeconds + " every 10 s",
        retry_after: wait
      }));
      return;
    }
    const raw = String(message);
    if (raw.length > CHAT.frame || utf8Bytes(raw) > CHAT.frame) {
      ws.send(JSON.stringify({
        type: "error",
        code: "too_large",
        error: "that frame is too large: " + CHAT.frame + " bytes at most"
      }));
      return;
    }
    let frame = null;
    try {
      frame = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "bad_frame", error: "frames are JSON objects" }));
      return;
    }
    if (!isObject(frame)) {
      ws.send(JSON.stringify({ type: "error", code: "bad_frame", error: "frames are JSON objects" }));
      return;
    }
    if (frame.type === "hello") {
      const name = tidy(isText(frame.name) ? frame.name : "");
      who.name = name.length > 0 && name.length <= CHAT.name ? name : "guest";
      ws.serializeAttachment(who);
      this.broadcast(this.presence());
      return;
    }
    if (frame.type !== "msg")
      return;
    if (!isText(frame.text)) {
      ws.send(JSON.stringify({ type: "error", code: "bad_frame", error: "text must be a string" }));
      return;
    }
    const text = tidy(frame.text, true);
    if (!text)
      return;
    if (points(text) > CHAT.text) {
      ws.send(JSON.stringify({
        type: "error",
        code: "too_long",
        error: "that message is too long: " + CHAT.text + " characters at most"
      }));
      return;
    }
    const entry = { name: who.name || "guest", text, at: Date.now() };
    const history = await this.ctx.storage.get("history") || [];
    history.push(entry);
    while (history.length > HISTORY)
      history.shift();
    while (history.length > 1 && new TextEncoder().encode(JSON.stringify(history)).length > HISTORY_BYTES) {
      history.shift();
    }
    await this.ctx.storage.put("history", history);
    const sent = isNumber(frame.sent) ? frame.sent : 0;
    this.broadcast({
      type: "msg",
      name: entry.name,
      text,
      at: entry.at,
      sent,
      ms: clock() - started
    });
  }
  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {}
    this.broadcast(this.presence());
  }
}
function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "content-type": "application/json" } });
}
function isText(v) {
  return String(v) === v;
}
function isNumber(v) {
  return Number(v) === v && isFinite(v);
}
function isObject(v) {
  return v !== null && Object(v) === v && !Array.isArray(v);
}
function whole(text) {
  const n = Number(text);
  return text !== null && text !== "" && n >= 0 && n === Math.floor(n) && n <= 9007199254740991 ? n : null;
}
function isHex(text, length) {
  if (text.length !== length)
    return false;
  for (let i = 0;i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!(c >= 48 && c <= 57 || c >= 97 && c <= 102))
      return false;
  }
  return true;
}
function refusal(status, message, extra) {
  const body = { error: message };
  if (extra)
    for (const k of Object.keys(extra))
      body[k] = extra[k];
  return json(body, status);
}
var DAILY_RESET = "0 4 * * *";
var FILE_SWEEP = "*/15 * * * *";
var DAY_STARTS = 4 * 3600000;
var MAX_FILE_NAME = 64;
var MAX_FILES = 50;
var MAX_JSON_BODY = 4096;
var CHUNK = 1048576;
var HOUR = 3600000;
var DAY = 86400000;
function joint(gap, breaks) {
  return breaks > 1 ? `

` : breaks === 1 ? `
` : gap ? " " : "";
}
function tidy(input, lines) {
  let out = "";
  let gap = false;
  let breaks = 0;
  const text = String(input);
  for (let i = 0;i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 55296 && c <= 56319) {
      const d = text.charCodeAt(i + 1);
      if (d >= 56320 && d <= 57343) {
        if (out)
          out += joint(gap, breaks);
        gap = false;
        breaks = 0;
        out += text[i] + text[i + 1];
        i++;
      }
      continue;
    }
    if (c >= 56320 && c <= 57343)
      continue;
    if (c >= 8234 && c <= 8238 || c >= 8294 && c <= 8297 || c === 65279)
      continue;
    if (lines && (c === 10 || c === 8232 || c === 8233)) {
      breaks++;
      continue;
    }
    if (c <= 32 || c >= 127 && c <= 160 || c === 8232 || c === 8233) {
      gap = true;
      continue;
    }
    if (out)
      out += joint(gap, breaks);
    gap = false;
    breaks = 0;
    out += text[i];
  }
  return out;
}
function points(text) {
  let n = 0;
  for (let i = 0;i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 56320 || c > 57343)
      n++;
  }
  return n;
}
function utf8Bytes(text) {
  let n = 0;
  for (let i = 0;i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128)
      n += 1;
    else if (c < 2048)
      n += 2;
    else if (c >= 55296 && c <= 56319 && i + 1 < text.length && text.charCodeAt(i + 1) >= 56320 && text.charCodeAt(i + 1) <= 57343) {
      n += 4;
      i++;
    } else
      n += 3;
  }
  return n;
}
function textField(input, key, label, max, required) {
  const raw = input[key];
  if (raw === undefined || raw === null || raw === "") {
    return required ? { error: label + " is required" } : { value: "" };
  }
  if (!isText(raw))
    return { error: label + " must be text" };
  const value = tidy(raw);
  if (!value)
    return required ? { error: label + " is required" } : { value: "" };
  if (value.length > max) {
    return { error: label + " is too long: at most " + max + " characters, this has " + value.length };
  }
  return { value };
}
async function readJson(request, max) {
  let text = "";
  try {
    text = request.body ? await request.text() : "";
  } catch {
    return { error: "the body could not be read", status: 400 };
  }
  if (text.length > max)
    return { error: "the body is too large: " + max + " characters at most", status: 413 };
  if (!text)
    return { value: {} };
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "the body is not valid JSON", status: 400 };
  }
  if (!isObject(value)) {
    return { error: "the body must be a JSON object", status: 400 };
  }
  return { value };
}
function privateAddress(ip) {
  if (!ip)
    return true;
  const lower = ip.toLowerCase();
  if (lower.indexOf(":") >= 0) {
    if (lower.indexOf("::ffff:") === 0)
      return privateAddress(lower.slice(7));
    return lower === "::1" || lower === "::" || lower.indexOf("fc") === 0 || lower.indexOf("fd") === 0 || lower.indexOf("fe80") === 0;
  }
  const p = lower.split(".");
  const a = Number(p[0]);
  const b = Number(p[1]);
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
}
function addressKey(ip) {
  if (ip.indexOf(":") < 0)
    return ip;
  const halves = ip.toLowerCase().split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const groups = head;
  if (halves.length > 1) {
    for (let i = head.length + tail.length;i < 8; i++)
      groups.push("0");
    for (const g of tail)
      groups.push(g);
  }
  return groups.slice(0, 4).join(":") + "::/64";
}
function validAddress(text) {
  if (!text || text.length > 45)
    return false;
  for (let i = 0;i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ok = c >= 48 && c <= 58 || c >= 97 && c <= 102 || c >= 65 && c <= 70 || c === 46;
    if (!ok)
      return false;
  }
  return true;
}
function clientIp(request) {
  const peer = request.cf && request.cf.clientIp || "";
  if (peer && !privateAddress(peer))
    return { ip: addressKey(peer), known: true, via: "peer" };
  const fwd = request.headers.get("x-forwarded-for") || "";
  if (fwd) {
    const parts = fwd.split(",");
    const last = parts[parts.length - 1].trim();
    if (validAddress(last))
      return { ip: addressKey(last), known: true, via: "x-forwarded-for" };
  }
  return { ip: "shared", known: false, via: peer ? "peer-private" : "none" };
}
function limited(retry, t0) {
  const body = {
    error: "slow down: too many requests from your address. Try again in " + retry + " s.",
    code: "rate_limited",
    retry_after: retry
  };
  const headers = { "content-type": "application/json", "retry-after": String(retry), "cache-control": "no-store" };
  if (t0 !== undefined) {
    body.ms = Date.now() - t0;
    headers["server-timing"] = "app;dur=" + body.ms;
  }
  return new Response(JSON.stringify(body), { status: 429, headers });
}
async function gate(limiter, prefix, request, t0) {
  if (!limiter)
    return null;
  const r = await limiter.limit({ key: prefix + clientIp(request).ip });
  if (r.success)
    return null;
  let retry = Math.ceil((Number(r.resetAt) - Date.now()) / 1000);
  if (!(retry >= 1))
    retry = 1;
  if (retry > 60)
    retry = 60;
  return limited(retry, t0);
}
function totalCap(env) {
  return Number(env.MAX_TOTAL_BYTES) || 209715200;
}
function uploadCap(env) {
  return Number(env.MAX_UPLOAD_BYTES) || 26214400;
}
function responseCap(env) {
  return Number(env.MAX_RESPONSE_BYTES) || 2097152;
}
function hourlyCap(env, kind) {
  return kind === "up" ? Number(env.MAX_UPLOAD_PER_HOUR) || 104857600 : Number(env.MAX_DOWNLOAD_PER_HOUR) || 262144000;
}
function dailyCap(env) {
  return Number(env.MAX_UPLOAD_PER_DAY) || 104857600;
}
function fileTtl(env) {
  const seconds = Number(env.FILE_TTL_SECONDS);
  return (seconds > 0 ? seconds : 3600) * 1000;
}
function allowanceDay(now) {
  return Math.floor((now - DAY_STARTS) / DAY);
}
function waitText(seconds) {
  return seconds >= 5400 ? Math.ceil(seconds / 3600) + " h" : Math.ceil(seconds / 60) + " min";
}
async function spendBytes(env, request, kind, bytes, t0) {
  const now = Date.now();
  const who = clientIp(request).ip;
  const hour = Math.floor(now / HOUR);
  const windows = [
    {
      name: "hour",
      key: kind + ":" + who + ":" + hour,
      limit: hourlyCap(env, kind),
      ends: (hour + 1) * HOUR,
      keep: (hour + 2) * HOUR
    }
  ];
  if (kind === "up") {
    const day = allowanceDay(now);
    windows.push({
      name: "day",
      key: "upday:" + who + ":" + day,
      limit: dailyCap(env),
      ends: (day + 1) * DAY + DAY_STARTS,
      keep: (day + 2) * DAY + DAY_STARTS
    });
  }
  const used = [];
  for (let i = 0;i < windows.length; i++) {
    const w = windows[i];
    const row = await env.DB.prepare("SELECT bytes FROM quota WHERE key = ?").bind(w.key).first();
    used.push(row ? Number(row.bytes) : 0);
    if (used[i] + bytes > w.limit) {
      let retry = Math.ceil((w.ends - now) / 1000);
      if (!(retry >= 1))
        retry = 1;
      const body = {
        error: "slow down: " + (kind === "up" ? "uploads" : "downloads") + " are limited to " + fmtKb(w.limit) + (w.name === "day" ? " a day" : " an hour") + " from your address. Try again in " + waitText(retry) + ".",
        code: "quota",
        window: w.name,
        retry_after: retry,
        limit: w.limit,
        used: used[i]
      };
      if (t0 !== undefined)
        body.ms = Date.now() - t0;
      return new Response(JSON.stringify(body), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(retry), "cache-control": "no-store" }
      });
    }
  }
  for (let i = 0;i < windows.length; i++) {
    await env.DB.prepare("INSERT INTO quota (key, bytes, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET bytes = bytes + excluded.bytes").bind(windows[i].key, bytes, windows[i].keep).run();
  }
  return null;
}
async function bucketUsage(env, replacing) {
  const listed = await env.UPLOADS.list({ limit: 1000 });
  let bytes = 0;
  let files = 0;
  let replaced = 0;
  let exists = false;
  for (const o of listed.objects) {
    bytes += o.size;
    if (o.key.indexOf("files/") === 0)
      files++;
    if (replacing && o.key === replacing) {
      replaced = o.size;
      exists = true;
    }
  }
  return { bytes, files, replaced, exists, truncated: listed.truncated };
}
function fmtKb(n) {
  return n < 1048576 ? Math.round(n / 1024) + " KB" : Math.round(n / 1048576 * 10) / 10 + " MB";
}
var schema;
async function ensureSchema(env) {
  schema ??= (async () => {
    await env.DB.exec("CREATE TABLE IF NOT EXISTS guestbook (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, msg TEXT, at TEXT);" + "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, label TEXT, ms REAL, at TEXT);" + "CREATE TABLE IF NOT EXISTS quota (key TEXT PRIMARY KEY, bytes INTEGER, expires INTEGER);" + "CREATE TABLE IF NOT EXISTS stats (name TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    await seedRequestCount(env);
  })();
  try {
    await schema;
  } catch (error) {
    schema = undefined;
    throw error;
  }
}
async function seedRequestCount(env) {
  const have = await env.DB.prepare("SELECT n FROM stats WHERE name = 'requests'").first("n");
  if (have !== null && have !== undefined)
    return;
  let n = 0;
  try {
    n = Number((await env.METRICS.query({ limit: 1 })).count) || 0;
  } catch {}
  await env.DB.prepare("INSERT OR IGNORE INTO stats (name, n) VALUES ('requests', ?)").bind(n).run();
}
async function countRequest(env) {
  try {
    await env.DB.prepare("UPDATE stats SET n = n + 1 WHERE name = 'requests'").run();
  } catch {}
}
async function requestCount(env) {
  try {
    const n = await env.DB.prepare("SELECT n FROM stats WHERE name = 'requests'").first("n");
    return n === null || n === undefined ? null : Number(n);
  } catch {
    return null;
  }
}
async function kvKeys(env) {
  const { keys } = await env.SESSIONS.list();
  return keys.map((key) => key.name);
}
function clock() {
  return Date.now();
}
var ms2 = (t0) => Math.round((clock() - t0) * 100) / 100;
function timed(data, status, t0) {
  const ms = ms2(t0);
  data.ms = ms;
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", "server-timing": "app;dur=" + ms, "cache-control": "no-store" }
  });
}
async function kvIncrement(env) {
  const ops = [];
  let t = clock();
  const before = Number(await env.SESSIONS.get("counter:home") || 0);
  ops.push({ op: "GET", value: before, ms: ms2(t) });
  t = clock();
  await env.SESSIONS.put("counter:home", String(before + 1));
  ops.push({ op: "PUT", value: before + 1, ms: ms2(t) });
  return { n: before + 1, ops };
}
async function guestbookSign(env, name, msg) {
  const statements = [];
  const at = new Date().toISOString();
  const insert = "INSERT INTO guestbook (name, msg, at) VALUES (?, ?, ?)";
  let t = clock();
  await env.DB.prepare(insert).bind(name, msg, at).run();
  statements.push({ sql: insert, binds: [name, msg, at], ms: ms2(t) });
  const trim = "DELETE FROM guestbook WHERE id <= (SELECT max(id) FROM guestbook) - 200";
  t = clock();
  await env.DB.prepare(trim).run();
  statements.push({ sql: trim, binds: [], ms: ms2(t) });
  return statements;
}
async function guestbookList(env) {
  const sql = "SELECT id, name, msg, at FROM guestbook ORDER BY id DESC LIMIT 5";
  const t = clock();
  const res = await env.DB.prepare(sql).all();
  return { rows: res.results, statement: { sql, binds: [], ms: ms2(t), rows_read: res.meta.rows_read } };
}
var SHOWN_INLINE = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav"
];
function cleanType(raw) {
  const head = String(raw || "").split(";")[0].trim().toLowerCase();
  const parts = head.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1] || head.length > 100)
    return "application/octet-stream";
  for (let i = 0;i < head.length; i++) {
    const c = head.charCodeAt(i);
    const ok = c >= 97 && c <= 122 || c >= 48 && c <= 57 || "!#$&^_.+-/".indexOf(head[i]) >= 0;
    if (!ok)
      return "application/octet-stream";
  }
  return head;
}
function chunkKey(id, n) {
  return "chunks/" + id + "/" + String(1e6 + n).slice(1);
}
function describe(key, o) {
  const m = o.customMetadata || {};
  return {
    name: key.slice(6),
    size: m.size === undefined ? o.size : Number(m.size),
    type: cleanType(m.type || o.httpMetadata && o.httpMetadata.contentType),
    id: m.id || "",
    count: Number(m.count) || 0,
    etag: m.id || o.httpEtag,
    expires: Number(m.expires) || 0
  };
}
async function purgeExpired(env, now) {
  const listed = await env.UPLOADS.list({ prefix: "files/", limit: 1000, include: ["httpMetadata", "customMetadata"] });
  let purged = 0;
  for (const o of listed.objects) {
    const d = describe(o.key, o);
    if (d.expires > now)
      continue;
    await removeFile(env, d);
    purged++;
  }
  return purged;
}
async function filesList(env) {
  const now = Date.now();
  const listed = await env.UPLOADS.list({ prefix: "files/", limit: 100, include: ["httpMetadata", "customMetadata"] });
  let bytes = 0;
  const objects = [];
  for (const o of listed.objects) {
    const d = describe(o.key, o);
    if (d.expires <= now) {
      await removeFile(env, d);
      continue;
    }
    bytes += d.size;
    objects.push({ name: d.name, size: d.size, type: d.type, uploaded: o.uploaded, etag: d.etag, expires: d.expires });
  }
  return { objects, bytes, truncated: listed.truncated, now };
}
async function fileInfo(env, name) {
  const head = await env.UPLOADS.head("files/" + name);
  if (!head)
    return null;
  const d = describe("files/" + name, head);
  if (d.expires <= Date.now()) {
    await removeFile(env, d);
    return null;
  }
  return d;
}
async function removeFile(env, info) {
  const keys = ["files/" + info.name];
  for (let n = 0;n < info.count; n++)
    keys.push(chunkKey(info.id, n));
  await env.UPLOADS.delete(keys);
}
async function chunkPut(env, request, up, bytes, t0) {
  const key = chunkKey(up.id, up.n);
  if (up.n === 0) {
    await purgeExpired(env, Date.now());
    const old = await fileInfo(env, up.name);
    const used = await bucketUsage(env, "");
    if (!old && used.files >= MAX_FILES) {
      return { status: 409, error: "the demo bucket holds " + MAX_FILES + " files; delete one first" };
    }
    if (used.truncated || used.bytes - (old ? old.size : 0) + up.total > totalCap(env)) {
      return {
        status: 409,
        error: "the demo bucket is full: " + fmtKb(used.bytes) + " of " + fmtKb(totalCap(env)) + " stored; delete a file first"
      };
    }
    const spent = await spendBytes(env, request, "up", up.total, t0);
    if (spent)
      return { response: spent };
  } else {
    const first = await env.UPLOADS.head(chunkKey(up.id, 0));
    const m = first && first.customMetadata ? first.customMetadata : {};
    if (!first || m.total !== String(up.total) || m.name !== up.name) {
      return { status: 409, error: "start the upload with chunk 0" };
    }
  }
  await env.UPLOADS.put(key, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { total: String(up.total), name: up.name, t: String(Date.now()) }
  });
  if (up.n < up.count - 1)
    return null;
  const listed = await env.UPLOADS.list({ prefix: "chunks/" + up.id + "/", limit: 1000 });
  let sum = 0;
  for (const o of listed.objects)
    sum += o.size;
  if (listed.objects.length !== up.count || sum !== up.total) {
    return { status: 409, error: "the upload is missing chunks; start it again" };
  }
  const old = await fileInfo(env, up.name);
  await env.UPLOADS.put("files/" + up.name, "", {
    httpMetadata: { contentType: up.type },
    customMetadata: {
      id: up.id,
      size: String(up.total),
      count: String(up.count),
      type: up.type,
      expires: String(Date.now() + fileTtl(env))
    }
  });
  if (old && old.id && old.id !== up.id)
    await env.UPLOADS.delete(chunkKeys(old.id, old.count));
  return null;
}
function chunkKeys(id, count) {
  const keys = [];
  for (let n = 0;n < count; n++)
    keys.push(chunkKey(id, n));
  return keys;
}
async function sweepChunks(env) {
  const listed = await env.UPLOADS.list({ prefix: "chunks/", limit: 1000, include: ["customMetadata"] });
  if (!listed.objects.length)
    return;
  const manifests = await env.UPLOADS.list({ prefix: "files/", limit: 1000, include: ["customMetadata"] });
  const live = {};
  for (const o of manifests.objects)
    if (o.customMetadata && o.customMetadata.id)
      live[o.customMetadata.id] = true;
  const stale = [];
  for (const o of listed.objects) {
    const id = o.key.split("/")[1];
    const t = Number(o.customMetadata && o.customMetadata.t) || 0;
    if (!live[id] && Date.now() - t > HOUR)
      stale.push(o.key);
  }
  if (stale.length)
    await env.UPLOADS.delete(stale);
}
function parseRange(header, size) {
  const h = String(header || "").trim();
  if (h.indexOf("bytes=") !== 0 || h.indexOf(",") >= 0)
    return null;
  const parts = h.slice(6).split("-");
  if (parts.length !== 2)
    return null;
  const left = parts[0].trim();
  const right = parts[1].trim();
  if (!left && !right)
    return null;
  let start = 0;
  let end = size - 1;
  if (!left) {
    const n = Number(right);
    if (!(n > 0))
      return { bad: true };
    start = Math.max(0, size - n);
  } else {
    start = Number(left);
    if (!(start >= 0) || start !== Math.floor(start))
      return null;
    if (right) {
      end = Number(right);
      if (!(end >= 0) || end !== Math.floor(end) || end < start)
        return null;
      end = Math.min(end, size - 1);
    }
    if (start >= size)
      return { bad: true };
  }
  return { start, end };
}
function chunkStream(env, info, start, end) {
  let at = start;
  return new ReadableStream({
    async pull(controller) {
      if (at > end) {
        controller.close();
        return;
      }
      const n = Math.floor(at / CHUNK);
      const obj = await env.UPLOADS.get(chunkKey(info.id, n));
      if (!obj) {
        controller.error(new Error("a chunk of the file is missing"));
        return;
      }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const from = at - n * CHUNK;
      const to = Math.min(bytes.length, end - n * CHUNK + 1);
      controller.enqueue(from === 0 && to === bytes.length ? bytes : bytes.subarray(from, to));
      at = n * CHUNK + to;
    }
  });
}
async function fileResponse(env, request, info, download, t0) {
  const inline = !download && SHOWN_INLINE.indexOf(info.type) >= 0;
  const headers = {
    "content-type": info.type === "text/plain" ? "text/plain; charset=utf-8" : info.type,
    "content-disposition": (inline ? "inline" : "attachment") + '; filename="' + info.name + '"',
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    etag: '"' + info.etag + '"',
    "cache-control": "private, max-age=" + Math.max(0, Math.min(3600, Math.floor((info.expires - Date.now()) / 1000))),
    "server-timing": "app;dur=" + ms2(t0)
  };
  const media = info.type.startsWith("video/") || info.type.startsWith("audio/");
  if (media)
    headers["content-security-policy"] = "default-src 'none'; media-src 'self'";
  else if (info.type !== "application/pdf")
    headers["content-security-policy"] = "default-src 'none'; sandbox";
  const ifRange = request.headers.get("if-range");
  const range = ifRange && ifRange !== headers.etag ? null : parseRange(request.headers.get("range"), info.size);
  if (range && range.bad) {
    headers["content-range"] = "bytes */" + info.size;
    return new Response(null, { status: 416, headers });
  }
  const most = responseCap(env);
  if (!range && info.size > most && request.method !== "HEAD") {
    return new Response(JSON.stringify({
      error: "this file is " + fmtKb(info.size) + ", more than one response sends (" + fmtKb(most) + "): read it with Range requests, as a browser does for video, or download it from the dashboard",
      code: "range_required",
      size: info.size,
      window: most
    }), {
      status: 413,
      headers: { "content-type": "application/json", "accept-ranges": "bytes", "cache-control": "no-store" }
    });
  }
  const start = range ? range.start : 0;
  const end = range ? Math.min(range.end, start + most - 1) : info.size - 1;
  const length = info.size === 0 ? 0 : end - start + 1;
  headers["content-length"] = String(length);
  if (range)
    headers["content-range"] = "bytes " + start + "-" + end + "/" + info.size;
  const status = range ? 206 : 200;
  if (request.method === "HEAD")
    return new Response(null, { status, headers });
  const stop = await spendBytes(env, request, "down", length, t0);
  if (stop)
    return stop;
  if (!info.id) {
    const obj = await env.UPLOADS.get("files/" + info.name);
    return new Response(obj ? await obj.arrayBuffer() : null, { status, headers });
  }
  if (length === 0)
    return new Response(null, { status, headers });
  return new Response(chunkStream(env, info, start, end), { status, headers });
}
async function jobEnqueue(env, label) {
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO events (kind, label, ms, at) VALUES ('queued', ?, 0, ?)").bind(label, at).run();
  await env.EMAILS.send({ kind: "job", label, sent: Date.now() });
}
async function feed(env) {
  const counts = await env.DB.prepare("SELECT sum(kind = 'queued') AS queued, sum(kind = 'processed') AS processed, sum(kind = 'cron') AS crons FROM events").first();
  const recent = await env.DB.prepare("SELECT kind, label, ms, at FROM events WHERE kind IN ('processed', 'cron') ORDER BY id DESC LIMIT 5").all();
  return { counts, recent: recent.results };
}
async function quote(env) {
  const res = await env.PEER.fetch(new Request("https://peer/random"));
  if (res.status !== 200)
    throw new Error("quote-service answered " + res.status);
  return JSON.parse(await res.text());
}
function secretStatus(env, names) {
  const out = [];
  for (const name of names) {
    let set = false;
    try {
      const value = env[name];
      set = !!value && String(value).length > 0;
    } catch {}
    out.push({ name, set });
  }
  return out;
}
var DECLARED_SECRETS = ["ADMIN_TOKEN"];
function cleanFileName(raw) {
  let out = "";
  const text = String(raw || "").trim();
  for (let i = 0;i < text.length && out.length < MAX_FILE_NAME; i++) {
    const code = text.charCodeAt(i);
    const ok = code >= 97 && code <= 122 || code >= 65 && code <= 90 || code >= 48 && code <= 57 || code === 46 || code === 45 || code === 95;
    out += ok ? text[i] : "_";
  }
  return out;
}
async function trimEvents(env) {
  await env.DB.prepare("DELETE FROM events WHERE id <= (SELECT max(id) FROM events) - 200").run();
}
var SEED = [
  ["sproutboat", "Demo data resets daily at 04:00 UTC."],
  ["Ada", "Hello from the guestbook."],
  ["Grace", "Signed from D1."]
];
async function dailyReset(env, event) {
  const started = clock();
  const parts = [
    async () => {
      for (let page = 0;page < 20; page++) {
        const listed = await env.UPLOADS.list({ limit: 100 });
        if (!listed.objects.length)
          break;
        for (const o of listed.objects)
          await env.UPLOADS.delete(o.key);
      }
    },
    async () => {
      const keys = await kvKeys(env);
      for (let i = 0;i < keys.length; i++)
        await env.SESSIONS.delete(keys[i]);
    },
    async () => {
      for (const table of ["guestbook", "events", "quota"]) {
        await env.DB.prepare("DELETE FROM " + table).run();
      }
      const at = new Date().toISOString();
      for (let i = 0;i < SEED.length; i++) {
        await env.DB.prepare("INSERT INTO guestbook (name, msg, at) VALUES (?, ?, ?)").bind(SEED[i][0], SEED[i][1], at).run();
      }
    },
    async () => {
      await env.ROOM.get(env.ROOM.idFromName("main")).fetch("https://room/reset", { method: "POST" });
    }
  ];
  let failed = 0;
  for (let i = 0;i < parts.length; i++) {
    try {
      await parts[i]();
    } catch (e) {
      failed++;
      console.log("daily reset, part " + i + " failed: " + String(e && e.message || e));
    }
  }
  await env.DB.prepare("INSERT INTO events (kind, label, ms, at) VALUES ('cron', ?, ?, ?)").bind(event.cron, ms2(started), new Date().toISOString()).run();
  return failed;
}
async function api(request, env, url, path, t0) {
  const method = request.method;
  const mutating = method !== "GET" && method !== "HEAD";
  let slow = null;
  if (path === "/api/chat")
    slow = await gate(env.WRITES, "ws:", request, t0);
  else if (path === "/api/secrets/check")
    slow = null;
  else if (path === "/api/r2/chunk")
    slow = null;
  else if (mutating || path === "/api/quote")
    slow = await gate(env.WRITES, "w:", request, t0);
  else
    slow = await gate(env.READS, "r:", request, t0);
  if (slow)
    return slow;
  if (path === "/api/info" && method === "GET") {
    const requests = await requestCount(env);
    return timed({
      site: env.SITE_NAME,
      requests,
      bindings: {
        kv: !!env.SESSIONS,
        d1: !!env.DB,
        r2: !!env.UPLOADS,
        queue: !!env.EMAILS,
        durable_object: !!env.ROOM,
        service: !!env.PEER
      },
      max_upload_bytes: uploadCap(env),
      max_total_bytes: totalCap(env),
      chunk_bytes: CHUNK,
      max_response_bytes: responseCap(env),
      max_upload_per_hour: hourlyCap(env, "up"),
      max_upload_per_day: dailyCap(env),
      file_ttl_seconds: fileTtl(env) / 1000,
      max_download_per_hour: hourlyCap(env, "down"),
      max_files: MAX_FILES,
      client_key: clientIp(request).via
    }, 200, t0);
  }
  if (path === "/api/kv") {
    const n = Number(await env.SESSIONS.get("counter:home") || 0);
    return timed({ n, keys: (await kvKeys(env)).length }, 200, t0);
  }
  if (path === "/api/kv/incr" && method === "POST") {
    const res = await kvIncrement(env);
    res.keys = (await kvKeys(env)).length;
    return timed(res, 200, t0);
  }
  if (path === "/api/guestbook" && method === "GET") {
    const list = await guestbookList(env);
    const total = await env.DB.prepare("SELECT count(*) AS n FROM guestbook").first("n");
    return timed({ rows: list.rows, total, sql: [list.statement] }, 200, t0);
  }
  if (path === "/api/guestbook" && method === "POST") {
    const body = await readJson(request, MAX_JSON_BODY);
    if (body.error)
      return timed({ error: body.error }, body.status, t0);
    const name = textField(body.value, "name", "name", 20, true);
    if (name.error)
      return timed({ error: name.error }, 400, t0);
    const msg = textField(body.value, "msg", "message", 60, true);
    if (msg.error)
      return timed({ error: msg.error }, 400, t0);
    const sql = await guestbookSign(env, name.value, msg.value);
    const list = await guestbookList(env);
    const total = await env.DB.prepare("SELECT count(*) AS n FROM guestbook").first("n");
    sql.push(list.statement);
    return timed({ rows: list.rows, total, sql }, 201, t0);
  }
  if (path === "/api/r2" && method === "GET") {
    return timed(await filesList(env), 200, t0);
  }
  if (path === "/api/r2/chunk" && method === "PUT") {
    const heavy = await gate(env.BULK, "b:", request, t0);
    if (heavy)
      return heavy;
    const q = url.searchParams;
    const raw = String(q.get("name") || "").trim();
    if (!raw)
      return timed({ error: "a file name is required" }, 400, t0);
    if (raw.length > MAX_FILE_NAME) {
      return timed({ error: "the file name is too long: at most " + MAX_FILE_NAME + " characters, this has " + raw.length }, 400, t0);
    }
    const name = cleanFileName(raw);
    if (name === "." || name === "..")
      return timed({ error: "that file name is not allowed" }, 400, t0);
    const id = String(q.get("id") || "");
    if (!isHex(id, 16))
      return timed({ error: "id must be 16 hexadecimal characters" }, 400, t0);
    const total = whole(q.get("total"));
    const n = whole(q.get("n"));
    const count = whole(q.get("count"));
    if (total === null || n === null || count === null) {
      return timed({ error: "total, n and count are whole numbers" }, 400, t0);
    }
    if (total > uploadCap(env)) {
      return timed({ error: "too large: this build accepts " + fmtKb(uploadCap(env)) + " per file, this is " + fmtKb(total) }, 413, t0);
    }
    if (count !== Math.max(1, Math.ceil(total / CHUNK)) || n >= count) {
      return timed({ error: "count and n do not fit total: chunks are " + CHUNK + " bytes" }, 400, t0);
    }
    const expected = n < count - 1 ? CHUNK : total - (count - 1) * CHUNK;
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > CHUNK)
      return timed({ error: "a chunk is at most " + CHUNK + " bytes" }, 413, t0);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== expected) {
      return timed({ error: "chunk " + n + " is " + expected + " bytes, this has " + bytes.byteLength }, 400, t0);
    }
    const up = { name, id, n, count, total, type: cleanType(q.get("type")) };
    const refused = await chunkPut(env, request, up, bytes, t0);
    if (refused && refused.response)
      return refused.response;
    if (refused)
      return timed({ error: refused.error }, refused.status, t0);
    const out = n === count - 1 ? await filesList(env) : { stored: n };
    out.name = name;
    return timed(out, n === count - 1 ? 201 : 200, t0);
  }
  if (path === "/api/r2" && method === "DELETE") {
    const name = cleanFileName(url.searchParams.get("name"));
    const info = name ? await fileInfo(env, name) : null;
    if (info)
      await removeFile(env, info);
    return timed(await filesList(env), 200, t0);
  }
  if (path === "/api/r2/file" && (method === "GET" || method === "HEAD")) {
    const name = cleanFileName(url.searchParams.get("name"));
    const info = name ? await fileInfo(env, name) : null;
    if (!info)
      return timed({ error: "not found" }, 404, t0);
    return fileResponse(env, request, info, url.searchParams.get("download") === "1", t0);
  }
  if (path === "/api/queue" && method === "GET") {
    const out = await feed(env);
    out.now = Date.now();
    return timed(out, 200, t0);
  }
  if (path === "/api/queue/enqueue" && method === "POST") {
    const body = await readJson(request, MAX_JSON_BODY);
    if (body.error)
      return timed({ error: body.error }, body.status, t0);
    const field = textField(body.value, "label", "label", 40, false);
    if (field.error)
      return timed({ error: field.error }, 400, t0);
    await jobEnqueue(env, field.value || "hello");
    const out = await feed(env);
    out.now = Date.now();
    return timed(out, 202, t0);
  }
  if (path === "/api/quote" && method === "GET") {
    if (!env.PEER) {
      return timed({ ok: false, reason: "no-binding", error: "this build has no service binding" }, 200, t0);
    }
    try {
      return timed({ ok: true, quote: await quote(env) }, 200, t0);
    } catch (e) {
      return timed({ ok: false, reason: "unreachable", error: String(e && e.message || e) }, 200, t0);
    }
  }
  if (path === "/api/secrets" && method === "GET") {
    return timed({ secrets: secretStatus(env, DECLARED_SECRETS) }, 200, t0);
  }
  if (path === "/api/secrets/check" && method === "POST") {
    const stop = await gate(env.THROTTLE, "secret-check:", request, t0);
    if (stop)
      return stop;
    const body = await readJson(request, 1024);
    if (body.error)
      return timed({ ok: false, error: body.error }, body.status, t0);
    const token = body.value.token;
    if (!isText(token) || !token)
      return timed({ ok: false, error: "token is required" }, 400, t0);
    if (token.length > 256) {
      return timed({ ok: false, error: "token is too long: at most 256 characters, this has " + token.length }, 400, t0);
    }
    let ok = false;
    try {
      ok = !!env.ADMIN_TOKEN && token === String(env.ADMIN_TOKEN);
    } catch {}
    return timed({ ok }, 200, t0);
  }
  if (path === "/api/chat") {
    if (request.headers.get("Upgrade") !== "websocket" && url.searchParams.get("probe") === null)
      return timed({ error: "expected a WebSocket upgrade" }, 426, t0);
    return env.ROOM.get(env.ROOM.idFromName("main")).fetch(request);
  }
  return timed({ error: "not found", path }, 404, t0);
}
function healthz(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "use GET" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "GET, HEAD", "cache-control": "no-store" }
    });
  }
  return new Response(request.method === "HEAD" ? null : JSON.stringify({ ok: true, at: Date.now() }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
var src_default = {
  async fetch(request, env) {
    const t0 = clock();
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/healthz")
      return healthz(request);
    try {
      await ensureSchema(env);
      env.METRICS.writeDataPoint({ blobs: [request.method, path], indexes: [path], doubles: [1] });
      await countRequest(env);
      if (path.indexOf("/api/") === 0)
        return await api(request, env, url, path, t0);
      if (request.method === "GET")
        return await env.ASSETS.fetch(request);
      return json({ error: "not found", path }, 404);
    } catch (e) {
      console.log("500 " + request.method + " " + path + ": " + String(e && e.message || e));
      if (path.indexOf("/api/") === 0)
        return timed({ error: "internal error" }, 500, t0);
      return json({ error: "internal error" }, 500);
    }
  },
  async scheduled(controller, env) {
    const started = clock();
    await ensureSchema(env);
    if (controller.cron === DAILY_RESET) {
      await dailyReset(env, controller);
      return;
    }
    if (controller.cron === FILE_SWEEP) {
      await purgeExpired(env, Number(controller.scheduledTime) || Date.now());
      await sweepChunks(env);
      return;
    }
    await env.DB.prepare("DELETE FROM quota WHERE expires < ?").bind(Date.now()).run();
    await env.DB.prepare("INSERT INTO events (kind, label, ms, at) VALUES ('cron', ?, ?, ?)").bind(controller.cron, ms2(started), new Date().toISOString()).run();
    await trimEvents(env);
  },
  async queue(batch, env) {
    await ensureSchema(env);
    for (const message of batch.messages) {
      const started = clock();
      const job = message.body;
      if (job && job.kind === "job") {
        const waited = Math.max(0, Date.now() - Number(job.sent || 0));
        await env.DB.prepare("INSERT INTO events (kind, label, ms, at) VALUES ('processed', ?, ?, ?)").bind(String(job.label || "job"), waited + ms2(started), new Date().toISOString()).run();
        await trimEvents(env);
      }
      message.ack();
    }
  }
};
export {
  ChatRoom,
  src_default as default
};
