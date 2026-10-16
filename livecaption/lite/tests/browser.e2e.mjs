// End-to-end test of ../index.html in Chromium against a mock Deepgram streaming server.
// Needs playwright + ws: LC_DEPS=<dir containing node_modules> node livecaption/lite/tests/browser.e2e.mjs
// Optional: CHROMIUM=<executable path>, OUT=<screenshot dir>, LC_INDEX=<another build of the page>.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(join(process.env.LC_DEPS || process.cwd(), "noop.js"));
const { chromium } = require("playwright");
const { WebSocketServer } = require("ws");

const INDEX = process.env.LC_INDEX || fileURLToPath(new URL("../index.html", import.meta.url));
const OUT = process.env.OUT || "/tmp";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra = "") { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); }

// ------------------------------------------------------------------ mock Deepgram
const w = (word, speaker, punct) => ({ word: word.toLowerCase().replace(/[.,?!]/g, ""), start: 0, end: 0, confidence: 0.95, punctuated_word: punct ?? word, speaker, speaker_confidence: 0.8 });
const res = (words, is_final, speech_final = false) => JSON.stringify({
  type: "Results", channel_index: [0, 1], duration: 1, start: 0, is_final, speech_final, from_finalize: false,
  channel: { alternatives: [{ transcript: words.map((x) => x.punctuated_word).join(" "), confidence: 0.95, words }] },
  metadata: { request_id: "mock", model_info: { name: "general-nova-3" } },
});
const SCRIPTS = {
  // first connection: two interviewers, then the server drops the connection
  "goodkey#1": async (ws) => {
    ws.send(JSON.stringify({ type: "SpeechStarted", channel: [0], timestamp: 0.1 }));
    ws.send(res([w("Could", 0), w("you", 0)], false));
    await sleep(300);
    ws.send(res([w("Could", 0), w("you", 0), w("introduce", 0)], true));
    await sleep(1200);                                    // long enough to see the provisional translation
    ws.send(res([w("yourself", 0)], false));
    await sleep(300);
    ws.send(res([w("yourself", 0), w("briefly?", 0)], true, true));
    await sleep(300);
    ws.send(res([w("And", 1), w("your", 1), w("notice", 1), w("period?", 1)], true));
    await sleep(200);
    ws.send(JSON.stringify({ type: "UtteranceEnd", channel: [0, 1], last_word_end: 3.2 }));
    await sleep(800);
    ws.close(1011, "mock: server restart");
    return "closed";
  },
  // second connection after the automatic reconnect: speaker numbering restarts at 0
  "goodkey#2": async (ws) => { ws.send(res([w("Great,", 0), w("thank", 0), w("you.", 0)], true, true)); },
  // translator stub throws for "Explode" and never answers for "Hang"
  "filekey#1": async (ws) => {
    for (const s of ["Hello from file.", "Explode now.", "Hang on.", "After that."]) {
      ws.send(res(s.split(" ").map((x) => w(x, 0)), true, true));
      await sleep(150);
    }
  },
  "hidkey#1": async (ws) => { ws.send(res([w("Still", 0), w("updating.", 0)], true, true)); },
  "nolkey#1": async (ws) => { ws.send(res([w("No", 0), w("translator", 0), w("here.", 0)], true, true)); },
  // answers once, then goes silent with the socket open (stalled server / half-open proxy)
  "stallkey#1": async (ws) => { ws.send(res([w("Before", 0), w("the", 0), w("stall.", 0)], true, true)); return "silent"; },
  "stallkey#2": async (ws) => { ws.send(res([w("Back", 0), w("again.", 0)], true, true)); },
  // network blip in the middle of a question; the next 3 handshakes fail (see upgrade handler)
  "blipkey#1": async (ws) => {
    ws.send(res([w("So", 0), w("how", 0), w("would", 0), w("you", 0)], true));
    await sleep(100);
    ws.send(res([w("handle", 0), w("a", 0), w("conflict", 0)], false));
    await sleep(600);
    ws.terminate();
    return "closed";
  },
  "blipkey#2": async (ws) => { ws.send(res([w("Welcome", 0), w("back.", 0)], true, true)); },
  // first connection closes; the next handshake hangs until the user clicks 立即重连
  "hangkey#1": async (ws) => { ws.send(res([w("Before", 0), w("hang.", 0)], true, true)); await sleep(300); ws.close(1011, "mock"); return "closed"; },
  "hangkey#2": async (ws) => { ws.send(res([w("After", 0), w("retry.", 0)], true, true)); },
  // a reply, then no messages (the network died under the socket) and a late reset before the stall watchdog
  "gapkey#1": async (ws) => { ws.send(res([w("Before", 0), w("the", 0), w("drop.", 0)], true, true)); setTimeout(() => ws.terminate(), 2500); return "silent"; },
  "gapkey#2": async (ws) => { ws.send(res([w("Back", 0), w("again.", 0)], true, true)); },
  // a non-fatal Error message, then results keep coming
  "errkey#1": async (ws) => {
    ws.send(JSON.stringify({ type: "Error", variant: "mock", description: "mock hiccup" }));
    await sleep(1200);
    ws.send(res([w("Still", 0), w("fine.", 0)], true, true));
  },
  "quietkey#1": async () => {},
  // own key on a page that also offers 授权码 mode
  "ownkey#1": async (ws) => { ws.send(res([w("Own", 0), w("key", 0), w("still", 0), w("works.", 0)], true, true)); },
};
const ACCEPT = /^(goodkey|filekey|nolkey|hidkey|stallkey|blipkey|hangkey|gapkey|errkey|quietkey|ownkey)$/;
const conns = [], attempts = {}, rejectedAt = [], hung = [];
let rejected = 0;
// the page as .github/workflows/pages.yml builds it when the ZhiYin server is known (same sed on the meta tag)
const META_EMPTY = '<meta name="zhiyin-server" content="" />';
let ZY_URL = "";
const http = createServer((req, resp) => {
  if (req.url.startsWith("/index.html")) { resp.writeHead(200, { "content-type": "text/html; charset=utf-8" }); resp.end(readFileSync(INDEX)); }
  else if (req.url.startsWith("/zhiyin.html")) {
    resp.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    resp.end(readFileSync(INDEX, "utf8").split("\n").map((l) => l.replace(META_EMPTY, `<meta name="zhiyin-server" content="${ZY_URL}" />`)).join("\n"));
  }
  else { resp.writeHead(404); resp.end(); }
});
const wss = new WebSocketServer({ noServer: true, handleProtocols: (set) => (set.has("token") ? "token" : false) });
http.on("upgrade", (req, sock, head) => {
  const protos = (req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim());
  const key = protos[0] === "token" ? protos[1] : null;
  const a = attempts[key] = (attempts[key] || 0) + 1;
  if (key === "hangkey" && a === 2) { hung.push({ sock, t: Date.now() }); return; } // never answer this handshake
  if (!key || !ACCEPT.test(key) || (key === "blipkey" && a >= 2 && a <= 4)) {
    rejected++; rejectedAt.push({ key, t: Date.now() });
    sock.end(`HTTP/1.1 ${key === "blipkey" ? "503 Service Unavailable" : "401 Unauthorized"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => {
    const n = conns.filter((c) => c.key === key).length + 1;
    const c = { key, n, url: new URL(req.url, "http://x"), protocol: ws.protocol, openedAt: Date.now(), bins: 0, head: null, json: [], closed: false };
    conns.push(c);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        c.bins++;
        if (!c.head) {
          c.head = Buffer.from(data).subarray(0, 4).toString("hex");
          Promise.resolve(SCRIPTS[`${key}#${n}`]?.(ws)).then((how) => {
            // like Deepgram while audio keeps coming: an empty final about once a second
            if (how === "silent" || how === "closed") return;
            const t = setInterval(() => (ws.readyState === 1 ? ws.send(res([], true)) : clearInterval(t)), 1000);
          });
        }
      } else {
        let m; try { m = JSON.parse(data.toString()); } catch { m = data.toString(); }
        c.json.push(m);
        if (m && m.type === "CloseStream") ws.close(1000);
      }
    });
    ws.on("close", () => { c.closed = true; c.closedAt = Date.now(); });
  });
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const PORT = http.address().port;
const DG = `ws://127.0.0.1:${PORT}/v1/listen`;
const pageUrl = (extra = "") => `http://127.0.0.1:${PORT}/index.html?dg=${encodeURIComponent(DG)}&fakeAudio=1${extra}`;

