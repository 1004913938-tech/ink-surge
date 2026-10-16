// Local end-to-end: mock Deepgram + `wrangler dev` (workerd/miniflare, no Cloudflare account) + ws/fetch clients acting as
// the page and the admin page. Secrets come from a temporary --env-file, so a developer's own .dev.vars is never touched.
// Locally CF-Connecting-IP is passed through, so tests use distinct fake IPs for the per-IP limits.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const ROOT = new URL("..", import.meta.url).pathname;
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort(), MOCK_PORT = await freePort(), INSPECT = await freePort();
const W = `http://127.0.0.1:${PORT}`, WS = `ws://127.0.0.1:${PORT}`, MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const ADMIN = "test-admin-password-123", ORIGIN = "https://1004913938-tech.github.io";
const PAGE_URL = "https://1004913938-tech.github.io/ink-surge/zhiyin/";
const IP = "10.0.0.1"; // the "normal" client
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra !== "" && !ok ? "  " + JSON.stringify(extra) : ""}`); };

const TMP = mkdtempSync(join(tmpdir(), "zy-e2e-"));
const persist = join(TMP, "state");
let envN = 0;
const envFile = (pw) => { const f = join(TMP, `env-${++envN}`); writeFileSync(f, `DEEPGRAM_API_KEY=testkey\nADMIN_PASSWORD=${pw}\n`); return f; };
const mock = spawn(process.execPath, [join(ROOT, "test/mock-deepgram.mjs"), String(MOCK_PORT)], { stdio: ["ignore", "ignore", "inherit"] });
let dev;
// the main run lifts the all-addresses registration limit (it registers 200+ to reach the pending cap); a later run checks it
async function startDev(pw = ADMIN, { state = persist, vars = ["REG_PER_HOUR:100000"] } = {}) {
  dev = spawn(join(ROOT, "node_modules/.bin/wrangler"), ["dev", "--port", String(PORT), "--ip", "127.0.0.1", "--inspector-port", String(INSPECT),
    "--persist-to", state, "--env-file", envFile(pw), "--var", `DG_URL:${MOCK}/v1/listen`, "--var", "FLUSH_MS:500",
    ...vars.flatMap((v) => ["--var", v]), "--show-interactive-dev-session=false", "--log-level", "warn"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(","), no_proxy: [process.env.no_proxy, "127.0.0.1,localhost"].filter(Boolean).join(",") } });
  dev.stdout.on("data", () => {});
  dev.stderr.on("data", (d) => { if (/error/i.test(d) && !/Network connection lost|hub_error|worker_error/.test(d)) process.stderr.write(d); });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(W + "/")).ok) return; } catch { /* not up yet */ } await sleep(500); }
  throw new Error("wrangler dev did not start");
}
async function stopDev() {
  if (!dev || dev.exitCode !== null) return;
  const exited = new Promise((r) => dev.once("exit", r));
  dev.kill("SIGTERM");
  await Promise.race([exited, sleep(5000)]);
  await sleep(500);
}

async function call(path, { method = "GET", body, raw, headers = {}, ip = IP } = {}) {
  const r = await fetch(W + path, { method, headers: { "CF-Connecting-IP": ip, ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: j, text, headers: r.headers };
}
const admin = (path, body, { pw = ADMIN, method, ip, headers = {} } = {}) =>
  call("/admin/api" + path, { method: method ?? (body !== undefined ? "POST" : "GET"), body, ip, headers: { Authorization: "Bearer " + pw, ...headers } });
const api = (path, { origin = ORIGIN, auth, ...o } = {}) =>
  call("/api" + path, { ...o, headers: { ...(origin ? { Origin: origin } : {}), ...(auth ? { Authorization: "Bearer " + auth } : {}), ...(o.headers ?? {}) } });

const sockets = [];
// origin null = a script that sends no Origin header (allowed: the code is the real check)
function open(code, q = "lang=en&diarize=0", origin = ORIGIN, ip = IP) {
  const ws = new WebSocket(`${WS}/v1/listen?${q}`, code === null ? undefined : ["zhiyin.v1", code], { ...(origin ? { origin } : {}), headers: { "CF-Connecting-IP": ip } });
  const g = { opened: false, protocol: null, msgs: [], quota: [], close: null, http: null, t0: Date.now() };
  ws.on("open", () => { g.opened = true; g.protocol = ws.protocol; });
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); (m.type === "ZhiYinQuota" ? g.quota : g.msgs).push(m); });
  ws.on("close", (c, r) => { g.close = { code: c, reason: r.toString(), afterMs: Date.now() - g.t0 }; });
  ws.on("unexpected-response", (q2, r) => { g.http = r.statusCode; });
  ws.on("error", () => {});
  sockets.push(ws);
  return { ws, g };
}
async function pump(ws, ms) { const end = Date.now() + ms; while (Date.now() < end && ws.readyState === 1) { ws.send(Buffer.alloc(900, 7)); await sleep(250); } }
async function closeAll() { for (const s of sockets) if (s.readyState <= 1) s.close(); await sleep(600); }
const seenCount = async () => (await fetch(MOCK + "/seen").then((r) => r.json())).length;
const overview = async () => (await admin("/overview")).body;
const history = async (id) => (await admin(`/users/${id}/sessions?limit=100`)).body;
const mk = async (name, minutes, days, extra = {}) => (await admin("/users", { name, contact: "", minutes, days, note: "", ...extra })).body;
const ctl = (q) => fetch(MOCK + "/ctl?" + q);
const usedOf = async (id) => (await overview()).users.find((u) => u.id === id).used_ms;
const WIB = 7 * 3600e3, DAYMS = 86400e3;
const wibEnd = (t) => Math.floor((t + WIB) / DAYMS) * DAYMS - WIB + DAYMS - 1; // 23:59:59.999 WIB of that day

try {
  await startDev();

  // ------------------------------------------------------------ basics, CORS, admin page, admin origin rules
  check("admin: wrong password -> 401", (await admin("/overview", undefined, { pw: "wrong-password-xyz", ip: "10.0.9.1" })).status === 401);
  const root = await call("/"), nf = await call("/nope");
  check("GET / -> 'ZhiYin server'; unknown path -> 404", root.status === 200 && root.text.startsWith("ZhiYin server") && nf.status === 404, [root.status, nf.status]);
  const cfg0 = await api("/config");
  check("/api/config: service, version, defaults", cfg0.status === 200 && cfg0.body.service === "zhiyin" && cfg0.body.version === 1 &&
    cfg0.body.registration_open === true && Array.isArray(cfg0.body.plans) && cfg0.body.pay_text === "", cfg0.body);
  const pre = await call("/api/register", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  check("CORS: preflight from the page origin -> 204 with allow headers", pre.status === 204 && pre.headers.get("access-control-allow-origin") === ORIGIN &&
    /POST/.test(pre.headers.get("access-control-allow-methods")) && /Authorization/i.test(pre.headers.get("access-control-allow-headers")) &&
    pre.headers.get("access-control-max-age") === "86400" && /Origin/.test(pre.headers.get("vary")), Object.fromEntries(pre.headers));
  const preNull = await call("/api/me", { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Method": "GET" } });
  check("CORS: preflight from file:// (Origin null) -> 204", preNull.status === 204 && preNull.headers.get("access-control-allow-origin") === "null");
  const preBad = await call("/api/register", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  check("CORS: preflight from a foreign origin -> 403 without ACAO", preBad.status === 403 && !preBad.headers.get("access-control-allow-origin"), preBad.status);
  const me401 = await api("/me", { auth: "ZZZZ-ZZZZ-ZZZZ-ZZZY", ip: "10.0.9.2" });
  check("CORS: 4xx carries ACAO + Vary + no-store", me401.status === 401 && me401.headers.get("access-control-allow-origin") === ORIGIN &&
    /Origin/.test(me401.headers.get("vary")) && me401.headers.get("cache-control") === "no-store" && me401.body.error === "unknown_code", me401.body);
  const regEvil = await api("/register", { method: "POST", body: { name: "x", contact: "abc" }, origin: "https://evil.example" });
  check("public API: foreign Origin -> 403", regEvil.status === 403 && !regEvil.headers.get("access-control-allow-origin"), regEvil.status);

  const p1 = await fetch(W + "/admin"), p2 = await fetch(W + "/admin");
  const csp = p1.headers.get("content-security-policy") ?? "", html1 = await p1.text(), html2 = await p2.text();
  const nonce = (csp.match(/'nonce-([^']+)'/) ?? [])[1], scriptNonces = [...html1.matchAll(/<script nonce="([^"]+)"/g)].map((m) => m[1]);
  check("/admin: strict CSP with a per-request nonce matching the script", p1.status === 200 && !!nonce && scriptNonces.length > 0 && scriptNonces.every((n) => n === nonce) &&
    /default-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /connect-src 'self'/.test(csp) && /form-action 'none'/.test(csp) &&
    /base-uri 'none'/.test(csp) && !html2.includes(`nonce="${nonce}"`) && !html1.includes("{{NONCE}}"), csp);
  check("/admin: nosniff + no-referrer + no-store, HTML in Chinese", p1.headers.get("x-content-type-options") === "nosniff" && p1.headers.get("referrer-policy") === "no-referrer" &&
    p1.headers.get("cache-control") === "no-store" && /lang="zh-CN"/.test(html1) && /店主后台/.test(html1));
  check("/admin: no innerHTML / external scripts in the page", !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|<script[^>]+src=/i.test(html1));
  const xo = await admin("/overview", undefined, { headers: { Origin: "https://evil.example" } });
  const xs = await admin("/overview", undefined, { headers: { "Sec-Fetch-Site": "cross-site" } });
  const xg = await admin("/users", { name: "x", minutes: 1, days: null }, { headers: { Origin: "https://1004913938-tech.github.io" } });
  check("admin API: cross-origin (Origin or Sec-Fetch-Site) -> 403, never CORS", xo.status === 403 && xs.status === 403 && xg.status === 403 &&
    !xo.headers.get("access-control-allow-origin") && !xg.headers.get("access-control-allow-origin"), [xo.status, xs.status, xg.status]);
  const so = await admin("/overview", undefined, { headers: { Origin: W, "Sec-Fetch-Site": "same-origin" } });
  check("admin API: same-origin browser request -> 200", so.status === 200, so.status);

  // ------------------------------------------------------------ codes and relay (prototype cases)
  const B = await mk("b", 10), C = await mk("c", 10);
  check("admin: issue code (16 base32 chars, dashed) + message", /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/.test(B.code) && B.user.id > 0 &&
    B.message.includes(B.code) && B.user.code_hint === B.code.slice(-4), B);
  const me = await api("/me", { auth: B.code.toLowerCase().replace(/-/g, " ") });
  check("/api/me: tolerant code input, remaining 600000", me.status === 200 && me.body.remaining_ms === 600000 && me.body.quota_ms === 600000 &&
    me.body.used_ms === 0 && me.body.status === "active" && me.body.live === false && me.headers.get("access-control-allow-origin") === ORIGIN, me.body);

  let c = open(null); await sleep(800); check("ws: no subprotocol -> HTTP 401", c.g.http === 401, c.g.http);
  c = open(B.code, undefined, "https://evil.example"); await sleep(800); check("ws: foreign Origin -> HTTP 403", c.g.http === 403, c.g.http);
  c = open("ZZZZ-ZZZZ-ZZZZ-ZZZZ", undefined, ORIGIN, "10.0.9.3"); await sleep(1000); check("ws: unknown code -> 4401", c.g.close?.code === 4401, c.g.close);
  c = open(B.code, "lang=fr&diarize=0"); await sleep(1000); check("ws: bad lang -> 4400", c.g.close?.code === 4400, c.g.close);
  const seenProto = await seenCount();
  const protoLangs = ["constructor", "__proto__", "toString"].map((l) => open(B.code, `lang=${l}&diarize=0`));
  await sleep(1200);
  check("ws: lang=constructor / __proto__ / toString -> 4400, Deepgram never contacted (regression: prototype keys passed the whitelist)",
    protoLangs.every((x) => x.g.close?.code === 4400) && (await seenCount()) === seenProto, protoLangs.map((x) => x.g.close));
  c = open("not-a-code"); await sleep(800);
  check("ws: malformed code -> refused by the Worker (HTTP 401)", c.g.http === 401, c.g.http);
  const junkMe = [];
  for (let i = 0; i < 25; i++) junkMe.push((await api("/me", { auth: "junk-" + i, ip: "10.0.9.9" })).status);
  const afterJunk = await api("/me", { auth: B.code, ip: "10.0.9.9" });
  check("/api/me: malformed codes -> 401 from the Worker, not counted against the address", junkMe.every((s) => s === 401) && afterJunk.status === 200, [junkMe[0], afterJunk.status]);

  const b1 = open(B.code, "lang=en&diarize=1&mip_opt_out=false&model=whisper&callback=https://evil.example"), c1 = open(C.code);
  await sleep(700); await Promise.all([pump(b1.ws, 1500), pump(c1.ws, 1500)]);
  check("relay: 101 echoes only zhiyin.v1", b1.g.protocol === "zhiyin.v1", b1.g.protocol);
  check("relay: two concurrent streams both get results", b1.g.msgs.length >= 4 && c1.g.msgs.length >= 4, [b1.g.msgs.length, c1.g.msgs.length]);
  check("relay: quota message sent to page", b1.g.quota.length >= 1 && b1.g.quota[0].remaining_ms > 590000 && b1.g.quota[0].expires_at === null, b1.g.quota[0]);
  const seen = await fetch(MOCK + "/seen").then((r) => r.json());
  const upB = new URL(seen.find((s) => s.url.includes("diarize=true")).url, "http://x").searchParams;
  check("upstream: server-chosen params only (nova-3, mip_opt_out=true, tags, no callback)", upB.get("model") === "nova-3" && upB.get("mip_opt_out") === "true" &&
    upB.getAll("tag").join() === `zhiyin,u${B.user.id}` && !upB.has("callback") && upB.get("diarize") === "true", Object.fromEntries(upB));
  check("upstream: Authorization: Token <server key>", seen.every((s) => s.auth === "Token testkey"));
  const meLive = await api("/me", { auth: B.code });
  check("/api/me: live stream shows live=true and counts unflushed time", meLive.body.live === true && meLive.body.used_ms > 0, meLive.body);

  const b2 = open(B.code); await sleep(900); await pump(b2.ws, 600);
  check("same code on a 2nd device: first gets 4409, second works", b1.g.close?.code === 4409 && b2.ws.readyState === 1 && b2.g.msgs.length > 0, b1.g.close);

  await admin(`/users/${C.user.id}/status`, { status: "disabled" }); await sleep(400);
  check("admin disable mid-stream -> 4401 at once", c1.g.close?.code === 4401, c1.g.close);
  c = open(C.code); await sleep(800); check("disabled code reconnect -> 4401", c.g.close?.code === 4401, c.g.close);
  const badStatus = await admin(`/users/${C.user.id}/status`, { status: "paused" });
  check("admin status: invalid value -> 400 invalid_input{field:status}", badStatus.status === 400 && badStatus.body.field === "status", badStatus.body);

  // quota / expiry / top-up mid-stream, run in parallel. Quotas are 12-13 s because a stream with < 10 s left is refused at connect.
  const A = await mk("short", 0.2), D = await mk("topup", 0.2), E = await mk("exp", null, 13 / 86400);
  const T1 = await mk("t9s", 0.15), T2 = await mk("t5s", null, 5 / 86400);
  const before = await seenCount();
  const t1 = open(T1.code), t2 = open(T2.code); await sleep(1000);
  check("< 10 s left at connect -> 4402, Deepgram never contacted", t1.g.close?.code === 4402 && t2.g.close?.code === 4402 && (await seenCount()) === before, [t1.g.close, t2.g.close]);
  // a Deepgram handshake that hangs is given up after 8 s (1011, the page reconnects), before the page's own 10 s timeout
  const SL = await mk("slow-dg", 10);
  await ctl("delayOnce=9500");
  const sl = open(SL.code); await sleep(400);
  const a1 = open(A.code), e1 = open(E.code), d1 = open(D.code); await sleep(300);
  setTimeout(() => admin(`/users/${D.user.id}/topup`, { add_minutes: 1, note: "mid-stream" }), 9000);
  await Promise.all([pump(a1.ws, 13500), pump(e1.ws, 14000), pump(d1.ws, 14500)]);
  check("quota 12 s -> 4402 mid-stream at ~12 s", a1.g.close?.code === 4402 && a1.g.close.afterMs > 11900 && a1.g.close.afterMs < 13300, a1.g.close);
  const ua = (await overview()).users.find((u) => u.id === A.user.id);
  check("metering: used_ms == quota after cut", ua.used_ms >= 12000 && ua.used_ms < 12300 && ua.remaining_ms === 0, ua.used_ms);
  c = open(A.code); await sleep(800); check("used-up code reconnect -> 4402", c.g.close?.code === 4402, c.g.close);
  check("expiry date reached mid-stream -> 4402", e1.g.close?.code === 4402 && e1.g.close.afterMs < 14000, e1.g.close);
  check("admin top-up mid-stream extends the live stream", d1.ws.readyState === 1 && d1.g.quota.some((q) => q.remaining_ms > 30000), d1.g.close); d1.ws.close();
  check("Deepgram handshake hanging > 8 s -> 1011 at ~8 s (and the 8 s limit never cuts an open stream)", sl.g.close?.code === 1011 &&
    sl.g.close.afterMs > 7500 && sl.g.close.afterMs < 9500 && (await history(SL.user.id)).sessions.length === 0, sl.g.close);

  b2.ws.send(JSON.stringify({ type: "CloseStream" })); await sleep(800);
  check("CloseStream -> Metadata relayed, close 1000", b2.g.msgs.at(-1)?.type === "Metadata" && b2.g.close?.code === 1000, b2.g.close);

  const b3 = open(B.code); await sleep(700); b3.ws.send(JSON.stringify({ type: "MockClose", code: 1011 })); await sleep(600);
  check("Deepgram 1011 mid-stream forwarded", b3.g.close?.code === 1011, b3.g.close);
  await fetch(MOCK + "/ctl?next=402"); c = open(B.code); await sleep(1000);
  check("Deepgram 402 at handshake -> 4503", c.g.close?.code === 4503, c.g.close);
  await fetch(MOCK + "/ctl?next=429"); c = open(B.code); await sleep(1000);
  check("Deepgram 429 at handshake -> 4429", c.g.close?.code === 4429, c.g.close);
  const ov2 = await overview();
  check("admin overview shows last Deepgram error (newer than last good session)", ov2.dg_error?.status === 429 && ov2.dg_error.err === "mock 429" && ov2.dg_error.at > ov2.last_ok_at, ov2.dg_error);
  const hB = await history(B.user.id);
  const sB = hB.sessions.find((s) => s.dg_duration_s && s.end_code === 1000);
  check("session row: ms, bytes_up, Metadata duration", sB && sB.ms > 0 && sB.bytes_up > 0 && sB.end_code === 1000 && sB.dg_request_id === "mock-req", sB);
  check("sessions endpoint: rows newest first + ledger issue row", hB.sessions.length >= 3 && hB.sessions[0].started_at >= hB.sessions.at(-1).started_at &&
    hB.ledger.some((l) => l.kind === "issue" && l.add_ms === 600000), hB.ledger);
  await closeAll();

  // ------------------------------------------------------------ audio faster than real time (a script with a valid code)
  // regression: metering was wall-clock only and uploads were unlimited, so 10 minutes of audio pushed in 0.7 s cost 0.6 s
  const FL = await mk("flood", 1);
  const fl = open(FL.code, undefined, null); await sleep(700);
  const flSeen = (await fetch(MOCK + "/seen").then((r) => r.json())).length;
  for (let i = 0; i < 400; i++) fl.ws.send(Buffer.alloc(4096, 3)); // 400 x 4 KB (100 s of "audio") as fast as the socket takes it
  await sleep(1500);
  const hFL = (await history(FL.user.id)).sessions[0], upFL = (await fetch(MOCK + "/seen").then((r) => r.json()))[flSeen - 1];
  check("burst upload -> stream ends with 4413 at once; the over-budget frames never reach Deepgram",
    fl.g.close?.code === 4413 && hFL.end_code === 4413 && hFL.bytes_up <= 32_000 + 2 * 32_000 && upFL.frames < 30, [fl.g.close, hFL, upFL.frames]);
  check("burst upload: charged at least the audio Deepgram received (Metadata after CloseStream)",
    hFL.dg_duration_s > 0 && hFL.ms >= hFL.dg_duration_s * 1000 && (await usedOf(FL.user.id)) === hFL.ms, hFL);

  await ctl("frameSec=3"); // a client that packs 3 s of audio into each small message (low bitrate): bytes stay in budget
  const LD = await mk("lead", 5);
  const ld = open(LD.code, undefined, null); await sleep(700);
  for (let i = 0; i < 8 && ld.ws.readyState === 1; i++) { ld.ws.send(Buffer.alloc(200, 1)); await sleep(40); }
  await sleep(1200);
  await ctl("frameSec=0.25");
  const hLD = (await history(LD.user.id)).sessions[0], usedLD = await usedOf(LD.user.id);
  check("audio cursor > clock + 10 s -> 4413; charged max(clock, audio) = the audio, not the ~1 s of connection",
    ld.g.close?.code === 4413 && hLD.dg_duration_s >= 12 && usedLD >= 12_000 && usedLD >= hLD.dg_duration_s * 1000 && hLD.ms === usedLD, [ld.g.close, hLD, usedLD]);

  // ------------------------------------------------------------ newest wins by arrival, not by when Deepgram answers
  // regression: the page abandons a slow handshake (立即重连 / 10 s timeout) and reconnects; the abandoned attempt's late
  // Deepgram answer used to end the NEW stream with 4409, which stops the page for good
  const RC = await mk("race", 10);
  await ctl("delayOnce=2500");
  const ra = open(RC.code); await sleep(500);
  ra.ws.terminate(); // given up while still connecting
  const rb = open(RC.code); await sleep(700);
  await pump(rb.ws, 3500); // the abandoned handshake completes in the meantime (at ~2.5 s)
  const hRC = await history(RC.user.id);
  check("abandoned slow handshake + reconnect: the new stream keeps running (no 4409), the stale attempt makes no session",
    rb.ws.readyState === 1 && rb.g.close === null && rb.g.msgs.length > 4 && hRC.sessions.length === 1 && hRC.sessions[0].live === true, [rb.g.close, hRC.sessions]);
  rb.ws.close();

  // per-user connection attempts: 20 a minute, then 4429 (the page waits 30 s); stale attempts get 4409, one stream stays
  const HL = await mk("handshakes", 10);
  const hl = Array.from({ length: 22 }, () => open(HL.code));
  await sleep(2500);
  const hlCodes = hl.map((x) => x.g.close?.code ?? (x.ws.readyState === 1 ? "open" : "?"));
  check("handshake limit: 22 rapid attempts -> 20 allowed (19 x 4409, 1 open), 2 x 4429",
    hlCodes.filter((x) => x === 4429).length === 2 && hlCodes.filter((x) => x === 4409).length === 19 && hlCodes.filter((x) => x === "open").length === 1, hlCodes);
  await closeAll();

  // ------------------------------------------------------------ settings
  const goodSettings = { pay_text: "微信：zhiyin-shop\n支付宝：138xxxx", registration_open: true, max_streams: 25, usd_per_min: 0.0077,
    plans: [{ name: "试用 60 分钟", minutes: 60, days: 30, price: "¥10" }, { name: "包月不限时", minutes: null, days: 30, price: "¥99" }] };
  const badCases = [
    [{ ...goodSettings, max_streams: 0 }, "max_streams"], [{ ...goodSettings, max_streams: 61 }, "max_streams"],
    [{ ...goodSettings, pay_text: "x".repeat(2001) }, "pay_text"], [{ ...goodSettings, registration_open: "yes" }, "registration_open"],
    [{ ...goodSettings, usd_per_min: -1 }, "usd_per_min"], [{ ...goodSettings, plans: Array.from({ length: 11 }, () => goodSettings.plans[0]) }, "plans"],
    [{ ...goodSettings, plans: [{ name: "", minutes: 10, days: null, price: "" }] }, "plans.0.name"],
    [{ ...goodSettings, plans: [{ name: "x", minutes: -5, days: null, price: "" }] }, "plans.0.minutes"],
  ];
  const badRes = [];
  for (const [b, field] of badCases) { const r = await admin("/settings", b, { method: "PUT" }); badRes.push(r.status === 400 && r.body.error === "invalid_input" && r.body.field === field && !!r.body.message ? "ok" : [field, r.status, r.body]); }
  check("settings: invalid values -> 400 invalid_input{field} with a Chinese message", badRes.every((x) => x === "ok"), badRes);
  const put = await admin("/settings", goodSettings, { method: "PUT" });
  const plans = put.body?.plans ?? [];
  check("settings: valid -> saved, plan ids assigned", put.status === 200 && plans.length === 2 && plans.every((p) => /^[A-Za-z0-9_-]+$/.test(p.id)) && plans[1].minutes === null, put.body);
  const cfg1 = await api("/config");
  check("/api/config reflects saved settings (cache refreshed)", cfg1.body.pay_text === goodSettings.pay_text && cfg1.body.plans.length === 2 && cfg1.body.plans[0].id === plans[0].id, cfg1.body);

  // ------------------------------------------------------------ registration
  const reg = (body, ip = "10.1.0.1", origin = ORIGIN) => api("/register", { method: "POST", body, ip, origin });
  const okReg = { name: "小王", contact: "wx: wang123", plan_id: plans[0].id, note: "付款人 王某", website: "" };
  const vr = [
    [{ ...okReg, name: "" }, "name"], [{ ...okReg, name: "x".repeat(41) }, "name"], [{ ...okReg, contact: "ab" }, "contact"],
    [{ ...okReg, plan_id: "nope" }, "plan_id"], [{ ...okReg, note: "x".repeat(201) }, "note"],
  ];
  const vrRes = [];
  for (const [b, field] of vr) { const r = await reg(b); vrRes.push(r.status === 400 && r.body.error === "invalid_input" && r.body.field === field ? "ok" : [field, r.status, r.body]); }
  const big = await api("/register", { method: "POST", raw: JSON.stringify({ ...okReg, note: "x".repeat(5000) }), ip: "10.1.0.1" });
  const junk = await api("/register", { method: "POST", raw: "{not json", ip: "10.1.0.1" });
  check("register: validation -> 400 invalid_input{field}", vrRes.every((x) => x === "ok"), vrRes);
  check("register: body > 4 KB and bad JSON -> 400 {field:body}", big.status === 400 && big.body.field === "body" && junk.status === 400 && junk.body.field === "body" &&
    big.headers.get("access-control-allow-origin") === ORIGIN, [big.status, big.body, junk.body]);
  const hp = await reg({ ...okReg, name: "bot", website: "http://spam.example" }, "10.1.0.2");
  const r1 = await reg(okReg, "10.1.0.1");
  const ovR = await overview();
  check("register: honeypot -> fake 201, nothing stored", hp.status === 201 && /^R[0-9A-Z]{5}$/.test(hp.body.ref) && !ovR.registrations.some((r) => r.ref === hp.body.ref || r.name === "bot"), hp.body);
  const pendR1 = ovR.registrations.find((r) => r.ref === r1.body?.ref);
  check("register: 201 {ref, pay_text, plan}; listed as pending with its plan", r1.status === 201 && /^R[0-9A-HJKMNP-TV-Z]{5}$/.test(r1.body.ref) &&
    r1.body.pay_text === goodSettings.pay_text && r1.body.plan?.id === plans[0].id && pendR1?.status === "pending" && pendR1.plan?.name === "试用 60 分钟" &&
    pendR1.name === "小王" && pendR1.contact === "wx: wang123" && pendR1.note === "付款人 王某", [r1.body, pendR1]);

  const ap = await admin(`/registrations/${r1.body.ref}/approve`, { minutes: 600, days: 90, note: "微信 ¥50" });
  const exp90 = new Date(ap.body?.user?.expires_at + 7 * 3600e3).toISOString().slice(0, 10);
  check("approve -> 201 {user, code, message}", ap.status === 201 && /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/.test(ap.body.code) && ap.body.user.name === "小王" &&
    ap.body.user.quota_ms === 36_000_000, ap.body);
  // the message says 有效期至 <date>: whole days now run to the END of that WIB day (it used to be the time of day issued)
  check("approve: 90 days -> expires 23:59:59.999 WIB on the 90th day", ap.body.user.expires_at === wibEnd(ap.body.user.created_at + 90 * DAYMS),
    [ap.body.user.expires_at, wibEnd(ap.body.user.created_at + 90 * DAYMS)]);
  check("approve: WeChat-ready message", ap.body.message === `你的知音字幕授权码：${ap.body.code}\n额度：600 分钟，有效期至 ${exp90}（先到为准）\n` +
    `用电脑版 Chrome 打开 ${PAGE_URL} → 第 1 步粘贴授权码 → 开始。同一授权码同时只能在一个页面使用。`, ap.body.message);
  const meAp = await api("/me", { auth: ap.body.code });
  check("approved code works on /api/me", meAp.status === 200 && meAp.body.remaining_ms === 36_000_000, meAp.body);
  const ap2 = await admin(`/registrations/${r1.body.ref}/approve`, { minutes: 600, days: 90, note: "" });
  const rj2 = await admin(`/registrations/${r1.body.ref}/reject`, {});
  check("approve/reject an already approved registration -> 409", ap2.status === 409 && ap2.body.error === "already_decided" && rj2.status === 409, [ap2.status, rj2.status]);
  const r2 = await reg({ ...okReg, name: "小李", contact: "13800000000" }, "10.1.0.3");
  const rj = await admin(`/registrations/${r2.body.ref}/reject`, {});
  const ap3 = await admin(`/registrations/${r2.body.ref}/approve`, { minutes: 60, days: null, note: "" });
  const unk = await admin("/registrations/RZZZZZ/approve", { minutes: 60, days: null, note: "" });
  const ovR2 = await overview();
  check("reject -> 200, then approve -> 409, unknown ref -> 404", rj.status === 200 && ap3.status === 409 && unk.status === 404 &&
    ovR2.registrations.find((r) => r.ref === r2.body.ref)?.status === "rejected", [rj.status, ap3.status, unk.status]);
  const apBad = await admin(`/registrations/${r1.body.ref}/approve`, { minutes: -1, days: null });
  check("approve: invalid minutes -> 400 {field:minutes}", apBad.status === 400 && apBad.body.field === "minutes", apBad.body);
  const hI = await history(ap.body.user.id);
  check("ledger: issue row with the payment note and ref", hI.ledger.length === 1 && hI.ledger[0].kind === "issue" && hI.ledger[0].add_ms === 36_000_000 &&
    hI.ledger[0].note === `${r1.body.ref} · 微信 ¥50`, hI.ledger);

  const rl = [];
  for (let i = 0; i < 6; i++) rl.push((await reg({ ...okReg, name: "限流" + i }, "10.2.0.1")).status);
  check("register: 5 per hour per IP, 6th -> 429 rate_limited", rl.slice(0, 5).every((s) => s === 201) && rl[5] === 429, rl);

  let n503 = null, made = 0;
  for (let ipN = 0; ipN < 60 && !n503; ipN++) {
    for (let k = 0; k < 5 && !n503; k++) {
      const r = await reg({ ...okReg, name: `批量${ipN}-${k}` }, `10.4.${ipN}.1`);
      if (r.status === 503) n503 = r; else if (r.status === 201) made++; else { n503 = r; }
    }
  }
  const pendingNow = (await overview()).registrations.filter((r) => r.status === "pending").length;
  check("register: 200 pending -> 503 too_many_pending (with CORS)", n503?.status === 503 && n503.body.error === "too_many_pending" && pendingNow === 200 &&
    n503.headers.get("access-control-allow-origin") === ORIGIN, [n503?.status, n503?.body, pendingNow, made]);
  await admin("/settings", { ...goodSettings, plans, registration_open: false }, { method: "PUT" });
  const closed = await reg(okReg, "10.5.0.1"), cfgClosed = await api("/config");
  check("register: closed -> 403 registration_closed; /api/config says closed", closed.status === 403 && closed.body.error === "registration_closed" &&
    cfgClosed.body.registration_open === false, [closed.status, closed.body]);
  await admin("/settings", { ...goodSettings, plans }, { method: "PUT" });

  // ------------------------------------------------------------ reissue, delete, max_streams, top-up rules, totals
  const R = await mk("reissue-me", 30);
  const rr1 = open(R.code); await sleep(700); await pump(rr1.ws, 500);
  const ri = await admin(`/users/${R.user.id}/reissue`, {}); await sleep(400);
  check("reissue: live stream -> 4401 at once", rr1.g.close?.code === 4401, rr1.g.close);
  check("reissue: new code + message (新授权码, remaining)", ri.status === 200 && ri.body.code !== R.code && ri.body.message.startsWith("你的知音字幕新授权码（旧码已作废）：" + ri.body.code) &&
    /剩余额度：\d+(\.\d)? 分钟，长期有效/.test(ri.body.message) && ri.body.user.code_hint === ri.body.code.slice(-4), ri.body);
  c = open(R.code, undefined, ORIGIN, "10.0.9.4"); await sleep(900);
  const meOld = await api("/me", { auth: R.code, ip: "10.0.9.4" }), meNew = await api("/me", { auth: ri.body.code });
  check("reissue: old code -> 4401 and /api/me 401; new code accepted", c.g.close?.code === 4401 && meOld.status === 401 && meNew.status === 200, [c.g.close, meOld.status, meNew.status]);
  const rr2 = open(ri.body.code); await sleep(700); await pump(rr2.ws, 600);
  check("reissue: new code streams", rr2.g.msgs.length > 0 && rr2.ws.readyState === 1); rr2.ws.close();

  const rd = await reg({ ...okReg, name: "要删除的人", contact: "delete-me@example.com" }, "10.6.0.1");
  // the pending cap is reached; make room by rejecting one
  const firstPending = (await overview()).registrations.find((r) => r.status === "pending" && r.name.startsWith("批量"));
  await admin(`/registrations/${firstPending.ref}/reject`, {});
  const rd2 = rd.status === 201 ? rd : await reg({ ...okReg, name: "要删除的人", contact: "delete-me@example.com" }, "10.6.0.2");
  const K = (await admin(`/registrations/${rd2.body.ref}/approve`, { minutes: 30, days: null, note: "" })).body;
  const k1 = open(K.code); await sleep(700); await pump(k1.ws, 800);
  const usedBefore = (await overview()).users.find((u) => u.id === K.user.id).used_ms;
  const del = await admin(`/users/${K.user.id}/delete`, {}); await sleep(400);
  const ovD = await overview(), uD = ovD.users.find((u) => u.id === K.user.id), regD = ovD.registrations.find((r) => r.ref === rd2.body.ref);
  check("delete: live stream -> 4401", k1.g.close?.code === 4401, k1.g.close);
  check("delete: name/contact scrubbed (user + registration), disabled, usage kept", del.status === 200 && uD.name === "" && uD.contact === "" && uD.deleted === true &&
    uD.status === "disabled" && uD.used_ms >= usedBefore && uD.used_ms > 0 && regD?.name === "" && regD?.contact === "" && regD?.note === null, [uD, regD]);
  c = open(K.code, undefined, ORIGIN, "10.0.9.5"); await sleep(900);
  const reEnable = await admin(`/users/${K.user.id}/status`, { status: "active" }), hD = await history(K.user.id);
  check("delete: code refused (4401), cannot re-enable (409), ledger has delete", c.g.close?.code === 4401 && reEnable.status === 409 &&
    hD.ledger[0].kind === "delete" && hD.sessions.length >= 1, [c.g.close, reEnable.status, hD.ledger]);

  await closeAll();
  const X = await mk("max-x", 30), Y = await mk("max-y", 30);
  const x1 = open(X.code); await sleep(700);
  const live1 = (await overview()).live_count;
  await admin("/settings", { ...goodSettings, plans, max_streams: 1 }, { method: "PUT" });
  const y1 = open(Y.code); await sleep(900);
  const x2 = open(X.code); await sleep(900); await pump(x2.ws, 500);
  check("max_streams reached -> 4429 for a new user", live1 === 1 && y1.g.close?.code === 4429, [live1, y1.g.close]);
  check("max_streams: same code may still replace its own stream (4409)", x1.g.close?.code === 4409 && x2.ws.readyState === 1 && x2.g.msgs.length > 0, x1.g.close);
  await admin("/settings", { ...goodSettings, plans }, { method: "PUT" }); x2.ws.close();
  // regression: max_streams was checked before the await on Deepgram, so connections arriving together all got in
  await closeAll();
  const P1 = await mk("race-p", 30), P2 = await mk("race-q", 30);
  await admin("/settings", { ...goodSettings, plans, max_streams: 1 }, { method: "PUT" });
  await ctl("delay=1500");
  const pa = open(P1.code), pb = open(P2.code);
  await sleep(2600);
  const liveRace = (await overview()).live_count, raceCodes = [pa.g.close?.code ?? null, pb.g.close?.code ?? null];
  await ctl("delay=0");
  check("max_streams=1, two codes connecting at the same time (slow Deepgram) -> one 4429, one live",
    raceCodes.filter((x) => x === 4429).length === 1 && raceCodes.includes(null) && liveRace === 1, [raceCodes, liveRace]);
  await admin("/settings", { ...goodSettings, plans }, { method: "PUT" });
  await closeAll();

  const U1 = await mk("topup-1", 10, 1), U2 = await mk("topup-2", null, null);
  const t1r = await admin(`/users/${U1.user.id}/topup`, { add_minutes: 5, add_days: 2, note: "微信 ¥20" });
  const t2r = await admin(`/users/${U2.user.id}/topup`, { add_minutes: 5, add_days: 2, note: "" });
  const t3before = Date.now();
  const t3r = await admin(`/users/${E.user.id}/topup`, { add_days: 1, note: "" });
  const t3after = Date.now();
  const t0r = await admin(`/users/${U1.user.id}/topup`, { add_minutes: 0, add_days: 0 });
  const t404 = await admin(`/users/999999/topup`, { add_minutes: 5 });
  check("top-up: quota += minutes; expiry = max(expiry, now) + days", t1r.status === 200 && t1r.body.user.quota_ms === 15 * 60000 &&
    t1r.body.user.expires_at === U1.user.expires_at + 2 * 86400e3, t1r.body);
  check("top-up: unlimited stays unlimited (NULL stays NULL)", t2r.body.user.quota_ms === null && t2r.body.user.expires_at === null, t2r.body);
  check("top-up: expired code restarts from now (+1 day, to the end of that WIB day)", [wibEnd(t3before + DAYMS), wibEnd(t3after + DAYMS)].includes(t3r.body.user.expires_at) &&
    t3r.body.user.remaining_ms > 0, t3r.body);
  check("top-up: nothing to add -> 400; unknown user -> 404", t0r.status === 400 && t404.status === 404, [t0r.status, t404.status]);
  const hU1 = await history(U1.user.id);
  check("ledger: top-up row with note", hU1.ledger[0].kind === "topup" && hU1.ledger[0].add_ms === 5 * 60000 && hU1.ledger[0].note === "微信 ¥20" &&
    hU1.ledger[0].expires_at === t1r.body.user.expires_at, hU1.ledger);
  // regression: a negative correction larger than the total was clamped at 0 while the ledger kept the typed amount
  const tOver = await admin(`/users/${U1.user.id}/topup`, { add_minutes: -6000, note: "typo" });
  const tFix = await admin(`/users/${U1.user.id}/topup`, { add_minutes: -5, note: "改错" });
  const hU1b = await history(U1.user.id), hU2 = await history(U2.user.id);
  check("top-up: taking back more than the total -> 400 {field:add_minutes} naming the total; nothing changed",
    tOver.status === 400 && tOver.body.field === "add_minutes" && /15 分钟/.test(tOver.body.message) && hU1b.ledger.length === 3, [tOver.status, tOver.body]);
  check("top-up: a correction is recorded as the change actually made", tFix.status === 200 && tFix.body.user.quota_ms === 10 * 60000 &&
    hU1b.ledger[0].add_ms === -5 * 60000 && hU1b.ledger[0].note === "改错", [tFix.body, hU1b.ledger[0]]);
  check("top-up on an unlimited, never-expiring code: ledger records no change (not +5 min / +2 days)",
    hU2.ledger[0].kind === "topup" && hU2.ledger[0].add_ms === null && hU2.ledger[0].expires_at === null, hU2.ledger[0]);

  const ovT = await overview(), tt = ovT.totals, uB = ovT.users.find((u) => u.id === B.user.id);
  check("overview: WIB totals today <= month <= all, > 0; per-user month_ms", tt.today_min > 0 && tt.today_min <= tt.month_min && tt.month_min <= tt.all_min &&
    uB.month_ms > 0 && typeof ovT.now === "number" && ovT.max_streams === 25 && ovT.settings.plans.length === 2, tt);
  check("overview: registrations pending first, users never expose code_hash", ovT.registrations[0].status === "pending" &&
    ovT.users.every((u) => !("code_hash" in u) && "remaining_ms" in u && "live" in u), ovT.users[0]);

  // ------------------------------------------------------------ lockouts (distinct IPs, so they do not affect other cases)
  const LOCK = "10.66.0.1", lk = [];
  for (let i = 0; i < 20; i++) lk.push((await api("/me", { auth: `ZZZZ-ZZZZ-ZZZZ-${String(1000 + i).replace(/[01]/g, "Z")}`, ip: LOCK })).status);
  const lk21 = await api("/me", { auth: B.code, ip: LOCK });
  c = open(B.code, undefined, ORIGIN, LOCK); await sleep(900);
  const other = await api("/me", { auth: B.code, ip: "10.66.0.2" });
  check("bad-code lockout: 20 wrong codes -> /api/me 429 too_many_attempts", lk.every((s) => s === 401) && lk21.status === 429 && lk21.body.error === "too_many_attempts", [lk, lk21.status]);
  check("bad-code lockout: WebSocket from that IP -> 4429; other IPs fine", c.g.close?.code === 4429 && other.status === 200, [c.g.close, other.status]);
  // regression: limits were keyed on the full IPv6 address, so one host could rotate through its /64 forever
  const V6 = "2001:db8:66:1", lk6 = [];
  for (let i = 0; i < 20; i++) lk6.push((await api("/me", { auth: `ZZZZ-ZZZZ-ZZZZ-${String(1000 + i).replace(/[01]/g, "Z")}`, ip: `${V6}::${(i + 1).toString(16)}` })).status);
  const lk6same = await api("/me", { auth: B.code, ip: `${V6}:ffff::1` }), lk6other = await api("/me", { auth: B.code, ip: "2001:db8:66:2::1" });
  check("IPv6: 20 wrong codes from 20 addresses of one /64 -> the whole /64 is locked (429); the next /64 is fine",
    lk6.every((s) => s === 401) && lk6same.status === 429 && lk6other.status === 200, [lk6, lk6same.status, lk6other.status]);
  const AL = "10.77.0.1", al = [];
  for (let i = 0; i < 10; i++) al.push((await admin("/overview", undefined, { pw: "wrong-" + i, ip: AL })).status);
  const al11 = await admin("/overview", undefined, { ip: AL }), alOther = await admin("/overview");
  check("admin lockout: 10 wrong passwords -> 429 locked even with the right one", al.every((s) => s === 401) && al11.status === 429 && al11.body.error === "locked" &&
    alOther.status === 200, [al, al11.status]);
  await closeAll();

  // ------------------------------------------------------------ restart (prototype cases)
  const b4 = open(B.code); await sleep(700); await pump(b4.ws, 800);
  await stopDev();
  check("server restart: page sees an abnormal close (reconnects)", b4.g.close && b4.g.close.code !== 4401 && b4.g.close.code !== 4402, b4.g.close);
  await startDev();
  const hB3 = await history(B.user.id);
  check("after restart: orphan session closed as 'server restart'", hB3.sessions.some((s) => s.end_reason === "server restart" && s.end_code === 1012), hB3.sessions[0]);
  c = open(B.code); await sleep(700); await pump(c.ws, 600); check("after restart: code works again", c.g.msgs.length > 0); c.ws.close();
  const cfgR = await api("/config");
  check("after restart: settings persisted", cfgR.body.plans.length === 2 && cfgR.body.pay_text === goodSettings.pay_text, cfgR.body);

  // ------------------------------------------------------------ global admin lock (wrong passwords from many addresses)
  const gl = [];
  for (let i = 0; i < 30; i++) gl.push((await admin("/overview", undefined, { pw: "wrong-global-" + i, ip: `10.88.${i}.1` })).status);
  const glRight = await admin("/overview", undefined, { ip: "10.88.200.1" });
  check("admin: 30 wrong passwords from 30 addresses -> whole admin locked (429), even the right password from a new address",
    gl.every((s) => s === 401) && glRight.status === 429 && glRight.body.error === "locked" && /锁定 15 分钟/.test(glRight.body.message), [gl, glRight.status]);
  await stopDev();
  await startDev();
  const glAfter = await admin("/overview", undefined, { ip: "10.88.201.1" }), glPublic = await api("/config");
  check("admin lock survives a restart (kept in SQLite); the public API is unaffected", glAfter.status === 429 && glAfter.body.error === "locked" && glPublic.status === 200,
    [glAfter.status, glAfter.body]);

  // ------------------------------------------------------------ short ADMIN_PASSWORD
  await stopDev();
  await startDev("short-pw-15char");
  const sp = await admin("/overview", undefined, { pw: "short-pw-15char" }), spCfg = await api("/config");
  check("ADMIN_PASSWORD shorter than 16 -> admin 503 admin_password_too_short (public API still up)", sp.status === 503 && sp.body.error === "admin_password_too_short" &&
    spCfg.status === 200, [sp.status, sp.body]);

  // ------------------------------------------------------------ a Chinese ADMIN_PASSWORD (fresh state, default limits)
  // regression: a browser cannot send non-Latin-1 text in a header, so such a password made the admin page unusable.
  // The page now sends it percent-encoded and the server accepts that form too.
  await stopDev();
  const CN = "知音字幕后台密码请勿告诉别人谢谢"; // 16 characters, as README step 5 allows
  // the secret is stored with a trailing space (as a careless paste would): the server trims it
  await startDev(`"${CN} "`, { state: join(TMP, "state-cn"), vars: [] });
  const cnOk = await admin("/overview", undefined, { pw: encodeURIComponent(CN), ip: "10.90.0.1" });
  const cnBad = await admin("/overview", undefined, { pw: encodeURIComponent("知音字幕后台密码请勿告诉别人谢了"), ip: "10.90.0.2" });
  check("Chinese ADMIN_PASSWORD (stored with a trailing space): percent-encoded bearer -> 200; a wrong one -> 401", cnOk.status === 200 && cnBad.status === 401,
    [cnOk.status, cnBad.status]);
  const pwCN = encodeURIComponent(CN);
  // registrations from everywhere together: 30 an hour (one host with many addresses cannot fill the 200-slot queue)
  const gr = [];
  let cutoff = 0;
  for (let i = 0; i < 30; i++) {
    if (i === 29) { await sleep(20); cutoff = Date.now(); await sleep(20); }
    gr.push((await api("/register", { method: "POST", body: { name: "批" + i, contact: "wx" + i, website: "" }, ip: `10.91.${i}.1` })).status);
  }
  const gr31 = await api("/register", { method: "POST", body: { name: "第31个", contact: "wx31", website: "" }, ip: "10.91.99.1" });
  check("registration: 30 an hour from all addresses together, then 429 rate_limited", gr.every((s) => s === 201) && gr31.status === 429 &&
    gr31.body.error === "rate_limited", [gr, gr31.status]);
  // 全部拒绝: every pending registration the owner could see (created up to the overview's time), not newer ones
  const rjAll = await admin("/registrations/reject-pending", { before: cutoff }, { pw: pwCN });
  const ovCN = await admin("/overview", undefined, { pw: pwCN });
  const pendCN = ovCN.body.registrations.filter((r) => r.status === "pending");
  check("全部拒绝: rejects the 29 seen, keeps the one that arrived later", rjAll.status === 200 && rjAll.body.rejected === 29 &&
    pendCN.length === 1 && pendCN[0].name === "批29", [rjAll.body, pendCN.map((r) => r.name)]);
} catch (e) { console.error(e); results.push(false); }
finally {
  for (const s of sockets) { try { s.terminate(); } catch { /* gone */ } }
  await stopDev().catch(() => {});
  mock.kill();
  rmSync(TMP, { recursive: true, force: true });
}
console.log(results.every(Boolean) ? `ALL ${results.length} PASS` : `${results.filter((x) => !x).length} of ${results.length} FAILED`);
process.exit(results.every(Boolean) ? 0 : 1);
