// ZhiYin server, Worker entry (stateless): routing, CORS, Origin / same-origin checks, the admin page with a CSP nonce,
// and a 30 s isolate cache for /api/config. Everything stateful lives in the Hub Durable Object (hub.ts).
import { Hub, json, type Env } from "./hub";
import { PROTO, originOk } from "./lib";
import ADMIN_HTML from "./admin.html";

export { Hub };

const CONFIG_TTL_MS = 30_000;
const REGISTER_MAX_BYTES = 4096;
let configCache: { at: number; body: string } | null = null;
const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** Forward to the single Hub. The DO's 101 (with its un-accepted client socket) is returned untouched, so the runtime pumps
 *  frames natively with no Worker CPU per frame. x-zy-ip is always overwritten, so a client cannot choose it. */
function toHub(req: Request, env: Env, init?: RequestInit): Promise<Response> {
  const fwd = new Request(req, init);
  fwd.headers.set("x-zy-ip", req.headers.get("CF-Connecting-IP") ?? "local");
  return env.HUB.getByName("main", { locationHint: "apac" }).fetch(fwd);
}

/** Read at most `max` bytes of the body; null when larger (checked on the declared length and on the bytes actually sent). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader(), parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

function withCors(res: Response, origin: string | null): Response {
  const r = new Response(res.body, res); // copy: headers of a fetched response are immutable
  if (origin !== null) r.headers.set("Access-Control-Allow-Origin", origin);
  r.headers.set("Vary", "Origin");
  return r;
}

async function publicApi(req: Request, env: Env, url: URL): Promise<Response> {
  const origin = req.headers.get("Origin");
  // the allowlist is an extra layer only (the code is the real check); a request without Origin is a non-browser client
  if (origin !== null && !originOk(origin, env.ALLOWED_ORIGINS))
    return withCors(json({ error: "origin_not_allowed", message: "这个网页不能使用知音服务器" }, 403), null);
  if (req.method === "OPTIONS") {
    if (origin === null) return withCors(json({ error: "origin_not_allowed" }, 403), null);
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400", Vary: "Origin" } });
  }
  try {
    const route = req.method + " " + url.pathname;
    let res: Response;
    if (route === "GET /api/config") {
      const now = Date.now();
      if (!configCache || now - configCache.at > CONFIG_TTL_MS) {
        const r = await toHub(req, env);
        if (!r.ok) return withCors(r, origin);
        configCache = { at: now, body: await r.text() };
      }
      res = new Response(configCache.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    } else if (route === "POST /api/register") {
      const body = await readCapped(req, REGISTER_MAX_BYTES);
      res = body === null
        ? json({ error: "invalid_input", field: "body", message: "内容太长" }, 400)
        : await toHub(req, env, { method: "POST", headers: { "content-type": "application/json" }, body });
    } else if (route === "GET /api/me") {
      res = await toHub(req, env);
    } else if (["/api/config", "/api/register", "/api/me"].includes(url.pathname)) {
      res = json({ error: "method_not_allowed" }, 405);
    } else {
      res = json({ error: "not_found" }, 404);
    }
    return withCors(res, origin);
  } catch (e) {
    console.error(JSON.stringify({ ev: "worker_error", path: url.pathname, err: String(e).slice(0, 300) }));
    return withCors(json({ error: "server_error", message: "服务器出错，请稍后再试" }, 500), origin);
  }
}

async function adminApi(req: Request, env: Env, url: URL): Promise<Response> {
  // same origin only, never any CORS: a cross-site page cannot even get a request through
  const origin = req.headers.get("Origin"), site = req.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== url.origin) || (site !== null && site !== "same-origin"))
    return json({ error: "forbidden", message: "请在店主后台页面里操作" }, 403);
  try {
    const res = await toHub(req, env);
    if (url.pathname === "/admin/api/settings" && req.method === "PUT" && res.ok) configCache = null; // same isolate sees new settings now
    return res;
  } catch (e) {
    console.error(JSON.stringify({ ev: "worker_error", path: url.pathname, err: String(e).slice(0, 300) }));
    return json({ error: "server_error", message: "服务器出错，请稍后再试" }, 500);
  }
}

function adminPage(req: Request): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return text("method not allowed", 405);
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
  return new Response(req.method === "HEAD" ? null : ADMIN_HTML.replaceAll("{{NONCE}}", nonce), { headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url), p = url.pathname;
    if (p === "/v1/listen") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return text("expected websocket", 426);
      if (!originOk(req.headers.get("Origin"), env.ALLOWED_ORIGINS)) return text("origin not allowed", 403);
      const protos = (req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((s) => s.trim());
      if (protos[0] !== PROTO || !protos[1]) return text("missing access code", 401);
      return toHub(req, env);
    }
    if (p.startsWith("/api/")) return publicApi(req, env, url);
    if (p.startsWith("/admin/api/")) return adminApi(req, env, url);
    if (p === "/admin" || p === "/admin/") return adminPage(req);
    if (p === "/") return new Response("ZhiYin server\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    return text("not found", 404);
  },
} satisfies ExportedHandler<Env>;