// ------------------------------------------------------------------ mock ZhiYin server (授权码 mode, spec §4.2)
// /api/config, /api/me, /api/register with CORS (the page is on another origin), and the /v1/listen relay:
// subprotocols ["zhiyin.v1", CODE], echo of zhiyin.v1 only, ZhiYinQuota notes, refusals as accept-then-close 4xxx.
// Codes are ZYZY-TEST-0000-<tag>; the tag picks the behaviour (see relayScript).
const ZCODE = (tag) => "ZYZY-TEST-0000-" + tag, ZCANON = (tag) => "ZYZYTEST0000" + tag;
const PAY = "微信：zhiyin-owner\n支付宝：138 0000 0000\n<b>付款后把截图发给店主</b>";
const PLANS = [{ id: "p1", name: "体验", minutes: 60, days: 7, price: "¥10" }, { id: "p2", name: "包月", minutes: 600, days: 30, price: "¥50" }];
const ME_LEFT = (9 * 60 + 12) * 60000 + 30000;
const zy = { cfg: 0, me: [], regs: [], regStatus: 201, preflight: 0, conns: [], attempts: {}, refused: [] };
const zhttp = createServer(async (req, resp) => {
  const origin = req.headers.origin, u = new URL(req.url, "http://x");
  if (origin) { resp.setHeader("Access-Control-Allow-Origin", origin); resp.setHeader("Vary", "Origin"); }
  resp.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    zy.preflight++;
    resp.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400" });
    resp.end(); return;
  }
  const send = (status, body) => { resp.writeHead(status, { "content-type": "application/json; charset=utf-8" }); resp.end(JSON.stringify(body)); };
  if (u.pathname === "/api/config") { zy.cfg++; send(200, { service: "zhiyin", version: 1, registration_open: true, pay_text: PAY, plans: PLANS }); return; }
  if (u.pathname === "/api/me") {
    const code = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    zy.me.push(code);
    const left = code === ZCANON("4402") ? 0 : ME_LEFT; // 4402: used up (the relay refuses it the same way)
    if (/^ZYZYTEST0000\w{4}$/.test(code) && code !== ZCANON("0404") && code !== ZCANON("4401"))
      send(200, { status: "active", quota_ms: 600 * 60000, used_ms: 600 * 60000 - left, expires_at: Date.now() + 30 * 86400000, remaining_ms: left, live: false });
    else send(401, { error: "unknown_code", message: "授权码无效" });
    return;
  }
  if (u.pathname === "/api/register" && req.method === "POST") {
    let text = ""; for await (const ch of req) text += ch;
    const body = JSON.parse(text);
    zy.regs.push(body);
    if (zy.regStatus === 429) send(429, { error: "rate_limited", message: "申请太频繁，请一小时后再试" });
    else send(201, { ref: "R7K3MQ", pay_text: PAY, plan: PLANS.find((p) => p.id === body.plan_id) ?? null });
    return;
  }
  send(404, { error: "not_found" });
});
const zwss = new WebSocketServer({ noServer: true, handleProtocols: (set) => (set.has("zhiyin.v1") ? "zhiyin.v1" : false) });
async function relayScript(tag, n, ws, c, quota) {
  const say = (s) => { if (ws.readyState === 1) ws.send(res(s.split(" ").map((x) => w(x, 0)), true, true)); };
  const every = (ms, f) => { const t = setInterval(() => (ws.readyState === 1 ? f() : clearInterval(t)), ms); };
  if (tag === "0002" && n === 1) { say("Before the stall."); every(500, () => quota(5 * 60000)); return; } // recognizer stalled, quota notes go on
  if (/^44(0[0129])$/.test(tag) && n === 1) { say(`Line before ${tag}.`); await sleep(400); ws.close(+tag, "mock"); return; }
  if (tag === "1011" && n === 1) { say("Before 1011."); await sleep(400); ws.close(1011, "speech service unavailable"); return; }
  say({ "0001": "Hello from the relay.", "0002": "Back after the stall.", "1011": "After 1011.", "4429": "After 4429.", "4503": "After 4503." }[tag] || `Again ${tag}.`);
  every(1000, () => ws.send(res([], true)));
  if (tag === "0001") every(2000, () => quota(5 * 60000));
}
zhttp.on("upgrade", (req, sock, head) => {
  const protos = (req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim());
  const code = protos[0] === "zhiyin.v1" ? protos[1] || "" : "";
  zy.attempts[code] = (zy.attempts[code] || 0) + 1;
  if (!code || code.endsWith("0503")) { // no code (HTTP 401) / server unreachable for this code (HTTP 503): the page never sees "open"
    zy.refused.push({ code, t: Date.now() });
    sock.end(`HTTP/1.1 ${code ? "503 Service Unavailable" : "401 Unauthorized"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    return;
  }
  zwss.handleUpgrade(req, sock, head, (ws) => {
    const tag = code.slice(-4), n = zy.conns.filter((x) => x.code === code).length + 1;
    const c = { code, n, offered: protos, protocol: ws.protocol, origin: req.headers.origin, url: new URL(req.url, "http://x"), openedAt: Date.now(), head: null, json: [], quotas: 0, closed: false };
    zy.conns.push(c);
    ws.on("close", () => { c.closed = true; c.closedAt = Date.now(); });
    const quota = (ms) => { if (ws.readyState === 1) { ws.send(JSON.stringify({ type: "ZhiYinQuota", remaining_ms: ms, expires_at: Date.now() + 30 * 86400000 })); c.quotas++; } };
    if (!code.startsWith("ZYZYTEST0000")) { ws.close(4401, "unknown access code"); return; }
    if ((tag === "4429" || tag === "4503") && n === 1) { ws.close(+tag, "mock refusal"); return; } // accept, then refuse
    quota(5.5 * 60000); // at open, like the server
    ws.on("message", (data, isBinary) => {
      if (isBinary) { if (!c.head) { c.head = Buffer.from(data).subarray(0, 4).toString("hex"); relayScript(tag, n, ws, c, quota); } return; }
      let m; try { m = JSON.parse(data.toString()); } catch { m = data.toString(); }
      c.json.push(m);
      if (m && m.type === "CloseStream") ws.close(1000);
    });
  });
});
await new Promise((r) => zhttp.listen(0, "127.0.0.1", r));
ZY_URL = `http://127.0.0.1:${zhttp.address().port}`;
const codeUrl = (extra = "", server = ZY_URL) => `http://127.0.0.1:${PORT}/index.html?server=${encodeURIComponent(server)}&fakeAudio=1${extra}`;
async function waitFor(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return !!fn(); }

// ------------------------------------------------------------------ browser
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const TRANSLATOR_STUB = () => {
  self.Translator = {
    availability: async (o) => (o.sourceLanguage === "en" && o.targetLanguage === "zh" ? "downloadable" : "unavailable"),
    create: async (o) => {
      const listeners = [];
      o.monitor?.({ addEventListener: (_n, f) => listeners.push(f) });
      for (const p of [0, 0.5, 1]) { listeners.forEach((f) => f({ loaded: p })); await new Promise((r) => setTimeout(r, 30)); }
      return {
        translate: (t) => {
          if (/Explode/.test(t)) throw new Error("boom");          // synchronous throw
          if (/Hang/.test(t)) return new Promise(() => {});         // never settles
          return new Promise((r) => setTimeout(() => r("【译】" + t), 40));
        },
      };
    },
  };
};
const errors = [];
async function newPage({ stub = true, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 900, height }, acceptDownloads: true });
  if (stub) await ctx.addInitScript(TRANSLATOR_STUB);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { errors.push(e.message); console.log("pageerror:", e.message); });
  return page;
}
const textLines = (page) => page.evaluate(() => window.__lcl.lines().filter((l) => l.kind === "text").map((l) => ({ src: l.src, zh: l.zh, zhState: l.zhState, cut: l.cut })));
const shown = (page) => page.$$eval("#captions .line:not(.interim)", (ls) => ls.map((l) => ({
  gap: l.classList.contains("gap"), who: l.querySelector(".who")?.textContent || "", zh: l.querySelector(".zh")?.textContent || "", src: l.querySelector(".src")?.textContent || "",
})));
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true, () => false);
const pipText = (page, id) => page.evaluate((id) => { const w = window.documentPictureInPicture?.window; const e = w && w.document.getElementById(id); return e ? (e.classList.contains("hidden") ? "" : e.textContent) : null; }, id);
async function openPip(page) {
  if (!(await page.evaluate(() => "documentPictureInPicture" in window))) return false;
  await page.click("#pipBtn");
  return until(page, () => !!window.documentPictureInPicture.window, null, 5000);
}

// ---- A: happy path over http (two speakers, provisional translation, reconnect, scroll, PiP, export, stop sharing)
{
  const page = await newPage({ height: 560 });
  await page.goto(pageUrl());
  await page.fill("#key", "goodkey");
  await page.selectOption("#diarize", "1");
  await page.click("#prepBtn");
  check("translator prepared via click (download progress shown)", await until(page, () => /翻译已就绪/.test(document.getElementById("prepMsg").textContent), null, 5000));
  const sawInterimZh = until(page, () => /【译】Could you introduce/.test(document.querySelector("#captions .line.interim .zh:not(.pending)")?.textContent || ""), null, 8000);
  await page.click("#startBtn");
  check("settings locked while running", await page.isDisabled("#srcLang"));
  await until(page, () => window.__lcl.lines().filter((l) => l.kind === "text" && l.zhState === "ok").length >= 3, null, 15000);
  check("provisional translation of the unfinished sentence is shown", await sawInterimZh);
  await sleep(300);
  const rows = await shown(page);
  for (const r of rows) console.log("   ", JSON.stringify(r));
  const txt = rows.filter((r) => !r.gap);
  check("3 lines committed (speech_final, UtteranceEnd, after reconnect)", txt.length === 3, `got ${txt.length}`);
  check("line 1 text + translation", txt[0]?.src === "Could you introduce yourself briefly?" && txt[0]?.zh === "【译】Could you introduce yourself briefly?");
  check("line 2 is second speaker, committed by UtteranceEnd", txt[1]?.src === "And your notice period?" && txt[1]?.who === "说话人 2");
  check("speaker labels: reconnect gets a fresh label", txt[0]?.who === "说话人 1" && txt[2]?.who === "说话人 3", txt.map((r) => r.who).join(","));
  check("gap marker after the reconnect (sound during the outage)", rows.findIndex((r) => r.gap) === 2, rows.map((r) => (r.gap ? "GAP" : "line")).join(","));
  const [c1, c2] = conns.filter((c) => c.key === "goodkey");
  check("auth via WebSocket subprotocol ['token', key]", c1?.protocol === "token");
  check("query params sent", c1?.url.searchParams.get("model") === "nova-3" && c1?.url.searchParams.get("language") === "en" && c1?.url.searchParams.get("diarize") === "true" && c1?.url.searchParams.get("interim_results") === "true");
  check("each connection starts with a WebM/EBML header", c1?.head === "1a45dfa3" && c2?.head === "1a45dfa3", `${c1?.head} ${c2?.head}`);
  check("reconnected quickly after a server close", !!c2 && c2.openedAt - c1.closedAt < 2000, c2 ? `${c2.openedAt - c1.closedAt} ms` : "");

  // scrolling back to re-read a question survives incoming messages
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(2500); // the mock sends an empty result every second
  check("main list does not jump to the bottom while the user reads back", (await page.evaluate(() => window.scrollY)) === 0);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  // PiP
  if (await openPip(page)) {
    const capsOk = await until(page, () => window.documentPictureInPicture.window.document.querySelectorAll("#pipCaps .line").length >= 3, null, 5000);
    const status = await pipText(page, "pipStatus");
    check("floating window: captions + live status + screen-share warning", capsOk && /正在收听/.test(status) && /共享屏幕/.test(await page.textContent("#pipWarn")), status);
    check("floating window: no alarm while healthy", (await pipText(page, "pipBanner")) === "");
  } else console.log("SKIP  PiP not available in this Chromium");

  // export
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  const exported = readFileSync(await dl.path(), "utf8");
  check("transcript download: source + translation + gap note, local-time name", /Could you introduce yourself briefly\?/.test(exported) && /【译】And your notice period\?/.test(exported) && /连接中断/.test(exported) && /^zhiyin-\d{4}-\d\d-\d\d-\d{4}\.txt$/.test(dl.suggestedFilename()), dl.suggestedFilename());

  await page.screenshot({ path: `${OUT}/lite-captions.png` });
  await sleep(5600);
  check("KeepAlive sent while connected", c2.json.some((m) => m.type === "KeepAlive"));

  // the user clicks Chrome's "停止共享" by mistake: the floating window must say captions stopped
  await page.evaluate(() => window.__lcl.capture().audio.dispatchEvent(new Event("ended")));
  await sleep(600);
  check("stop sends CloseStream and the server closes", c2.json.some((m) => m.type === "CloseStream") && c2.closed);
  check("status + tab title show stopped", (await page.textContent("#status")) === "已停止" && /已停止/.test(await page.title()));
  const banner = await pipText(page, "pipBanner");
  if (banner !== null) check("floating window alarms after 停止共享", /字幕已停止/.test(banner) && /停止共享/.test(banner), banner);
  const links = await page.$$eval("#dgSignup, #dgConsole", (as) => as.map((a) => [a.href, a.target, a.rel]));
  check("Deepgram buttons open signup and console in a new tab",
    links.length === 2 && links[0][0] === "https://console.deepgram.com/signup" && links[1][0] === "https://console.deepgram.com/" && links.every((l) => l[1] === "_blank" && /noopener/.test(l[2])), JSON.stringify(links));
  const usage = await page.evaluate(() => [+localStorage.getItem("lcl.usageMs"), document.getElementById("usage").textContent]);
  check("local usage estimate counts audio sent and shows it", usage[0] >= 5000 && /累计用了(不到 1|约 \d+) 分钟，约 \$\d+\.\d\d/.test(usage[1]), JSON.stringify(usage));
  await page.context().close();
}

// ---- B: wrong key -> clear message, keeps retrying with backoff
{
  const page = await newPage();
  await page.goto(pageUrl());
  await page.fill("#key", "wrongkey");
  await page.click("#startBtn");
  const msg = await page.waitForFunction(() => document.getElementById("err").textContent, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => "");
  check("bad key -> actionable error", /Key/.test(msg) && /余额/.test(msg), msg);
  await sleep(3000);
  check("bad key -> retries with backoff", rejected >= 2, `rejected=${rejected}`);
  await page.click("#stopBtn");
  const before = rejected + conns.length;
  await page.fill("#key", "abc，def-ghi xyz");                 // full-width comma: copied from a chat app
  await page.click("#startBtn");
  const err2 = await page.textContent("#err");
  check("malformed key -> format error, key not echoed, no connection", /格式不对/.test(err2) && !/abc/.test(err2) && rejected + conns.length === before, err2);
  await page.fill("#key", "  Token good\u3000key\u00a0 ");      // "Token " prefix, full-width space, NBSP
  const goodBefore = conns.filter((c) => c.key === "goodkey").length;
  await page.click("#startBtn");
  const normalised = await until(page, (n) => document.getElementById("key").value === "goodkey" && document.getElementById("status").textContent === "\u6b63\u5728\u6536\u542c", null, 5000);
  check("key normalisation strips 'Token ' and spaces", normalised && conns.filter((c) => c.key === "goodkey").length === goodBefore + 1);
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- C: opened straight from disk (file://); a throwing and a hanging translation don't block later lines
{
  const page = await newPage();
  await page.goto(pathToFileURL(INDEX).href + `?dg=${encodeURIComponent(DG)}&fakeAudio=1&trTimeout=1500`);
  await page.fill("#key", "filekey");
  await page.click("#startBtn");
  const ok = await until(page, () => window.__lcl.lines().filter((l) => l.zhState !== "pending").length >= 4, null, 10000);
  const tl = await textLines(page);
  console.log("   ", JSON.stringify(tl.map((l) => [l.src, l.zhState])));
  check("file:// works: capture -> Deepgram -> translated line", ok && tl[0]?.zh === "【译】Hello from file.");
  check("translation that throws -> 翻译失败, queue continues", tl[1]?.zhState === "error");
  check("translation that hangs -> times out, queue continues", tl[2]?.zhState === "error" && tl[3]?.zh === "【译】After that.");
  await page.click("#stopBtn");
  await page.reload();
  check("key remembered after reload", (await page.inputValue("#key")) === "filekey");
  await page.context().close();
}

// ---- D: real Chromium Translator (no stub): must still show the English, with an explanation
{
  const page = await newPage({ stub: false });
  await page.goto(pageUrl());
  console.log("   real Translator in this Chromium:", await page.evaluate(async () => {
    if (!self.Translator) return "absent";
    try { return await self.Translator.availability({ sourceLanguage: "en", targetLanguage: "zh" }); } catch (e) { return "error " + e.message; }
  }));
  console.log("   prepMsg on load:", await page.textContent("#prepMsg"));
  await page.fill("#key", "nolkey");
  await page.click("#startBtn");
  check("without a translator the English still shows", await until(page, () => /No translator here\./.test(document.querySelector("#captions .line:not(.interim) .src")?.textContent || ""), null, 8000));
  check("…and says the translation is not ready", /翻译未就绪/.test(await page.textContent("#captions .line:not(.interim) .zh")));
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- E: page hidden behind Feishu (Chrome stops requestAnimationFrame) + double click on start
{
  const page = await newPage();
  await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
  await page.goto(pageUrl());
  await page.fill("#key", "hidkey");
  await page.evaluate(() => { const b = document.getElementById("startBtn"); b.click(); b.click(); });
  check("captions update without requestAnimationFrame (occluded window)",
    await until(page, () => /【译】Still updating\./.test(document.querySelector("#captions .line:not(.interim) .zh")?.textContent || ""), null, 8000));
  await sleep(1000);
  check("double click on start opens one stream", conns.filter((c) => c.key === "hidkey").length === 1);
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- F: server stops answering while audio keeps flowing -> watchdog reconnects, gap marked
{
  const page = await newPage();
  await page.goto(pageUrl("&stall=3000"));
  await page.fill("#key", "stallkey");
  await page.click("#startBtn");
  const back = await until(page, () => window.__lcl.lines().some((l) => l.src === "Back again."), null, 12000);
  const kinds = await page.evaluate(() => window.__lcl.lines().map((l) => l.kind + ":" + l.src.slice(0, 12)));
  check("stalled connection is detected and replaced", back && conns.filter((c) => c.key === "stallkey").length === 2, kinds.join(" | "));
  check("stall leaves a gap marker", kinds.some((k) => k.startsWith("gap:")));
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- G: network blip mid-question after the key worked: keep the visible text, retry fast, alarm in PiP
{
  const page = await newPage();
  await page.goto(pageUrl());
  await page.fill("#key", "blipkey");
  await page.click("#prepBtn");
  await until(page, () => /翻译已就绪/.test(document.getElementById("prepMsg").textContent), null, 5000);
  const pip = await openPip(page);
  await page.click("#startBtn");
  const cutOk = await until(page, () => window.__lcl.lines().some((l) => l.cut && l.src === "So how would you handle a conflict" && l.zhState === "ok"), null, 8000);
  check("text on screen when the connection dropped is kept, marked and translated", cutOk);
  await sleep(1500);
  check("after the key worked, a failed handshake reads as network, not Key", /网络中断/.test(await page.textContent("#err")), await page.textContent("#err"));
  if (pip) {
    await sleep(1600);
    const b = await pipText(page, "pipBanner");
    check("floating window alarms during the outage, with a retry button", !!b && b.length > 0 && (await pipText(page, "pipRetry")) === "立即重连", b);
  }
  const back = await until(page, () => window.__lcl.lines().some((l) => l.src === "Welcome back."), null, 12000);
  const [b1, b2] = conns.filter((c) => c.key === "blipkey");
  check("reconnects within ~8 s of a 3-attempt outage (short capped backoff)", back && b2 && b2.openedAt - b1.closedAt < 9500, b2 ? `${b2.openedAt - b1.closedAt} ms` : "no reconnect");
  await sleep(300);
  if (pip) check("alarm clears after reconnect", (await pipText(page, "pipBanner")) === "");
  await page.screenshot({ path: `${OUT}/lite-blip.png` });
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- H: connected but the captured audio is silent (headset switched device): yellow, non-dimming notice in PiP
{
  const page = await newPage();
  await page.goto(pageUrl("&silence=1500").replace("fakeAudio=1", "fakeAudio=silent"));
  await page.fill("#key", "quietkey");
  const pip = await openPip(page);
  await page.click("#startBtn");
  await sleep(2500);
  if (pip) {
    const st = await page.evaluate(() => { const d = window.documentPictureInPicture.window.document;
      return { banner: d.getElementById("pipBanner").className + "|" + d.getElementById("pipBannerText").textContent, stale: d.body.classList.contains("stale"), dot: d.getElementById("pipDot").className }; });
    check("silent capture -> yellow notice in floating window, captions not dimmed", /warn/.test(st.banner) && /没有会议声音/.test(st.banner) && !st.stale && /wait/.test(st.dot), JSON.stringify(st));
  }
  check("silent capture -> tab title says so", /没有会议声音/.test(await page.title()), await page.title());
  await page.evaluate(() => window.__lcl.setFakeLevel(1));
  await sleep(600);
  if (pip) check("notice clears when audio comes back", (await pipText(page, "pipBanner")) === "");
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- I: handshake hangs after a drop; 立即重连 abandons it and connects at once
{
  const page = await newPage();
  await page.goto(pageUrl());
  await page.fill("#key", "hangkey");
  await page.click("#startBtn");
  await until(page, () => window.__lcl.lines().some((l) => l.src === "Before hang."), null, 8000);
  await until(page, () => !document.getElementById("retryBtn").classList.contains("hidden"), null, 5000);
  await sleep(1500); // the second handshake is hanging now
  const t0 = Date.now();
  await page.click("#retryBtn");
  const ok = await until(page, () => window.__lcl.lines().some((l) => l.src === "After retry."), null, 5000);
  check("立即重连 during a hung handshake reconnects at once", ok && hung.length === 1 && Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- J: speech, then the socket dies quietly and resets later: the gap marker still covers the lost speech
{
  const page = await newPage();
  await page.goto(pageUrl());
  await page.fill("#key", "gapkey");
  await page.click("#startBtn");
  await until(page, () => window.__lcl.lines().some((l) => l.src === "Before the drop."), null, 8000);
  await sleep(1000);
  await page.evaluate(() => window.__lcl.setFakeLevel(0)); // the question ended before the reset arrived
  const back = await until(page, () => window.__lcl.lines().some((l) => l.src === "Back again."), null, 10000);
  const kinds = await page.evaluate(() => window.__lcl.lines().map((l) => l.kind));
  check("late reset after speech -> gap marker", back && kinds.join(",") === "text,gap,text", kinds.join(","));
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- K: a Deepgram Error message the stream survives is shown, then cleared when results flow again
{
  const page = await newPage();
  await page.goto(pageUrl());
  await page.fill("#key", "errkey");
  await page.click("#startBtn");
  const shownErr = await until(page, () => /mock hiccup/.test(document.getElementById("err").textContent), null, 5000);
  const cleared = await until(page, () => window.__lcl.lines().some((l) => l.src === "Still fine.") && document.getElementById("err").textContent === "", null, 5000);
  check("non-fatal Deepgram Error shown, then cleared", shownErr && cleared);
  await page.click("#stopBtn");
  check("stop clears stale error text", (await page.textContent("#err")) === "");
  await page.context().close();
}

// ================================================================== 授权码 (access code) mode, spec §11.4 (a)-(k)
const shownIds = (page, ids) => Promise.all(ids.map((id) => page.isVisible("#" + id)));
const relayConns = (tag) => zy.conns.filter((x) => x.code === ZCANON(tag));

// ---- (a) no server configured: the page is exactly the own-key page (all checks above ran this way)
{
  const page = await newPage();
  const reqs = []; page.on("request", (r) => reqs.push(r.url()));
  await page.goto(pageUrl());
  const [mode, codePane, keyPane, dlg] = await shownIds(page, ["modeBox", "codePane", "keyPane", "regDlg"]);
  check("(a) no server configured: no mode choice / 授权码 UI, key pane as before", !mode && !codePane && keyPane && !dlg && (await page.evaluate(() => window.__lcl.server())) === "");
  check("(a) no server configured: no /api calls", !reqs.some((u) => u.includes("/api/")), reqs.filter((u) => u.includes("/api/")).join(" "));
  await page.context().close();
}
// ?dg= is a test hook too: anything but localhost is ignored, so a link cannot send a friend's own key elsewhere
{
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  await ctx.addInitScript(() => {
    const W = window.WebSocket; window.__wsUrls = [];
    window.WebSocket = function (u, p) { window.__wsUrls.push(String(u)); return new W("ws://127.0.0.1:9/", p); }; // record, never reach out
    window.WebSocket.prototype = W.prototype;
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { errors.push(e.message); console.log("pageerror:", e.message); });
  await page.goto(`http://127.0.0.1:${PORT}/index.html?dg=${encodeURIComponent("wss://evil.example/v1/listen")}&fakeAudio=1`);
  await page.fill("#key", "goodkey");
  await page.click("#startBtn");
  await until(page, () => window.__wsUrls.length > 0, null, 5000);
  const u = await page.evaluate(() => window.__wsUrls[0] || "");
  check("?dg=wss://evil.example is ignored: the key only goes to Deepgram", u.startsWith("wss://api.deepgram.com/v1/listen?"), u.slice(0, 60));
  await page.click("#stopBtn");
  await ctx.close();
}

// ---- (b) ?server=http://127.0.0.1:P -> mode choice shown, 授权码 is the default; (d) registration dialog
{
  const page = await newPage();
  const cfg0 = zy.cfg;
  await page.goto(codeUrl());
  const [mode, codePane, keyPane] = await shownIds(page, ["modeBox", "codePane", "keyPane"]);
  const checked = await page.evaluate(() => document.querySelector('input[name="mode"]:checked')?.value);
  check("(b) ?server=http://127.0.0.1:P -> mode choice shown, 授权码 is the default", mode && codePane && !keyPane && checked === "code", JSON.stringify([mode, codePane, keyPane, checked]));
  check("(b) /api/config loaded over CORS", await waitFor(() => zy.cfg > cfg0, 5000));

  await page.click("#regBtn");
  const opened = await until(page, () => document.getElementById("regDlg").open && document.querySelectorAll("#regPlan option").length === 2, null, 5000);
  const opts = await page.$$eval("#regPlan option", (os) => os.map((o) => o.textContent));
  check("(d) 申请 opens the dialog with the plans from /api/config", opened && opts[1] === "包月 · 600 分钟（30 天内有效） · ¥50", JSON.stringify(opts));
  const hp = await page.evaluate(() => { const i = document.getElementById("regWebsite"); const box = i.closest(".hp").getBoundingClientRect();
    return { tab: i.tabIndex, hidden: i.closest("[aria-hidden=true]") !== null, w: box.width, h: box.height, clip: getComputedStyle(i.closest(".hp")).clipPath }; });
  check("(d) honeypot field is out of sight and out of the tab order", hp.tab === -1 && hp.hidden && hp.w <= 1 && hp.h <= 1 && /inset/.test(hp.clip), JSON.stringify(hp));
  await page.screenshot({ path: `${OUT}/register-form.png` });
  const regs0 = zy.regs.length;
  await page.click("#regSubmit");
  check("(d) empty form -> asks for 称呼, nothing sent", /称呼/.test(await page.textContent("#regErr")) && zy.regs.length === regs0, await page.textContent("#regErr"));
  await page.fill("#regName", "小王");
  await page.fill("#regContact", "wx_xiaowang");
  await page.selectOption("#regPlan", "p2");
  await page.fill("#regNote", "付款人 王小明");
  await page.click("#regSubmit");
  const done = await until(page, () => !document.getElementById("regDoneView").classList.contains("hidden"), null, 5000);
  const sent = zy.regs.at(-1);
  check("(d) submit posts name / contact / plan / note with an empty honeypot", done && sent?.name === "小王" && sent.contact === "wx_xiaowang" && sent.plan_id === "p2" && sent.note === "付款人 王小明" && sent.website === "", JSON.stringify(sent));
  const r = await page.evaluate(() => { const p = document.getElementById("regPay");
    return { ref: document.getElementById("regRef").textContent, pay: p.textContent, tags: p.querySelectorAll("*").length, ws: getComputedStyle(p).whiteSpace,
             plan: document.getElementById("regPlanOut").textContent, note: document.querySelector("#regDoneView .note").textContent }; });
  check("(d) result: 申请编号, plan + price, payment text as plain text with its line breaks",
    r.ref === "R7K3MQ" && r.pay === PAY && r.tags === 0 && r.ws === "pre-wrap" && /包月.*¥50/.test(r.plan) && /备注申请编号/.test(r.note), JSON.stringify(r));
  await page.screenshot({ path: `${OUT}/register-done.png` });
  await page.click("#regClose");
  const ref = await page.evaluate(() => [document.getElementById("regInfo").textContent, localStorage.getItem("lcl.regRef"), document.getElementById("regDlg").open]);
  check("(d) after closing: 「你的申请编号 R…（待店主确认）」 is kept on the page", ref[0] === "你的申请编号 R7K3MQ（待店主确认）" && ref[1] === "R7K3MQ" && !ref[2], JSON.stringify(ref));
  zy.regStatus = 429;
  await page.click("#regBtn");
  await until(page, () => document.getElementById("regDlg").open && !document.getElementById("regFormView").classList.contains("hidden"), null, 5000);
  await page.click("#regSubmit");
  const tooMany = await until(page, () => /太频繁/.test(document.getElementById("regErr").textContent), null, 5000);
  check("(d) 429 from /api/register -> 提交太频繁，请 1 小时后再试", tooMany, await page.textContent("#regErr"));
  zy.regStatus = 201;
  await page.keyboard.press("Escape");
  await page.reload();
  const kept = await page.textContent("#regInfo");
  await page.fill("#code", ZCODE("0001")); // the owner sent the code
  const cleared = await until(page, () => document.getElementById("regInfo").textContent === "" && !localStorage.getItem("lcl.regRef") && /^剩余/.test(document.getElementById("codeInfo").textContent), null, 5000);
  check("(d) 申请编号 survives a reload; a newly entered working code clears it", kept === "你的申请编号 R7K3MQ（待店主确认）" && cleared, kept);
  await page.context().close();
}
// the build-time meta (what pages.yml writes) turns the mode on the same way
{
  const page = await newPage();
  await page.goto(`http://127.0.0.1:${PORT}/zhiyin.html?fakeAudio=1`);
  const html = readFileSync(INDEX, "utf8");
  check("(b) pages.yml's sed target occurs exactly once; the filled meta turns 授权码 mode on",
    html.split(META_EMPTY).length === 2 && (await page.isVisible("#modeBox")) && (await page.evaluate(() => window.__lcl.server())) === ZY_URL);
  await page.context().close();
}

// ---- (c) ?server= pointing anywhere but localhost is ignored
{
  const page = await newPage();
  const reqs = []; page.on("request", (r) => reqs.push(r.url()));
  await page.goto(codeUrl("", "https://evil.example"));
  await sleep(300);
  check("(c) ?server=https://evil.example is ignored (no mode choice, no request to it)",
    !(await page.isVisible("#modeBox")) && (await page.isVisible("#keyPane")) && !reqs.some((u) => new URL(u).hostname.endsWith("evil.example")), reqs.join(" "));
  await page.context().close();
}

// ---- (e) code-mode start; (j) code mode never writes lcl.usageMs
{
  const page = await newPage({ height: 760 });
  await page.goto(codeUrl());
  await page.fill("#code", "zyzy test oooo ooo1"); // as typed by hand: lower case, spaces, letter O for zero
  const info = await until(page, () => /^剩余 9 小时 12 分 · 有效期至 \d{4}-\d\d-\d\d$/.test(document.getElementById("codeInfo").textContent), null, 5000);
  check("(e) typing a complete code looks it up: /api/me with Bearer <normalised code>, remaining shown", info && zy.me.at(-1) === ZCANON("0001") && zy.preflight > 0, await page.textContent("#codeInfo"));
  await page.locator("#code").blur();
  check("(e) leaving the field tidies the code", (await page.inputValue("#code")) === "ZYZY-TEST-0000-0001");
  await page.click("#prepBtn");
  await until(page, () => /翻译已就绪/.test(document.getElementById("prepMsg").textContent), null, 5000);
  await page.screenshot({ path: `${OUT}/code-mode.png` });
  await page.click("#startBtn");
  const ok = await until(page, () => window.__lcl.lines().some((l) => l.src === "Hello from the relay." && l.zh === "【译】Hello from the relay."), null, 8000);
  const c = relayConns("0001")[0];
  check("(e) captions + translation arrive through the relay", ok);
  check("(e) subprotocols ['zhiyin.v1', normalised code]; the server's zhiyin.v1 echo is accepted", c?.offered.join(",") === "zhiyin.v1,ZYZYTEST00000001" && c.protocol === "zhiyin.v1", c && c.offered.join(","));
  check("(e) URL is /v1/listen with only lang and diarize", c?.url.pathname === "/v1/listen" && [...c.url.searchParams.keys()].join() === "lang,diarize" && c.url.searchParams.get("lang") === "en" && c.url.searchParams.get("diarize") === "0", c && c.url.search);
  check("(e) Origin is the page's; audio starts with a WebM header", c?.origin === `http://127.0.0.1:${PORT}` && c.head === "1a45dfa3", c && `${c.origin} ${c.head}`);
  const q = await until(page, () => /^剩余 5 分钟 · 有效期至/.test(document.getElementById("codeInfo").textContent) && document.getElementById("quotaWarn").textContent === "授权码剩余约 5 分钟", null, 6000);
  check("(e) ZhiYinQuota updates the remaining time; under 10 minutes it warns", q, `${await page.textContent("#codeInfo")} | ${await page.textContent("#quotaWarn")}`);
  const locked = await page.evaluate(() => ["code", "srcLang", "diarize"].every((id) => document.getElementById(id).disabled) && [...document.querySelectorAll('input[name="mode"]')].every((r) => r.disabled));
  check("(e) code, mode choice and languages locked while running", locked);
  await page.screenshot({ path: `${OUT}/code-running.png` });
  await sleep(Math.max(0, c.openedAt + 5600 - Date.now()));
  check("(e) KeepAlive goes through the relay", c.json.some((m) => m.type === "KeepAlive"));
  const me0 = zy.me.length;
  await page.click("#stopBtn");
  await sleep(800);
  check("(e) stop: CloseStream through the relay, then /api/me refreshes the remaining time",
    c.json.some((m) => m.type === "CloseStream") && c.closed && zy.me.length > me0 && /^剩余 9 小时 12 分/.test(await page.textContent("#codeInfo")), await page.textContent("#codeInfo"));
  const st = await page.evaluate(() => ({ usage: localStorage.getItem("lcl.usageMs"), usageText: document.getElementById("usage").textContent, code: localStorage.getItem("lcl.code"),
    warn: document.getElementById("quotaWarn").textContent, unlocked: !document.getElementById("code").disabled }));
  check("(j) code mode never writes lcl.usageMs (the server meters the minutes)", st.usage === null && st.usageText === "", JSON.stringify(st));
  check("(e) after stop: code stored normalised, warning cleared, inputs unlocked", st.code === ZCANON("0001") && st.warn === "" && st.unlocked, JSON.stringify(st));
  await page.reload();
  check("(e) a stored code is looked up on load", (await page.inputValue("#code")) === "ZYZY-TEST-0000-0001" &&
    await until(page, () => /^剩余 9 小时 12 分/.test(document.getElementById("codeInfo").textContent), null, 5000));
  await page.context().close();
}

// ---- (f) a server that keeps sending ZhiYinQuota but no results still trips the stall watchdog
{
  const page = await newPage();
  await page.goto(codeUrl("&stall=3000"));
  await page.fill("#code", ZCODE("0002"));
  await page.click("#startBtn");
  const back = await until(page, () => window.__lcl.lines().some((l) => l.src === "Back after the stall."), null, 15000);
  const cs = relayConns("0002");
  check("(f) only ZhiYinQuota coming in -> stall detected, reconnected", back && cs.length === 2 && cs[0].quotas >= 5, `conns=${cs.length} quotas=${cs[0]?.quotas}`);
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- (g) 4402 / 4409 / 4401 -> stop for good with a clear message, no reconnect within 10 s
{
  const tags = ["4402", "4409", "4401"], want = { 4402: /时长已用完或已到期/, 4409: /另一个页面或设备/, 4401: /授权码无效或已停用/ };
  const pages = await Promise.all(tags.map(() => newPage()));
  await Promise.all(pages.map(async (p, i) => { await p.goto(codeUrl()); await p.fill("#code", ZCODE(tags[i])); await p.click("#startBtn"); }));
  const pip = await openPip(pages[0]);
  const stopped = await Promise.all(pages.map((p) => until(p, () => document.getElementById("status").textContent === "已停止" && document.getElementById("err").textContent !== "", null, 8000)));
  if (pip) { const b = await pipText(pages[0], "pipBanner"); check("(g) floating window says why it stopped", /字幕已停止：授权码的时长已用完/.test(b || ""), b); }
  check("(g) after the stop, /api/me shows the used-up code in red", await until(pages[0], () => /^授权码的时长已用完/.test(document.getElementById("codeInfo").textContent) && document.getElementById("codeInfo").classList.contains("err"), null, 5000), await pages[0].textContent("#codeInfo"));
  await pages[0].screenshot({ path: `${OUT}/code-stopped-4402.png` });
  await sleep(10000);
  for (let i = 0; i < tags.length; i++) {
    const s = await pages[i].evaluate(() => ({ err: document.getElementById("err").textContent, status: document.getElementById("status").textContent,
      start: !document.getElementById("startBtn").classList.contains("hidden"), running: window.__lcl.ui().running, kept: window.__lcl.lines().map((l) => l.src).join("|") }));
    check(`(g) ${tags[i]} -> stopped with a clear message, no reconnect within 10 s`,
      stopped[i] && want[tags[i]].test(s.err) && s.status === "已停止" && s.start && !s.running && zy.attempts[ZCANON(tags[i])] === 1 && s.kept.includes(`Line before ${tags[i]}.`), JSON.stringify({ ...s, attempts: zy.attempts[ZCANON(tags[i])] }));
  }
  await Promise.all(pages.map((p) => p.context().close()));
}

// ---- (h) 4429 / 4503 -> wait (shortened by ?relayBackoff=), then retry
{
  const tags = ["4429", "4503"], want = { 4429: /服务器繁忙/, 4503: /识别服务暂停，请联系店主/ };
  const pages = await Promise.all(tags.map(() => newPage()));
  await Promise.all(pages.map(async (p, i) => { await p.goto(codeUrl("&relayBackoff=1500")); await p.fill("#code", ZCODE(tags[i])); await p.click("#startBtn"); }));
  const msgs = await Promise.all(pages.map((p, i) => until(p, (re) => new RegExp(re).test(document.getElementById("err").textContent), want[tags[i]].source, 5000)));
  const back = await Promise.all(pages.map((p, i) => until(p, (t) => window.__lcl.lines().some((l) => l.src === `After ${t}.`), tags[i], 8000)));
  for (let i = 0; i < tags.length; i++) {
    const cs = relayConns(tags[i]), gap = cs[1] && cs[0].closedAt ? cs[1].openedAt - cs[0].closedAt : -1;
    const err = await pages[i].textContent("#err");
    check(`(h) ${tags[i]} -> message, retry after ?relayBackoff (not the normal fast backoff), then captions`,
      msgs[i] && back[i] && cs.length === 2 && gap >= 1300 && gap < 4000 && err === "", `gap=${gap} ms err=${err}`);
  }
  await Promise.all(pages.map(async (p) => { await p.click("#stopBtn"); await p.context().close(); }));
}

// ---- (i) 1011 -> reconnect with the normal backoff; a socket that never opens -> "连不上知音服务器", keeps trying
{
  const page = await newPage();
  await page.goto(codeUrl());
  await page.fill("#code", ZCODE("1011"));
  await page.click("#startBtn");
  const back = await until(page, () => window.__lcl.lines().some((l) => l.src === "After 1011."), null, 8000);
  const cs = relayConns("1011"), gap = cs[1] ? cs[1].openedAt - cs[0].closedAt : -1;
  check("(i) 1011 from the server -> reconnects at once", back && cs.length === 2 && gap < 2500, `gap=${gap} ms`);
  await page.click("#stopBtn");
  await page.context().close();
}
{
  const page = await newPage();
  await page.goto(codeUrl());
  await page.fill("#code", ZCODE("0503"));
  await page.click("#startBtn");
  const msg = await until(page, () => /连不上知音服务器/.test(document.getElementById("err").textContent), null, 6000);
  await sleep(3500);
  check("(i) socket never opens -> 连不上知音服务器, still retrying", msg && zy.attempts[ZCANON("0503")] >= 2 && (await page.evaluate(() => window.__lcl.ui().running)),
    `${await page.textContent("#err")} attempts=${zy.attempts[ZCANON("0503")]}`);
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- (k) own-key mode is unchanged on a page that also offers 授权码 mode
{
  const page = await newPage();
  await page.goto(codeUrl(`&dg=${encodeURIComponent(DG)}`));
  await page.check('input[name="mode"][value="key"]');
  const [codePane, keyPane] = await shownIds(page, ["codePane", "keyPane"]);
  const relay0 = zy.conns.length + zy.refused.length;
  await page.fill("#key", "ownkey");
  await page.click("#startBtn");
  const ok = await until(page, () => window.__lcl.lines().some((l) => l.src === "Own key still works."), null, 8000);
  const c = conns.find((x) => x.key === "ownkey");
  check("(k) own key with a server present: straight to Deepgram with ['token', key] and the Deepgram params",
    !codePane && keyPane && ok && c?.protocol === "token" && c.url.searchParams.get("model") === "nova-3" && c.url.searchParams.get("mip_opt_out") === "true" && zy.conns.length + zy.refused.length === relay0);
  await sleep(2000);
  await page.click("#stopBtn");
  const st = await page.evaluate(() => ({ usage: +localStorage.getItem("lcl.usageMs"), mode: localStorage.getItem("lcl.mode"), text: document.getElementById("usage").textContent }));
  check("(k) own key still counts this browser's usage estimate", st.usage >= 1000 && /累计用了/.test(st.text) && st.mode === "key", JSON.stringify(st));
  await page.reload();
  const kept = await page.evaluate(() => document.querySelector('input[name="mode"]:checked')?.value);
  await page.evaluate(() => localStorage.removeItem("lcl.mode"));
  await page.reload();
  const byKey = await page.evaluate(() => document.querySelector('input[name="mode"]:checked')?.value);
  check("(k) chosen mode remembered; with a stored key and no choice yet the default is the key", kept === "key" && byKey === "key", `${kept} ${byKey}`);
  await page.context().close();
}

// ---- unknown code, malformed code, server unreachable
{
  const page = await newPage();
  await page.goto(codeUrl());
  await page.fill("#code", ZCODE("0404"));
  check("/api/me 401 -> 授权码无效", await until(page, () => /^授权码无效/.test(document.getElementById("codeInfo").textContent), null, 5000), await page.textContent("#codeInfo"));
  await page.fill("#code", "1234-5678");
  const n0 = zy.conns.length + zy.refused.length;
  await page.click("#startBtn");
  check("malformed code -> 授权码格式不对, nothing sent", /授权码格式不对/.test(await page.textContent("#err")) && zy.conns.length + zy.refused.length === n0 && !(await page.evaluate(() => window.__lcl.ui().running)));
  await page.context().close();
}
{
  const dead = createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadUrl = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((r) => dead.close(r));
  const page = await newPage();
  await page.goto(codeUrl(`&dg=${encodeURIComponent(DG)}`, deadUrl));
  const note = await until(page, () => document.getElementById("codeInfo").textContent === "授权码服务暂时连不上", null, 8000);
  await page.click("#regBtn");
  const dlgMsg = await until(page, () => document.getElementById("regDlg").open && /连不上授权码服务/.test(document.getElementById("regMsg").textContent), null, 8000);
  await page.click("#regMsgClose");
  await page.check('input[name="mode"][value="key"]');
  await page.fill("#key", "goodkey");
  await page.click("#startBtn");
  const own = await until(page, () => document.getElementById("status").textContent === "正在收听", null, 8000);
  check("server unreachable: 授权码 mode stays with a notice, the dialog says so, own key still works", note && dlgMsg && (await page.isVisible("#modeBox")) && own);
  await page.click("#stopBtn");
  await page.context().close();
}

hung.forEach((h) => h.sock.destroy());
check("no uncaught page errors", errors.length === 0, errors.join(" | "));
await browser.close();
http.close();
zhttp.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `LITE E2E FAIL (${failed}/${results.length})` : `LITE E2E PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
